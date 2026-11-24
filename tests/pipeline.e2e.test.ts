import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PipelineError } from '../src/core/errors.js';
import { silentLogger } from '../src/core/log.js';
import { JobStore } from '../src/jobs/store.js';
import { MockLlm } from '../src/llm/MockLlm.js';
import { Pipeline } from '../src/pipeline/orchestrator.js';
import { veoPromptBuilder } from '../src/prompts/veoPromptBuilder.js';
import { MockProvider } from '../src/providers/MockProvider.js';
import type { VideoRequest } from '../src/providers/VideoProvider.js';
import { brief, testConfig, tmpDir } from './helpers.js';

/** Provider outage for one scene on the first run (e.g. bad model config), healthy afterwards. */
class CountingProvider extends MockProvider {
  calls: number[] = [];
  constructor(private failSeed?: number) {
    super({ latencyMs: 0 });
  }
  override async generate(req: VideoRequest) {
    this.calls.push(req.seed!);
    if (req.seed === this.failSeed) throw new PipelineError('INVALID_REQUEST', 'model not available in region');
    return super.generate(req);
  }
}

/**
 * Risk: the stages each work but the job as a whole doesn't: state transitions, checkpoints and real
 * ffmpeg assembly. Runs the whole pipeline offline, including a failure and a resume.
 */
describe('pipeline end to end (mock LLM + mock video)', () => {
  it('fails with a useful error, then resumes to a valid 9:16 ad without re-rendering finished scenes', async () => {
    const config = testConfig(await tmpDir());
    const store = new JobStore(config.runsDir);
    const llm = new MockLlm();
    const job = await store.create(brief, { provider: 'mock', llm: 'mock', planOnly: false });

    const flaky = new CountingProvider(3001);
    const failed = await new Pipeline({ store, llm, provider: flaky, promptBuilder: veoPromptBuilder, config, log: silentLogger }).run(job.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.error).toMatchObject({ stage: 'GENERATING', code: 'INVALID_REQUEST' });
    expect(failed.error!.message).toContain('model not available in region');
    expect(failed.scenes.map((s) => s.status)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'FAILED']);

    const healthy = new CountingProvider();
    const done = await new Pipeline({ store, llm, provider: healthy, promptBuilder: veoPromptBuilder, config, log: silentLogger }).run(job.id);

    expect(done.status).toBe('FINALIZED');
    expect(healthy.calls).toEqual([3001]); // scenes 1 and 2 were reused, not paid for again
    expect(done.qa!.technical).toMatchObject({ valid: true, resolution: '1080x1920', aspect_ratio: '9:16' });
    expect(done.qa!.technical.duration).toBeCloseTo(14.5, 1);
    expect(done.history.map((h) => h.status)).toEqual(['CREATED', 'PLANNING', 'GENERATING', 'FAILED', 'GENERATING', 'ASSEMBLING', 'EVALUATING', 'FINALIZED']);
    expect(existsSync(path.join(store.dir(job.id), 'final.mp4'))).toBe(true);
    expect(existsSync(path.join(store.dir(job.id), 'report.md'))).toBe(true);
  }, 120_000);
});
