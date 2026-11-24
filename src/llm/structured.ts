import { z } from 'zod';
import { PipelineError } from '../core/errors.js';
import { withRetry, type Sleep } from '../core/retry.js';
import type { LlmClient, LlmRequest } from './LlmClient.js';

export interface StructuredRequest<T> extends LlmRequest {
  schema: z.ZodType<T>;
  /** Business rules the schema can't express (e.g. total duration). Return a list of problems; empty = ok. */
  validate?: (value: T) => string[];
  /** How many times the model may try to produce valid output (initial + repairs). */
  maxAttempts?: number;
  sleep?: Sleep;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  return JSON.parse(trimmed);
}

/**
 * Ask for JSON, then trust nothing: parse, validate against the schema, apply business rules.
 * On failure the model gets its own output plus the exact problems back ("repair" turn).
 * Transport errors (429/5xx) are retried separately with backoff and don't consume repair attempts.
 */
export async function generateStructured<T>(llm: LlmClient, req: StructuredRequest<T>): Promise<T> {
  const maxAttempts = req.maxAttempts ?? 3;
  let prompt = req.prompt;
  let problems: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const raw = await withRetry(() => llm.generateJson({ ...req, prompt }), { attempts: 4, sleep: req.sleep });

    problems = [];
    let value: T | undefined;
    try {
      const parsed = req.schema.safeParse(extractJson(raw));
      if (parsed.success) value = parsed.data;
      else problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    } catch (e) {
      problems = [`Response is not valid JSON: ${(e as Error).message}`];
    }
    if (value !== undefined) {
      problems = req.validate?.(value) ?? [];
      if (problems.length === 0) return value;
    }

    prompt =
      `${req.prompt}\n\n---\nYour previous response was rejected by validation:\n` +
      problems.map((p) => `- ${p}`).join('\n') +
      `\n\nPrevious response:\n${raw.slice(0, 6000)}\n\nReturn the corrected, complete JSON only.`;
  }

  throw new PipelineError('INVALID_OUTPUT', `"${req.label}" output still invalid after ${maxAttempts} attempts: ${problems.join('; ')}`, {
    retryable: false,
    details: { label: req.label, problems },
  });
}
