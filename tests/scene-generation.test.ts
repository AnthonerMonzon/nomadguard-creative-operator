import { writeFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import { PipelineError } from '../src/core/errors.js';
import { silentLogger } from '../src/core/log.js';
import type { Job } from '../src/jobs/job.js';
import { JobStore } from '../src/jobs/store.js';
import { generateScenes } from '../src/pipeline/generateScenes.js';
import type { GenerationStatus, VideoProvider, VideoRequest } from '../src/providers/VideoProvider.js';
import { brief, selection, storyboard, strategy, tmpDir } from './helpers.js';

type Outcome = 'ok' | 'filtered' | 'invalid' | 'never';
/** Provider whose behaviour is scripted per seed (seed = sceneId * 1000 + attempt). */
class ScriptedProvider implements VideoProvider {
  readonly name = 'scripted';
  readonly capabilities = { durations: [4, 6, 8], aspectRatios: ['9:16'], generatesAudio: true };
  submitted: number[] = [];
  private submitFailures = new Map<number, number>();
  private polls = new Map<string, number>();

  constructor(private script: Record<number, { outcome?: Outcome; submitErrors?: number; pollsUntilDone?: number }> = {}) {}

  async generate(req: VideoRequest) {
    const seed = req.seed!;
    const s = this.script[seed] ?? {};
    const failed = this.submitFailures.get(seed) ?? 0;
    if (failed < (s.submitErrors ?? 0)) {
      this.submitFailures.set(seed, failed + 1);
      throw Object.assign(new Error('Resource exhausted'), { status: 429 });
    }
    this.submitted.push(seed);
    return { jobRef: `ref-${seed}` };
  }
  async getStatus(ref: string): Promise<GenerationStatus> {
    const seed = Number(ref.slice(4));
    const s = this.script[seed] ?? {};
    const n = (this.polls.get(ref) ?? 0) + 1;
    this.polls.set(ref, n);
    if (s.outcome === 'never' || n < (s.pollsUntilDone ?? 1)) return { state: 'running' };
    if (s.outcome === 'filtered') return { state: 'failed', error: new PipelineError('CONTENT_FILTERED', 'filtered') };
    if (s.outcome === 'invalid') return { state: 'failed', error: new PipelineError('INVALID_REQUEST', 'unsupported resolution') };
    return { state: 'succeeded' };
  }
  async getResult(_ref: string, dest: string) {
    await writeFile(dest, 'fake-mp4');
    return { path: dest };
  }
}

/**
 * Risk: video generation is slow, paid and flaky. Mistakes here either crash the run, lose finished clips,
 * or (worst) silently pay twice for the same render.
 */
describe('scene generation lifecycle', () => {
  let store: JobStore;
  let job: Job;
  const opts = { maxAttempts: 3, concurrency: 3, pollIntervalMs: 1000, timeoutMs: 10_000 };
  const run = (provider: VideoProvider, extra: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) =>
    generateScenes({ job, store, provider, opts, log: silentLogger, verifyClip: async () => {}, sleep: extra.sleep ?? (async () => {}), now: extra.now });

  beforeEach(async () => {
    store = new JobStore(await tmpDir());
    job = await store.create(brief, { provider: 'scripted', llm: 'mock', planOnly: false });
    Object.assign(job, { strategy: strategy(), selection: selection(), storyboard: storyboard(), status: 'GENERATING' });
    job.scenes = [1, 2, 3].map((sceneId) => ({ sceneId, status: 'PENDING' as const, attempts: 0 }));
  });

  it('retries rate-limited submits and regenerates filtered clips with a new seed', async () => {
    const provider = new ScriptedProvider({ 1001: { submitErrors: 2 }, 2001: { outcome: 'filtered' }, 3001: { pollsUntilDone: 4 } });
    await run(provider);

    expect(job.scenes.map((s) => s.status)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);
    expect(job.scenes.map((s) => s.attempts)).toEqual([1, 2, 1]); // 429s don't burn attempts; filter does
    expect(provider.submitted.sort()).toEqual([1001, 2001, 2002, 3001]);
    expect(job.scenes[1]!.clip).toBe('clips/scene-2-a2.mp4');
  });

  it('on resume, re-polls an in-flight render instead of paying for a new one', async () => {
    job.scenes[0] = { sceneId: 1, status: 'SUBMITTED', jobRef: 'ref-1001', attempts: 1 }; // persisted before a crash
    const provider = new ScriptedProvider();
    await run(provider);

    expect(provider.submitted).not.toContain(1001);
    expect(job.scenes[0]!.status).toBe('SUCCEEDED');
  });

  it('a non-retryable failure stops only that scene, keeps finished clips, and is persisted', async () => {
    const provider = new ScriptedProvider({ 2001: { outcome: 'invalid' } });
    const err = await run(provider).catch((e) => e);

    expect(err).toBeInstanceOf(PipelineError);
    expect(err.code).toBe('INVALID_REQUEST');
    expect(err.details).toEqual([expect.objectContaining({ sceneId: 2 })]);
    const saved = await store.load(job.id);
    expect(saved.scenes.map((s) => s.status)).toEqual(['SUCCEEDED', 'FAILED', 'SUCCEEDED']);
    expect(saved.scenes[1]!.attempts).toBe(1); // no money wasted retrying a request that can't succeed
  });

  it('times out without losing the jobRef, so the paid render can still be collected later', async () => {
    let clock = 0;
    const provider = new ScriptedProvider({ 1001: { outcome: 'never' } });
    const err = await run(provider, { now: () => clock, sleep: async (ms) => void (clock += ms) }).catch((e) => e);

    expect(err.code).toBe('TIMEOUT');
    const saved = await store.load(job.id);
    expect(saved.scenes[0]).toMatchObject({ status: 'SUBMITTED', jobRef: 'ref-1001' });
  });
});
