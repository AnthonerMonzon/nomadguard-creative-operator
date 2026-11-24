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

/** Fully decode the file (proves it is playable end to end) and detect black segments in the same pass. */
export async function decodeCheck(file: string): Promise<{ playable: boolean; black: { start: number; end: number }[]; error?: string }> {
  const r = await run(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-vf', 'blackdetect=d=0.4:pix_th=0.10', '-an', '-f', 'null', '-'], {
    allowFail: true,
  });
  const black = [...r.stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)].map((m) => ({ start: Number(m[1]), end: Number(m[2]) }));
  return { playable: r.code === 0, black, error: r.code === 0 ? undefined : r.stderr.trim().split('\n').slice(-3).join(' | ') };
}

export async function extractFrame(file: string, atSeconds: number, outJpg: string, width = 540): Promise<void> {
  await run(FFMPEG, ['-y', '-v', 'error', '-ss', atSeconds.toFixed(2), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', outJpg]);
}

/** Escape a value for use inside a filtergraph option, e.g. fontfile='C\:/Windows/Fonts/x.ttf'. */
export function filterPath(p: string): string {
  return `'${p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")}'`;
}
