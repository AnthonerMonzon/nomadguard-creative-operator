import { copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../core/config.js';
import { classifyError, PipelineError } from '../core/errors.js';
import type { Logger } from '../core/log.js';
import type { Sleep } from '../core/retry.js';
import { transition, type Job, type JobStatus } from '../jobs/job.js';
import type { JobStore } from '../jobs/store.js';
import type { LlmClient } from '../llm/LlmClient.js';
import { assemble } from '../media/assemble.js';
import type { PromptBuilder, VideoProvider } from '../providers/VideoProvider.js';
import { runCreativeQa } from '../qa/creative.js';
import { runTechnicalQa, SOCIAL_SPEC } from '../qa/technical.js';
import { generateScenes, type SceneGenDeps } from './generateScenes.js';
import { generateStoryboard, generateStrategy, selectAngle } from './planning.js';
import { renderReport } from './report.js';

export interface PipelineDeps {
  store: JobStore;
  llm: LlmClient;
  provider: VideoProvider;
  promptBuilder: PromptBuilder;
  config: AppConfig;
  log: Logger;
  sleep?: Sleep;
  verifyClip?: SceneGenDeps['verifyClip'];
}

const STAGES = ['PLANNING', 'GENERATING', 'ASSEMBLING', 'EVALUATING'] as const;
type Stage = (typeof STAGES)[number];

/**
 * Brief -> Strategy -> Selection -> Storyboard -> Prompts -> Scenes -> Assembly -> QA -> Final.
 * `run` is idempotent: each stage checkpoints into job.json, so the same call starts a new job,
 * continues a crashed one, or retries a failed one from the stage that failed.
 */
export class Pipeline {
  constructor(private readonly d: PipelineDeps) {}

  private startStage(job: Job): Stage {
    if (job.status === 'CREATED') return 'PLANNING';
    if (job.status === 'PLANNED') return 'GENERATING';
    if (job.status === 'FAILED') return (job.error?.stage as Stage) ?? 'PLANNING';
    if ((STAGES as readonly string[]).includes(job.status)) return job.status as Stage; // crashed mid-stage
    throw new PipelineError('INVALID_REQUEST', `job ${job.id} is ${job.status}; nothing to run`);
  }

  async run(jobId: string, opts: { planOnly?: boolean } = {}): Promise<Job> {
    const { store, log } = this.d;
    const job = await store.load(jobId);
    if (job.status === 'FINALIZED') return job;

    const wasFailed = job.status === 'FAILED';
    const start = this.startStage(job);
    let stage: Stage = start;
    if (wasFailed) log.info(`retrying job ${job.id} from ${start} (previous error: ${job.error?.code} ${job.error?.message})`);

    try {
      for (stage of STAGES.slice(STAGES.indexOf(start))) {
        if (job.status !== stage) transition(job, stage);
        job.error = undefined;
        await store.save(job);
        log.info(`[${job.id}] ${stage}`);

        if (stage === 'PLANNING') {
          await this.plan(job);
          if (opts.planOnly) {
            transition(job, 'PLANNED', 'awaiting approval: review storyboard.json, then `resume`');
            await store.save(job);
            return job;
          }
        } else if (stage === 'GENERATING') {
          if (wasFailed && start === 'GENERATING') {
            // An explicit resume grants failed scenes a fresh attempt budget; finished clips are kept.
            for (const s of job.scenes) if (s.status === 'FAILED') s.attempts = 0;
          }
          await generateScenes({
            job,
            store,
            provider: this.d.provider,
            opts: this.d.config.video,
            log,
            sleep: this.d.sleep,
            verifyClip: this.d.verifyClip,
          });
        } else if (stage === 'ASSEMBLING') {
          await this.assemble(job);
        } else if (stage === 'EVALUATING') {
          await this.evaluate(job);
        }
      }
      await this.finalize(job);
      return job;
    } catch (raw) {
      const err = classifyError(raw);
      job.error = { ...err.toJSON(), stage: stage as JobStatus };
      transition(job, 'FAILED', `${stage}: ${err.code}`);
      await store.save(job);
      log.error(`[${job.id}] failed during ${stage}: ${err.code} ${err.message}`);
      log.error(`fix the cause, then run: npm run nomad -- resume ${job.id}`);
      return job;
    }
  }

  private async plan(job: Job): Promise<void> {
    const { llm, store, log, provider, promptBuilder } = this.d;
    const dir = store.dir(job.id);
    if (!job.strategy) {
      job.strategy = await generateStrategy(llm, job.brief);
      await store.save(job);
      log.info(`  ${job.strategy.angles.length} angles: ${job.strategy.angles.map((a) => a.name).join(' | ')}`);
    }
    if (!job.selection) {
      const sel = await selectAngle(llm, job.brief, job.strategy);
      const override = job.options.angleOverride;
      if (override !== undefined && override !== sel.selected_index && override < job.strategy.angles.length) {
        sel.why_selected = `Operator override (model preferred #${sel.selected_index}: ${sel.why_selected})`;
        sel.selected_index = override;
      }
      job.selection = sel;
      await store.save(job);
      log.info(`  selected: ${job.strategy.angles[sel.selected_index]!.name}`);
    }
    if (!job.storyboard) {
      const sb = await generateStoryboard(llm, job.brief, job.strategy, job.selection, provider.capabilities);
      for (const scene of sb.scenes) {
        const { prompt, negativePrompt } = promptBuilder.build(scene, sb);
        scene.video_prompt = prompt;
        scene.negative_prompt = negativePrompt;
      }
      job.storyboard = sb;
      job.scenes = sb.scenes.map((s) => ({ sceneId: s.id, status: 'PENDING', attempts: 0 }));
      await store.save(job);
      log.info(`  storyboard: ${sb.scenes.map((s) => `${s.duration}s`).join(' + ')} + ${sb.end_card.duration}s end card`);
    }
    await writeFile(path.join(dir, 'strategy.json'), JSON.stringify({ ...job.strategy, selection: job.selection }, null, 2));
    await writeFile(path.join(dir, 'storyboard.json'), JSON.stringify(job.storyboard, null, 2));
  }

  private async assemble(job: Job): Promise<void> {
    const sb = job.storyboard!;
    const clips = sb.scenes.map((s) => {
      const sj = job.scenes.find((x) => x.sceneId === s.id);
      if (!sj?.clip) throw new PipelineError('INVALID_REQUEST', `scene ${s.id} has no clip`, { retryable: false });
      return { file: sj.clip, duration: s.duration, text: s.on_screen_text };
    });
    await assemble({ workDir: this.d.store.dir(job.id), clips, storyboard: sb, brand: job.brief.brand, fontFile: this.d.config.fontFile, output: 'assembled.mp4' });
    job.assembled = 'assembled.mp4';
    await this.d.store.save(job);
  }

  private async evaluate(job: Job): Promise<void> {
    const { store, llm, config, log } = this.d;
    const dir = store.dir(job.id);
    const video = path.join(dir, job.assembled!);
    const spec = { ...SOCIAL_SPEC, minSeconds: job.brief.format.min_seconds, maxSeconds: job.brief.format.max_seconds };

    const technical = await runTechnicalQa(video, spec);
    job.qa = { technical };
    await store.save(job);
    const failedChecks = technical.checks.filter((c) => !c.pass);
    log.info(`  technical QA: ${technical.valid ? 'pass' : 'FAIL'} (${technical.duration?.toFixed(2)}s, ${technical.resolution}, ${technical.aspect_ratio})`);
    if (!technical.valid) {
      throw new PipelineError('INVALID_OUTPUT', `technical QA failed: ${failedChecks.map((c) => `${c.name} (${c.detail})`).join(', ')}`, {
        retryable: false,
        details: technical,
      });
    }

    // Creative QA is advisory: an evaluator outage must not throw away a valid, paid-for video.
    try {
      const { frames, ...creative } = await runCreativeQa({
        llm,
        video,
        workDir: dir,
        brief: job.brief,
        angle: job.strategy!.angles[job.selection!.selected_index]!,
        storyboard: job.storyboard!,
        minScore: config.qa.minScore,
        minAverage: config.qa.minAverage,
      });
      job.qa.creative = creative;
      log.info(`  creative QA: avg ${creative.average} -> ${creative.verdict}${creative.reasons.length ? ` (${creative.reasons.join('; ')})` : ''}`);
    } catch (e) {
      job.qa.creativeError = classifyError(e).message;
      log.warn(`  creative QA unavailable: ${job.qa.creativeError}`);
    }
    await store.save(job);
  }

  private async finalize(job: Job): Promise<void> {
    const dir = this.d.store.dir(job.id);
    await copyFile(path.join(dir, job.assembled!), path.join(dir, 'final.mp4'));
    job.final = { video: 'final.mp4', report: 'report.md', verdict: job.qa?.creative?.verdict ?? 'unevaluated' };
    transition(job, 'FINALIZED', job.final.verdict);
    await writeFile(path.join(dir, 'report.md'), renderReport(job, this.d.provider.name, this.d.llm.name));
    await this.d.store.save(job);
    this.d.log.info(`[${job.id}] FINALIZED (${job.final.verdict}) -> ${path.join(dir, 'final.mp4')}`);
  }
}
