import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { classifyError, PipelineError } from '../core/errors.js';
import type { Logger } from '../core/log.js';
import { mapSettled, realSleep, withRetry, type Sleep } from '../core/retry.js';
import type { Storyboard } from '../domain/schemas.js';
import type { Job, SceneJob } from '../jobs/job.js';
import type { JobStore } from '../jobs/store.js';
import { probe } from '../media/ffmpeg.js';
import type { VideoProvider } from '../providers/VideoProvider.js';

export interface SceneGenOptions {
  maxAttempts: number;
  concurrency: number;
  pollIntervalMs: number;
  timeoutMs: number;
}

export interface SceneGenDeps {
  job: Job;
  store: JobStore;
  provider: VideoProvider;
  opts: SceneGenOptions;
  log: Logger;
  sleep?: Sleep;
  now?: () => number;
  /** Cheap sanity check on each downloaded clip before accepting it. */
  verifyClip?: (file: string, expectedSeconds: number) => Promise<void>;
}

export async function defaultVerifyClip(file: string, expectedSeconds: number): Promise<void> {
  const data = await probe(file);
  const v = data?.streams?.find((s) => s.codec_type === 'video');
  const d = Number(data?.format?.duration ?? 0);
  if (!v) throw new PipelineError('INVALID_OUTPUT', `clip ${path.basename(file)} has no playable video stream`);
  if (d < expectedSeconds - 0.6) throw new PipelineError('INVALID_OUTPUT', `clip ${path.basename(file)} is ${d.toFixed(1)}s, expected ~${expectedSeconds}s`);
}

/**
 * Render every storyboard scene, concurrently and independently.
 * - submit errors (429/5xx) -> backoff retries, no attempt consumed
 * - generation failed / filtered / bad clip -> new attempt with a new seed, up to maxAttempts
 * - non-retryable (bad request, auth) -> stop that scene immediately
 * - timeout -> stop waiting but KEEP the jobRef, so `resume` re-polls the same paid render
 * One scene failing never discards the others' finished clips.
 */
export async function generateScenes(deps: SceneGenDeps): Promise<void> {
  const { job, store, provider, opts, log } = deps;
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const verify = deps.verifyClip ?? defaultVerifyClip;
  const sb = job.storyboard as Storyboard;
  const workDir = store.dir(job.id);
  const save = () => store.save(job);

  async function runScene(sj: SceneJob): Promise<void> {
    const scene = sb.scenes.find((s) => s.id === sj.sceneId)!;
    const tag = `[scene ${sj.sceneId}]`;

    while (!(sj.status === 'SUCCEEDED' && sj.clip)) {
      if (!sj.jobRef) {
        if (sj.attempts >= opts.maxAttempts) {
          const last = sj.lastError;
          throw new PipelineError(last?.code ?? 'UNKNOWN', `${tag} gave up after ${sj.attempts} attempts: ${last?.message ?? 'unknown error'}`, {
            retryable: false,
          });
        }
        sj.attempts++;
        let jobRef: string;
        try {
          ({ jobRef } = await withRetry(
            () =>
              provider.generate({
                prompt: scene.video_prompt!,
                negativePrompt: scene.negative_prompt,
                durationSeconds: scene.duration,
                aspectRatio: '9:16',
                seed: sj.sceneId * 1000 + sj.attempts, // new attempt => new seed; reproducible across runs
              }),
            { attempts: 4, sleep, onRetry: (e, n, ms) => log.warn(`${tag} submit failed (${e.code}), retry ${n} in ${ms}ms`) },
          ));
        } catch (e) {
          // The submit itself failed (after backoff): record why on the scene, so `status` can explain it.
          const err = classifyError(e);
          Object.assign(sj, { status: 'FAILED', lastError: err.toJSON() });
          await save();
          throw new PipelineError(err.code, `${tag} submit failed: ${err.message}`, { retryable: false });
        }
        Object.assign(sj, { jobRef, status: 'SUBMITTED', submittedAt: new Date(now()).toISOString() });
        await save();
        log.info(`${tag} submitted to ${provider.name} (attempt ${sj.attempts}/${opts.maxAttempts})`);
      } else {
        log.info(`${tag} resuming poll of existing render`);
      }

      const started = now();
      let status = await withRetry(() => provider.getStatus(sj.jobRef!), { attempts: 5, sleep });
      while (status.state === 'running') {
        if (now() - started > opts.timeoutMs) {
          throw new PipelineError('TIMEOUT', `${tag} still rendering after ${Math.round(opts.timeoutMs / 1000)}s; run \`resume ${job.id}\` to keep waiting`, {
            details: { jobRef: sj.jobRef },
          });
        }
        await sleep(opts.pollIntervalMs);
        status = await withRetry(() => provider.getStatus(sj.jobRef!), { attempts: 5, sleep });
      }

      let failure: PipelineError | undefined = status.error;
      if (status.state === 'succeeded') {
        const rel = `clips/scene-${sj.sceneId}-a${sj.attempts}.mp4`;
        try {
          await mkdir(path.join(workDir, 'clips'), { recursive: true });
          await withRetry(() => provider.getResult(sj.jobRef!, path.join(workDir, rel)), { attempts: 3, sleep });
          await verify(path.join(workDir, rel), scene.duration);
          Object.assign(sj, { status: 'SUCCEEDED', clip: rel, completedAt: new Date(now()).toISOString(), lastError: undefined });
          await save();
          log.info(`${tag} done -> ${rel}`);
          return;
        } catch (e) {
          failure = classifyError(e);
        }
      }

      failure ??= new PipelineError('UNKNOWN', 'generation failed without error details');
      Object.assign(sj, { status: 'FAILED', jobRef: undefined, lastError: failure.toJSON() });
      await save();
      log.warn(`${tag} attempt ${sj.attempts} failed: ${failure.code} ${failure.message}`);
      if (!failure.retryable) throw new PipelineError(failure.code, `${tag} ${failure.message}`, { retryable: false });
    }
  }

  const results = await mapSettled(job.scenes, opts.concurrency, runScene);
  const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [{ sceneId: job.scenes[i]!.sceneId, err: classifyError(r.reason) }] : []));
  if (failed.length) {
    throw new PipelineError(failed[0]!.err.code, failed.map((f) => f.err.message).join(' | '), {
      details: failed.map((f) => ({ sceneId: f.sceneId, ...f.err.toJSON() })),
    });
  }
}
