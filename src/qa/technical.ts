import { existsSync, statSync } from 'node:fs';
import type { TechnicalReport } from '../domain/schemas.js';
import { decodeCheck, probe, type DecodeResult, type ProbeData } from '../media/ffmpeg.js';

export interface TechnicalSpec {
  minSeconds: number;
  maxSeconds: number;
  aspect: [number, number]; // [9, 16]
  minWidth: number;
  minHeight: number;
  requireAudio: boolean;
}

export const SOCIAL_SPEC: TechnicalSpec = { minSeconds: 10, maxSeconds: 15, aspect: [9, 16], minWidth: 1080, minHeight: 1920, requireAudio: true };

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

function parseFps(rate?: string): number | null {
  if (!rate) return null;
  const [n, d] = rate.split('/').map(Number);
  return n && d ? Math.round((n / d) * 100) / 100 : null;
}

/** Pure decision logic over probe results, kept separate from I/O so it is easy to test. */
export function evaluateTechnical(
  data: ProbeData | null,
  decode: DecodeResult,
  spec: TechnicalSpec,
  exists = true,
): TechnicalReport {
  const video = data?.streams?.find((s) => s.codec_type === 'video');
  const audio = data?.streams?.find((s) => s.codec_type === 'audio');
  const duration = data?.format?.duration ? Number(data.format.duration) : video?.duration ? Number(video.duration) : null;
  const w = video?.width ?? null;
  const h = video?.height ?? null;
  const g = w && h ? gcd(w, h) : 1;
  const aspectRatio = w && h ? `${w / g}:${h / g}` : null;
  const ratioOk = !!(w && h && Math.abs(w / h - spec.aspect[0] / spec.aspect[1]) < 0.01);
  const blackTotal = decode.black.reduce((s, b) => s + (b.end - b.start), 0);

  const checks = [
    { name: 'exists', pass: exists, detail: exists ? 'file present' : 'file missing' },
    { name: 'video_stream', pass: !!video, detail: video ? `${video.codec_name}` : 'no video stream' },
    { name: 'playable', pass: !!video && decode.playable, detail: decode.playable ? 'decoded end to end' : `decode failed: ${decode.error ?? 'unknown'}` },
    {
      name: 'duration',
      pass: duration !== null && duration >= spec.minSeconds - 0.05 && duration <= spec.maxSeconds + 0.05,
      detail: `${duration?.toFixed(2) ?? '?'}s (allowed ${spec.minSeconds}-${spec.maxSeconds}s)`,
    },
    { name: 'aspect_ratio', pass: ratioOk, detail: `${aspectRatio ?? '?'} (want ${spec.aspect.join(':')})` },
    {
      name: 'resolution',
      pass: !!(w && h && w >= spec.minWidth && h >= spec.minHeight),
      detail: `${w ?? '?'}x${h ?? '?'} (min ${spec.minWidth}x${spec.minHeight})`,
    },
    { name: 'audio', pass: !spec.requireAudio || !!audio, detail: audio ? `${audio.codec_name}` : 'no audio stream' },
    { name: 'black_frames', pass: blackTotal < 1.0, detail: `${blackTotal.toFixed(2)}s of black detected` },
    {
      // A 9:16 file can still carry a letterboxed picture; on a phone that reads as a broken ad, not a style.
      name: 'letterbox',
      pass: (decode.letterboxSeconds ?? 0) < 0.5,
      detail: decode.letterboxSeconds === undefined ? 'not measured' : `${decode.letterboxSeconds.toFixed(2)}s with baked-in black bars`,
    },
  ];

  return {
    exists,
    playable: !!video && decode.playable,
    duration,
    resolution: w && h ? `${w}x${h}` : null,
    aspect_ratio: aspectRatio,
    fps: parseFps(video?.avg_frame_rate),
    has_audio: !!audio,
    black_segments: decode.black,
    checks,
    valid: checks.every((c) => c.pass),
  };
}

export async function runTechnicalQa(file: string, spec: TechnicalSpec = SOCIAL_SPEC): Promise<TechnicalReport> {
  const exists = existsSync(file) && statSync(file).size > 0;
  if (!exists) return evaluateTechnical(null, { playable: false, black: [], error: 'missing' }, spec, false);
  const [data, decode] = await Promise.all([probe(file), decodeCheck(file)]);
  return evaluateTechnical(data, decode, spec, true);
}
