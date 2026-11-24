export interface LlmImage {
  mimeType: string;
  base64: string;
  caption?: string; // e.g. "t=1.5s (scene 1)"
}

export interface LlmRequest {
  /** Stable name of the call ("strategy", "selection", ...). Used for logging and by the mock. */
  label: string;
  system: string;
  prompt: string;
  images?: LlmImage[];
  temperature?: number;
}

/** Minimal surface the pipeline needs from a language model: JSON text in, JSON text out. */
export interface LlmClient {
  readonly name: string;
  generateJson(req: LlmRequest): Promise<string>;
}
