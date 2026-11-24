import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, type LlmBackend, type VideoProviderName } from './core/config.js';
import { PipelineError } from './core/errors.js';
import { consoleLogger as log } from './core/log.js';
import { BriefSchema } from './domain/schemas.js';
import type { Job } from './jobs/job.js';
import { JobStore } from './jobs/store.js';
import { createPipeline } from './factory.js';

const USAGE = `NomadGuard creative operator

Usage:
  npm run nomad -- run    [--brief briefs/nomadguard.json] [--provider veo|mock] [--llm gemini|mock] [--angle N] [--plan-only]
  npm run nomad -- resume <jobId>        continue / retry a job (also approves a --plan-only job)
  npm run nomad -- status <jobId>        show job state, scenes and QA
  npm run nomad -- list                  list jobs

  --plan-only   stop after strategy + storyboard so a human can review before paying for video
  --angle N     override the model's choice of creative angle (0-based)
  --llm mock --provider mock   full offline dry run, no API keys needed`;

function printStatus(job: Job, store: JobStore) {
  console.log(`\nJob ${job.id}  ${job.status}${job.final ? `  (${job.final.verdict})` : ''}`);
  if (job.selection && job.strategy) console.log(`Angle:  ${job.strategy.angles[job.selection.selected_index]?.name}`);
  for (const s of job.scenes) {
    console.log(`  scene ${s.sceneId}: ${s.status.padEnd(9)} attempts=${s.attempts}${s.lastError ? `  last error: ${s.lastError.code} ${s.lastError.message}` : ''}`);
  }
  if (job.qa?.technical) console.log(`Technical QA: ${job.qa.technical.valid ? 'pass' : 'FAIL'}  ${job.qa.technical.duration?.toFixed(2)}s ${job.qa.technical.resolution} ${job.qa.technical.aspect_ratio}`);
  if (job.qa?.creative) console.log(`Creative QA:  avg ${job.qa.creative.average}  ${JSON.stringify(job.qa.creative.review.scores)}`);
  if (job.error) console.log(`Error (${job.error.stage}): ${job.error.code} ${job.error.message}`);
  console.log(`Files:  ${store.dir(job.id)}`);
  if (job.final) console.log(`Final:  ${path.join(store.dir(job.id), job.final.video)}\nReport: ${path.join(store.dir(job.id), job.final.report)}`);
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      brief: { type: 'string', default: 'briefs/nomadguard.json' },
      provider: { type: 'string' },
      llm: { type: 'string' },
      angle: { type: 'string' },
      'plan-only': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, arg] = positionals;
  if (!cmd || values.help) return console.log(USAGE);

  const llmOverride = values.llm === 'mock' ? 'mock' : values.llm === 'gemini' ? undefined : (values.llm as LlmBackend | undefined);
  const base = loadConfig({ llm: llmOverride, provider: values.provider as VideoProviderName | undefined });
  const store = new JobStore(base.runsDir);

  switch (cmd) {
    case 'run': {
      const brief = BriefSchema.parse(JSON.parse(await readFile(values.brief!, 'utf8')));
      const { pipeline } = createPipeline(base, log);
      const job = await store.create(brief, {
        provider: base.video.provider,
        llm: base.llm.backend,
        planOnly: values['plan-only']!,
        angleOverride: values.angle !== undefined ? Number(values.angle) : undefined,
      });
      log.info(`created job ${job.id} (video: ${base.video.provider}, llm: ${base.llm.backend})`);
      const result = await pipeline.run(job.id, { planOnly: values['plan-only'] });
      printStatus(result, store);
      if (result.status === 'PLANNED') console.log(`\nReview storyboard.json, then: npm run nomad -- resume ${job.id}`);
      process.exitCode = result.status === 'FAILED' ? 1 : 0;
      break;
    }
    case 'resume': {
      if (!arg) throw new PipelineError('INVALID_REQUEST', 'resume needs a job id');
      const existing = await store.load(arg);
      // Resume with the same providers the job was started with.
      const cfg = loadConfig({ llm: existing.options.llm as LlmBackend, provider: existing.options.provider as VideoProviderName });
      const { pipeline } = createPipeline(cfg, log);
      const result = await pipeline.run(arg);
      printStatus(result, store);
      process.exitCode = result.status === 'FAILED' ? 1 : 0;
      break;
    }
    case 'status': {
      if (!arg) throw new PipelineError('INVALID_REQUEST', 'status needs a job id');
      printStatus(await store.load(arg), store);
      break;
    }
    case 'list': {
      for (const j of await store.list()) {
        const angle = j.selection && j.strategy ? j.strategy.angles[j.selection.selected_index]?.name : '';
        console.log(`${j.id}  ${j.status.padEnd(10)} ${j.options.provider.padEnd(5)} ${angle ?? ''}`);
      }
      break;
    }
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  log.error(e instanceof PipelineError ? `${e.code}: ${e.message}` : (e as Error).stack ?? String(e));
  process.exitCode = 1;
});
