import { GoogleGenAI, type Part } from '@google/genai';
import type { AppConfig } from '../core/config.js';
import { PipelineError } from '../core/errors.js';
import type { LlmClient, LlmRequest } from './LlmClient.js';

const LLM_TIMEOUT_MS = 120_000;

/** Gemini via the free AI Studio API key, or via Vertex AI (ADC) when no key is configured. */
export class GeminiLlm implements LlmClient {
  readonly name: string;
  private readonly ai: GoogleGenAI;

  constructor(private readonly cfg: AppConfig['llm']) {
    // Without a per-request timeout an overloaded model can leave a call open indefinitely and stall the job;
    // a timeout surfaces as a TRANSIENT error, so withRetry backs off and tries again.
    const httpOptions = { timeout: LLM_TIMEOUT_MS };
    if (cfg.backend === 'gemini-api') {
      this.ai = new GoogleGenAI({ apiKey: cfg.apiKey, httpOptions });
    } else {
      if (!cfg.project) throw new PipelineError('AUTH', 'Set GEMINI_API_KEY, or GOOGLE_CLOUD_PROJECT to use Gemini via Vertex AI.');
      this.ai = new GoogleGenAI({ vertexai: true, project: cfg.project, location: cfg.location, httpOptions });
    }
    this.name = `gemini:${cfg.model} (${cfg.backend})`;
  }

  async generateJson(req: LlmRequest): Promise<string> {
    const parts: Part[] = [{ text: req.prompt }];
    for (const img of req.images ?? []) {
      if (img.caption) parts.push({ text: img.caption });
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
    }
    const res = await this.ai.models.generateContent({
      model: this.cfg.model,
      contents: [{ role: 'user', parts }],
      config: { systemInstruction: req.system, responseMimeType: 'application/json', temperature: req.temperature ?? 0.7 },
    });
    const text = res.text;
    if (!text) {
      const reason = res.candidates?.[0]?.finishReason ?? res.promptFeedback?.blockReason ?? 'empty response';
      throw new PipelineError('INVALID_OUTPUT', `LLM returned no text (${reason})`);
    }
    return text;
  }
}
