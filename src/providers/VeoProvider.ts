import { writeFile } from 'node:fs/promises';
import { GenerateVideosOperation, GoogleGenAI } from '@google/genai';
import type { AppConfig } from '../core/config.js';
import { classifyError, PipelineError } from '../core/errors.js';
import type { GenerationStatus, VideoCapabilities, VideoProvider, VideoRequest } from './VideoProvider.js';

/**
 * Google Veo on Vertex AI (paid from Cloud credits). Auth via Application Default Credentials.
 * The Vertex operation name is the jobRef: it is all we need to resume polling after a restart.
 */
export class VeoProvider implements VideoProvider {
  readonly name: string;
  readonly capabilities: VideoCapabilities = { durations: [4, 6, 8], aspectRatios: ['9:16', '16:9'], generatesAudio: true };
  private readonly ai: GoogleGenAI;

  constructor(private readonly cfg: AppConfig['video']) {
    if (!cfg.project) throw new PipelineError('AUTH', 'GOOGLE_CLOUD_PROJECT is required for the Veo provider (see README > Setup).');
    this.ai = new GoogleGenAI({ vertexai: true, project: cfg.project, location: cfg.location });
    this.name = `veo:${cfg.model}`;
  }

  async generate(req: VideoRequest): Promise<{ jobRef: string }> {
    const op = await this.ai.models.generateVideos({
      model: this.cfg.model,
      prompt: req.prompt,
      config: {
        numberOfVideos: 1,
        aspectRatio: req.aspectRatio,
        durationSeconds: req.durationSeconds,
        resolution: this.cfg.resolution,
        generateAudio: this.cfg.generateAudio,
        negativePrompt: req.negativePrompt,
        personGeneration: 'allow_adult',
        seed: req.seed,
      },
    });
    if (!op.name) throw new PipelineError('TRANSIENT', 'Veo did not return an operation name');
    return { jobRef: op.name };
  }

  private async fetchOperation(jobRef: string): Promise<GenerateVideosOperation> {
    const handle = new GenerateVideosOperation();
    handle.name = jobRef;
    return this.ai.operations.getVideosOperation({ operation: handle });
  }

  async getStatus(jobRef: string): Promise<GenerationStatus> {
    const op = await this.fetchOperation(jobRef);
    if (!op.done) return { state: 'running' };
    if (op.error) {
      const err = classifyError({ message: `Veo operation failed: ${JSON.stringify(op.error)}`, code: op.error.code });
      return { state: 'failed', error: err };
    }
    const res = op.response;
    if (!res?.generatedVideos?.length) {
      if (res?.raiMediaFilteredCount) {
        return {
          state: 'failed',
          error: new PipelineError('CONTENT_FILTERED', `Veo safety filter removed the video: ${(res.raiMediaFilteredReasons ?? []).join('; ')}`),
        };
      }
      return { state: 'failed', error: new PipelineError('INVALID_OUTPUT', 'Veo finished without a video') };
    }
    return { state: 'succeeded' };
  }

  async getResult(jobRef: string, destPath: string): Promise<{ path: string }> {
    const op = await this.fetchOperation(jobRef);
    const video = op.response?.generatedVideos?.[0]?.video;
    if (video?.videoBytes) {
      await writeFile(destPath, Buffer.from(video.videoBytes, 'base64'));
      return { path: destPath };
    }
    if (video?.uri?.startsWith('https://')) {
      const r = await fetch(video.uri);
      if (!r.ok) throw classifyError({ status: r.status, message: `download failed: HTTP ${r.status}` });
      await writeFile(destPath, Buffer.from(await r.arrayBuffer()));
      return { path: destPath };
    }
    throw new PipelineError('INVALID_OUTPUT', `Veo result has no inline bytes or downloadable URI (uri=${video?.uri ?? 'none'})`, { retryable: false });
  }
}
