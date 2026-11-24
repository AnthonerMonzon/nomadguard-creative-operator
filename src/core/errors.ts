/**
 * One error type for the whole pipeline. Every failure is classified once, at the
 * boundary where it happens, so the orchestrator only has to ask two questions:
 * "is it worth retrying?" and "what do I tell the operator?".
 */
export type ErrorCode =
  | 'RATE_LIMITED' // 429 / quota: retry with backoff
  | 'TRANSIENT' // 5xx, network blips: retry with backoff
  | 'TIMEOUT' // we stopped waiting; the remote job may still finish (resumable)
  | 'CONTENT_FILTERED' // provider safety filter; stochastic, a new seed may pass
  | 'INVALID_REQUEST' // our request is wrong; retrying the same thing is pointless
  | 'AUTH' // credentials / project setup
  | 'INVALID_OUTPUT' // model returned something we could not use
  | 'MEDIA' // ffmpeg / ffprobe failure
  | 'UNKNOWN';

const RETRYABLE: Record<ErrorCode, boolean> = {
  RATE_LIMITED: true,
  TRANSIENT: true,
  TIMEOUT: true,
  CONTENT_FILTERED: true,
  INVALID_REQUEST: false,
  AUTH: false,
  INVALID_OUTPUT: true,
  MEDIA: false,
  UNKNOWN: false,
};

export class PipelineError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, opts: { retryable?: boolean; details?: unknown; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = 'PipelineError';
    this.code = code;
    this.retryable = opts.retryable ?? RETRYABLE[code];
    this.details = opts.details;
  }

  toJSON() {
    return { code: this.code, message: this.message, retryable: this.retryable, details: this.details };
  }
}

/** Map anything thrown by an SDK / fetch / child process onto a PipelineError. */
export function classifyError(err: unknown): PipelineError {
  if (err instanceof PipelineError) return err;
  const e = err as { status?: number; code?: number | string; message?: string } | undefined;
  const message = e?.message ?? String(err);
  const status = typeof e?.status === 'number' ? e.status : typeof e?.code === 'number' ? e.code : undefined;
  const text = message.toLowerCase();

  if (status === 429 || text.includes('resource_exhausted') || text.includes('quota') || text.includes('rate limit'))
    return new PipelineError('RATE_LIMITED', message, { cause: err });
  if (status === 401 || status === 403 || text.includes('permission_denied') || text.includes('unauthenticated') || text.includes('could not load the default credentials'))
    return new PipelineError('AUTH', message, { cause: err });
  if (status === 400 || status === 404 || text.includes('invalid_argument'))
    return new PipelineError('INVALID_REQUEST', message, { cause: err });
  if ((status !== undefined && status >= 500) || /econnreset|etimedout|enotfound|socket hang up|fetch failed|unavailable|deadline/.test(text))
    return new PipelineError('TRANSIENT', message, { cause: err });
  return new PipelineError('UNKNOWN', message, { cause: err });
}
