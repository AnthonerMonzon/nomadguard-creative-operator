import { PipelineError } from '../core/errors.js';
import { FFMPEG, run } from '../media/ffmpeg.js';
import type { GenerationStatus, VideoCapabilities, VideoProvider, VideoRequest } from './VideoProvider.js';

interface MockRef {
  d: number;
  seed: number;
  at: number; // submit time
  fail?: string; // error code to simulate at completion
}

export interface MockOptions {
  latencyMs?: number;
  /** Fraction of generations that fail with CONTENT_FILTERED (exercises retry paths end-to-end). */
  failRate?: number;
}

/**
 * Offline stand-in for a real provider: same async submit/poll/fetch lifecycle, renders a placeholder
 * clip with ffmpeg. State lives in the jobRef itself, so resume-after-restart works exactly like Veo.
 */
export class MockProvider implements VideoProvider {
  readonly name = 'mock';
  readonly capabilities: VideoCapabilities = { durations: [4, 6, 8], aspectRatios: ['9:16'], generatesAudio: true };

  constructor(private readonly opts: MockOptions = {}) {}

  async generate(req: VideoRequest): Promise<{ jobRef: string }> {
    const ref: MockRef = { d: req.durationSeconds, seed: req.seed ?? 0, at: Date.now() };
    if (this.opts.failRate && Math.random() < this.opts.failRate) ref.fail = 'CONTENT_FILTERED';
    return { jobRef: 'mock:' + Buffer.from(JSON.stringify(ref)).toString('base64url') };
  }

  private parse(jobRef: string): MockRef {
    if (!jobRef.startsWith('mock:')) throw new PipelineError('INVALID_REQUEST', `not a mock jobRef: ${jobRef}`);
    return JSON.parse(Buffer.from(jobRef.slice(5), 'base64url').toString()) as MockRef;
  }

  async getStatus(jobRef: string): Promise<GenerationStatus> {
    const ref = this.parse(jobRef);
    if (Date.now() - ref.at < (this.opts.latencyMs ?? 1500)) return { state: 'running' };
    if (ref.fail) return { state: 'failed', error: new PipelineError('CONTENT_FILTERED', 'mock: simulated safety-filter rejection') };
    return { state: 'succeeded' };
  }

  async getResult(jobRef: string, destPath: string): Promise<{ path: string }> {
    const ref = this.parse(jobRef);
    const hue = (ref.seed * 47) % 360;
    await run(FFMPEG, [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', `testsrc2=s=720x1280:r=24:d=${ref.d}`,
      '-f', 'lavfi', '-i', `sine=frequency=220:sample_rate=48000:d=${ref.d}`,
      '-vf', `hue=h=${hue}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', destPath,
    ]);
    return { path: destPath };
  }
}
