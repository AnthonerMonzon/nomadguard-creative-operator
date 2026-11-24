import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../src/core/config.js';
import type { Brief, Selection, Storyboard, Strategy } from '../src/domain/schemas.js';
import { MOCK_RESPONSES } from '../src/llm/MockLlm.js';
import type { LlmClient, LlmRequest } from '../src/llm/LlmClient.js';
import { veoPromptBuilder } from '../src/prompts/veoPromptBuilder.js';

export const brief: Brief = {
  brand: 'NomadGuard',
  description: 'Travel protection for frequent travelers.',
  audience: 'Frequent travelers 25-40',
  problem: ['delays', 'stress', 'financial loss'],
  core_message: 'Travel with confidence knowing that you are protected when things go wrong.',
  brand_feel: ['modern', 'premium', 'trustworthy'],
  format: { min_seconds: 10, max_seconds: 15, aspect_ratio: '9:16', platforms: ['TikTok'] },
};

export const clone = <T>(x: T): T => structuredClone(x);
export const strategy = () => clone(MOCK_RESPONSES.strategy) as Strategy;
export const selection = () => clone(MOCK_RESPONSES.selection) as Selection;
export function storyboard(): Storyboard {
  const sb = clone(MOCK_RESPONSES.storyboard) as Storyboard;
  for (const s of sb.scenes) Object.assign(s, (({ prompt, negativePrompt }) => ({ video_prompt: prompt, negative_prompt: negativePrompt }))(veoPromptBuilder.build(s, sb)));
  return sb;
}

export const tmpDir = () => mkdtemp(path.join(os.tmpdir(), 'nomad-test-'));
export const noSleep = async () => {};

export function testConfig(runsDir: string): AppConfig {
  return {
    runsDir,
    llm: { backend: 'mock', model: 'mock', location: 'us-central1' },
    video: { provider: 'mock', model: 'mock', resolution: '720p', generateAudio: true, location: 'us-central1', maxAttempts: 3, concurrency: 3, pollIntervalMs: 5, timeoutMs: 60_000 },
    qa: { minScore: 6, minAverage: 7 },
  };
}

/** LLM that replays scripted responses (string = return it, Error = throw it) and records prompts. */
export class ScriptedLlm implements LlmClient {
  readonly name = 'scripted';
  prompts: string[] = [];
  constructor(private responses: (string | Error)[]) {}
  async generateJson(req: LlmRequest): Promise<string> {
    this.prompts.push(req.prompt);
    const next = this.responses.shift();
    if (next === undefined) throw new Error('ScriptedLlm ran out of responses');
    if (next instanceof Error) throw next;
    return next;
  }
}
