import type { AppConfig } from './core/config.js';
import type { Logger } from './core/log.js';
import { JobStore } from './jobs/store.js';
import { GeminiLlm } from './llm/GeminiLlm.js';
import type { LlmClient } from './llm/LlmClient.js';
import { MockLlm } from './llm/MockLlm.js';
import { Pipeline } from './pipeline/orchestrator.js';
import { veoPromptBuilder } from './prompts/veoPromptBuilder.js';
import { MockProvider } from './providers/MockProvider.js';
import type { PromptBuilder, VideoProvider } from './providers/VideoProvider.js';
import { VeoProvider } from './providers/VeoProvider.js';

/** The only place that knows concrete implementations. Adding another provider = one more case here. */
export function createProvider(cfg: AppConfig): { provider: VideoProvider; promptBuilder: PromptBuilder } {
  switch (cfg.video.provider) {
    case 'veo':
      return { provider: new VeoProvider(cfg.video), promptBuilder: veoPromptBuilder };
    case 'mock':
      return { provider: new MockProvider({ failRate: Number(process.env.MOCK_FAIL_RATE ?? 0) }), promptBuilder: veoPromptBuilder };
  }
}

export function createLlm(cfg: AppConfig): LlmClient {
  return cfg.llm.backend === 'mock' ? new MockLlm() : new GeminiLlm(cfg.llm);
}

export function createPipeline(cfg: AppConfig, log: Logger) {
  const store = new JobStore(cfg.runsDir);
  const { provider, promptBuilder } = createProvider(cfg);
  const llm = createLlm(cfg);
  return { store, pipeline: new Pipeline({ store, llm, provider, promptBuilder, config: cfg, log }) };
}
