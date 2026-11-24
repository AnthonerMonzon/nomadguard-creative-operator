import { existsSync } from 'node:fs';
import path from 'node:path';

export type LlmBackend = 'gemini-api' | 'vertex' | 'mock';
export type VideoProviderName = 'veo' | 'mock';

export interface AppConfig {
  runsDir: string;
  llm: { backend: LlmBackend; model: string; apiKey?: string; project?: string; location: string };
  video: {
    provider: VideoProviderName;
    model: string;
    resolution: string;
    generateAudio: boolean;
    project?: string;
    location: string;
    maxAttempts: number; // generation attempts per scene (new seed each time)
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number; // per scene; after this the job fails but stays resumable
  };
  qa: { minScore: number; minAverage: number };
  fontFile?: string;
}

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

function defaultFont(): string | undefined {
  const candidates = [
    'C:/Windows/Fonts/segoeuib.ttf',
    'C:/Windows/Fonts/arialbd.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  ];
  return candidates.find((f) => existsSync(f));
}

export function loadConfig(overrides: { llm?: LlmBackend; provider?: VideoProviderName } = {}): AppConfig {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const env = process.env;
  const project = env.GOOGLE_CLOUD_PROJECT || undefined;
  const location = env.GOOGLE_CLOUD_LOCATION || 'us-central1';
  const llmBackend: LlmBackend = overrides.llm ?? (env.GEMINI_API_KEY ? 'gemini-api' : 'vertex');

  return {
    runsDir: path.resolve(env.RUNS_DIR || 'runs'),
    llm: { backend: llmBackend, model: env.LLM_MODEL || 'gemini-2.5-flash', apiKey: env.GEMINI_API_KEY || undefined, project, location },
    video: {
      provider: overrides.provider ?? ((env.VIDEO_PROVIDER as VideoProviderName) || 'veo'),
      model: env.VEO_MODEL || 'veo-3.0-generate-001',
      resolution: env.VEO_RESOLUTION || '1080p',
      generateAudio: (env.VEO_GENERATE_AUDIO ?? 'true') !== 'false',
      project,
      location,
      maxAttempts: num(env.VIDEO_MAX_ATTEMPTS, 3),
      concurrency: num(env.VIDEO_CONCURRENCY, 3),
      pollIntervalMs: num(env.VIDEO_POLL_INTERVAL_MS, 10_000),
      timeoutMs: num(env.VIDEO_TIMEOUT_MS, 15 * 60_000),
    },
    qa: { minScore: num(env.QA_MIN_SCORE, 6), minAverage: num(env.QA_MIN_AVERAGE, 7) },
    fontFile: env.FONT_FILE || defaultFont(),
  };
}
