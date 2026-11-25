import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { PipelineError } from '../core/errors.js';

const require = createRequire(import.meta.url);

/** Prefer an explicit env path, then the bundled static binaries, then PATH. */
export const FFMPEG: string = process.env.FFMPEG_PATH || (require('ffmpeg-static') as string | null) || 'ffmpeg';
export const FFPROBE: string = process.env.FFPROBE_PATH || (require('ffprobe-static') as { path: string }).path || 'ffprobe';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(bin: string, args: string[], opts: { cwd?: string; allowFail?: boolean } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => reject(new PipelineError('MEDIA', `failed to start ${bin}: ${e.message}`, { cause: e })));
    child.on('close', (code) => {
      const result = { code: code ?? -1, stdout, stderr };
      if (code !== 0 && !opts.allowFail) {
        reject(new PipelineError('MEDIA', `${bin.split(/[\\/]/).pop()} exited with ${code}: ${stderr.trim().split('\n').slice(-6).join(' | ')}`));
      } else resolve(result);
    });
  });
}

export interface ProbeData {
  format?: { duration?: string; format_name?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    duration?: string;
  }>;
}

/** Returns null if the file can't be parsed as media at all. */
export async function probe(file: string): Promise<ProbeData | null> {
  const r = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { allowFail: true });
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout) as ProbeData;
  } catch {
    return null;
  }
}

export interface DecodeResult {
  playable: boolean;
  black: { start: number; end: number }[];
  /** Longest continuous stretch (seconds) with symmetric black bars baked into the picture. */
  letterboxSeconds?: number;
  error?: string;
}

/**
 * Per-frame cropdetect lines -> longest run of letterboxed frames. Bars must be symmetric (top≈bottom or
 * left≈right) so a dark corner or a dark scene doesn't count; that is what a baked-in letterbox looks like.
 */
export function longestLetterboxRun(stderr: string, frameW: number, frameH: number, tolerance = 0.03): number {
  let runStart: number | null = null;
  let longest = 0;
  let lastT = 0;
  for (const line of stderr.split('\n')) {
    const crop = line.match(/crop=(\d+):(\d+):(\d+):(\d+)/);
    const time = line.match(/\bt:([\d.]+)/);
    if (!crop || !time) continue;
    const [w, h, x, y] = crop.slice(1, 5).map(Number) as [number, number, number, number];
    const t = Number(time[1]);
    lastT = t;
    const top = y, bottom = frameH - y - h, left = x, right = frameW - x - w;
    const bars =
      (h < frameH * (1 - tolerance) && Math.abs(top - bottom) <= frameH * 0.02) ||
      (w < frameW * (1 - tolerance) && Math.abs(left - right) <= frameW * 0.02);
    if (bars) runStart ??= t;
    else if (runStart !== null) {
      longest = Math.max(longest, t - runStart);
      runStart = null;
    }
  }
  if (runStart !== null) longest = Math.max(longest, lastT - runStart);
  return Math.round(longest * 100) / 100;
}

/** Fully decode the file (proves it is playable end to end); detect black segments and baked-in letterboxing in the same pass. */
export async function decodeCheck(file: string): Promise<DecodeResult> {
  const v = (await probe(file))?.streams?.find((s) => s.codec_type === 'video');
  const r = await run(
    FFMPEG,
    ['-hide_banner', '-nostats', '-i', file, '-vf', 'blackdetect=d=0.4:pix_th=0.10,cropdetect=limit=24:round=2:reset=1', '-an', '-f', 'null', '-'],
    { allowFail: true },
  );
  const black = [...r.stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)].map((m) => ({ start: Number(m[1]), end: Number(m[2]) }));
  const letterboxSeconds = v?.width && v.height ? longestLetterboxRun(r.stderr, v.width, v.height) : undefined;
  return { playable: r.code === 0, black, letterboxSeconds, error: r.code === 0 ? undefined : r.stderr.trim().split('\n').slice(-3).join(' | ') };
}

export interface ContentArea {
  w: number;
  h: number;
  x: number;
  y: number;
  frameW: number;
  frameH: number;
}

/**
 * Where the picture actually is inside the frame. Video models sometimes return a 9:16 file with a
 * letterboxed (e.g. 4:3-ish) picture baked in; dimensions alone won't reveal that. With reset=0,
 * cropdetect reports the union of non-black content over all frames, so one dark shot can't trigger a crop.
 */
export async function detectContentArea(file: string, opts: { maxSeconds?: number } = {}): Promise<ContentArea | null> {
  const data = await probe(file);
  const v = data?.streams?.find((s) => s.codec_type === 'video');
  if (!v?.width || !v.height) return null;
  const limit = opts.maxSeconds !== undefined ? ['-t', opts.maxSeconds.toFixed(3)] : [];
  const r = await run(FFMPEG, ['-hide_banner', '-nostats', ...limit, '-i', file, '-vf', 'cropdetect=limit=24:round=2:reset=0', '-an', '-f', 'null', '-'], {
    allowFail: true,
  });
  const all = [...r.stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  const last = all.at(-1);
  if (r.code !== 0 || !last) return null;
  const [w, h, x, y] = last.slice(1, 5).map(Number) as [number, number, number, number];
  return { w, h, x, y, frameW: v.width, frameH: v.height };
}

/** True when black bars take up more than `tolerance` of the frame width or height. */
export function isLetterboxed(a: ContentArea, tolerance = 0.03): boolean {
  return a.w < a.frameW * (1 - tolerance) || a.h < a.frameH * (1 - tolerance);
}

export async function extractFrame(file: string, atSeconds: number, outJpg: string, width = 540): Promise<void> {
  await run(FFMPEG, ['-y', '-v', 'error', '-ss', atSeconds.toFixed(2), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', outJpg]);
}

/** Escape a value for use inside a filtergraph option, e.g. fontfile='C\:/Windows/Fonts/x.ttf'. */
export function filterPath(p: string): string {
  return `'${p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")}'`;
}
