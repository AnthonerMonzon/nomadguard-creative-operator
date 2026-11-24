import { classifyError, PipelineError } from './errors.js';

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export interface RetryOptions {
  attempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: Sleep;
  onRetry?: (err: PipelineError, attempt: number, delayMs: number) => void;
}

/**
 * Retry only errors classified as retryable (rate limits, 5xx, network).
 * Exponential backoff with full jitter; rate limits start from a longer base delay.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const { attempts, baseDelayMs = 1000, maxDelayMs = 30_000, sleep = realSleep } = opts;
  let last: PipelineError | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (raw) {
      last = classifyError(raw);
      if (!last.retryable || attempt === attempts) throw last;
      const base = last.code === 'RATE_LIMITED' ? baseDelayMs * 5 : baseDelayMs;
      const delay = Math.round(Math.random() * Math.min(maxDelayMs, base * 2 ** (attempt - 1)));
      opts.onRetry?.(last, attempt, delay);
      await sleep(delay);
    }
  }
  throw last ?? new PipelineError('UNKNOWN', 'withRetry exhausted without an error');
}

/** Run async tasks with a concurrency cap; never rejects, returns settled results in input order. */
export async function mapSettled<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i]!, i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
