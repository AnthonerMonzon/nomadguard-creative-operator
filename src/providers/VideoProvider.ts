import type { PipelineError } from '../core/errors.js';
import type { Scene, Storyboard } from '../domain/schemas.js';

export interface VideoCapabilities {
  /** Clip lengths the model accepts; the storyboard is constrained to these. */
  durations: number[];
  aspectRatios: string[];
  generatesAudio: boolean;
}

export interface VideoRequest {
  prompt: string;
  negativePrompt?: string;
  durationSeconds: number;
  aspectRatio: string;
  seed?: number;
}

export type GenerationState = 'running' | 'succeeded' | 'failed';

export interface GenerationStatus {
  state: GenerationState;
  error?: PipelineError;
}

/**
 * Async video generation, modelled the way real providers work: submit -> poll -> fetch.
 * `jobRef` is an opaque, serialisable handle (e.g. a Vertex operation name). The pipeline persists it, so a
 * crashed or timed-out run can resume polling instead of paying for the same clip again.
 */
export interface VideoProvider {
  readonly name: string;
  readonly capabilities: VideoCapabilities;
  generate(req: VideoRequest): Promise<{ jobRef: string }>;
  getStatus(jobRef: string): Promise<GenerationStatus>;
  /** Download the finished clip to `destPath`. */
  getResult(jobRef: string, destPath: string): Promise<{ path: string }>;
}

/** Each model wants prompts phrased differently, so prompt building is paired with the provider. */
export interface PromptBuilder {
  build(scene: Scene, storyboard: Storyboard): { prompt: string; negativePrompt?: string };
}
