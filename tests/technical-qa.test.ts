import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assemble } from '../src/media/assemble.js';
import { detectContentArea, FFMPEG, isLetterboxed, run } from '../src/media/ffmpeg.js';
import { evaluateTechnical, runTechnicalQa, SOCIAL_SPEC } from '../src/qa/technical.js';
import { storyboard, tmpDir } from './helpers.js';

/** Risk: shipping a video that a platform rejects or crops (wrong ratio/length) or that doesn't play. */
describe('technical QA', () => {
  const okDecode = { playable: true, black: [] };
  const probeOf = (w: number, h: number, duration: number, audio = true) => ({
    format: { duration: String(duration) },
    streams: [{ codec_type: 'video', codec_name: 'h264', width: w, height: h, avg_frame_rate: '30/1' }, ...(audio ? [{ codec_type: 'audio', codec_name: 'aac' }] : [])],
  });
  const failed = (r: ReturnType<typeof evaluateTechnical>) => r.checks.filter((c) => !c.pass).map((c) => c.name);

  it('accepts a 12.8s 1080x1920 video with audio', () => {
    const r = evaluateTechnical(probeOf(1080, 1920, 12.8), okDecode, SOCIAL_SPEC);
    expect(r).toMatchObject({ valid: true, resolution: '1080x1920', aspect_ratio: '9:16', fps: 30 });
  });

  it('flags each problem specifically', () => {
    expect(failed(evaluateTechnical(probeOf(1920, 1080, 12), okDecode, SOCIAL_SPEC))).toEqual(['aspect_ratio', 'resolution']);
    expect(failed(evaluateTechnical(probeOf(1080, 1920, 8), okDecode, SOCIAL_SPEC))).toEqual(['duration']);
    expect(failed(evaluateTechnical(probeOf(720, 1280, 12), okDecode, SOCIAL_SPEC))).toEqual(['resolution']);
    expect(failed(evaluateTechnical(probeOf(1080, 1920, 12), { playable: true, black: [{ start: 3, end: 5 }] }, SOCIAL_SPEC))).toEqual(['black_frames']);
    expect(failed(evaluateTechnical(probeOf(1080, 1920, 12), { playable: false, black: [], error: 'moov atom not found' }, SOCIAL_SPEC))).toEqual(['playable']);
  });

  it('runs against real files: rejects a landscape clip, a corrupt file and a missing file', async () => {
    const dir = await tmpDir();
    const landscape = path.join(dir, 'landscape.mp4');
    await run(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=24:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', landscape]);
    const r = await runTechnicalQa(landscape);
    expect(r.valid).toBe(false);
    expect(r.aspect_ratio).toBe('16:9');
    expect(failed(r)).toEqual(expect.arrayContaining(['duration', 'aspect_ratio', 'audio']));

    const corrupt = path.join(dir, 'corrupt.mp4');
    await (await import('node:fs/promises')).writeFile(corrupt, 'definitely not a video');
    expect((await runTechnicalQa(corrupt)).playable).toBe(false);

    expect((await runTechnicalQa(path.join(dir, 'missing.mp4'))).exists).toBe(false);
  }, 30_000);
});

/**
 * Risk: the model returns a correctly sized 9:16 file with a letterboxed picture baked in (seen on a real
 * Veo 3.1 render). Dimensions-only checks pass it, and on a phone it looks broken. Uses real ffmpeg output.
 */
describe('baked-in letterbox', () => {
  const failed = (r: Awaited<ReturnType<typeof runTechnicalQa>>) => r.checks.filter((c) => !c.pass).map((c) => c.name);
  // 1080x1920 frame whose picture only fills a 1080x1596 band, like the real Veo clip.
  const letterboxed = (out: string, seconds: number) =>
    run(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=1080x1596:r=30:d=${seconds}`, '-f', 'lavfi', '-i', `sine=d=${seconds}`,
      '-vf', 'pad=1080:1920:0:162:black', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]);

  it('technical QA flags it, and assembly crops it back to full-bleed 9:16', async () => {
    const dir = await tmpDir();
    const boxed = path.join(dir, 'boxed.mp4');
    await letterboxed(boxed, 12);
    const r = await runTechnicalQa(boxed);
    expect(r.resolution).toBe('1080x1920'); // dimensions alone look fine...
    expect(failed(r)).toEqual(['letterbox']); // ...but the picture isn't

    await mkdir(path.join(dir, 'clips'));
    await letterboxed(path.join(dir, 'clips', 'scene-1.mp4'), 4);
    const out = await assemble({
      workDir: dir,
      clips: [{ file: 'clips/scene-1.mp4', duration: 4, text: '' }],
      storyboard: storyboard(),
      brand: 'NomadGuard',
      output: 'final.mp4',
    });
    const area = await detectContentArea(out, { maxSeconds: 4 });
    expect(area).not.toBeNull();
    expect(isLetterboxed(area!)).toBe(false);
  }, 60_000);
});
