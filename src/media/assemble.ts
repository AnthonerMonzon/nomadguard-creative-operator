import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Storyboard } from '../domain/schemas.js';
import { detectContentArea, FFMPEG, filterPath, isLetterboxed, probe, run } from './ffmpeg.js';

export const BRAND = { navy: '0x0B1D33', teal: '0x3FD0C9', white: 'white' };
const W = 1080;
const H = 1920;
const FPS = 30;

/** drawtext has no word wrap; keep overlays to short, centred lines. */
export function wrapText(text: string, maxChars: number): string {
  const lines: string[] = [];
  let line = '';
  for (const word of text.trim().split(/\s+/)) {
    if (line && (line + ' ' + word).length > maxChars) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

interface DrawTextOpts {
  textFile: string; // relative to the ffmpeg cwd, avoids escaping user text inside the filtergraph
  fontFile?: string;
  size: number;
  y: string;
  color?: string;
  box?: string; // box colour, e.g. black@0.45
  boxBorder?: number;
  fadeIn?: number;
}

function drawtext(o: DrawTextOpts): string {
  const parts = [
    `textfile=${filterPath(o.textFile)}`,
    'expansion=none',
    o.fontFile ? `fontfile=${filterPath(o.fontFile)}` : '',
    `fontsize=${o.size}`,
    `fontcolor=${o.color ?? 'white'}`,
    'line_spacing=14',
    'x=(w-text_w)/2',
    `y=${o.y}`,
    o.box ? `box=1:boxcolor=${o.box}:boxborderw=${o.boxBorder ?? 24}` : '',
    o.fadeIn ? `alpha='min(1,t/${o.fadeIn})'` : '',
  ];
  return 'drawtext=' + parts.filter(Boolean).join(':');
}

export interface AssembleInput {
  workDir: string; // job directory; ffmpeg runs here
  clips: { file: string; duration: number; text: string }[]; // file relative to workDir
  storyboard: Storyboard;
  brand: string;
  fontFile?: string;
  output: string; // relative to workDir
}

/**
 * Normalise every clip to 1080x1920@30 with stereo 48k audio, trim/pad to the storyboard duration,
 * burn in the sound-off captions, append a branded end card, and encode a social-ready H.264 MP4.
 * The end card is rendered by us (not the video model) so brand name and CTA are always pixel-perfect.
 */
export async function assemble(input: AssembleInput): Promise<string> {
  const textDir = path.join(input.workDir, 'text');
  await mkdir(textDir, { recursive: true });
  /** One drawtext per line, each centred; drawtext itself left-aligns multi-line text. Returns a filter chain. */
  const textLayer = async (name: string, text: string, maxChars: number, o: Omit<DrawTextOpts, 'textFile' | 'y'> & { y: number }) => {
    const lines = wrapText(text, maxChars).split('\n');
    const step = Math.round(o.size * 1.25 + (o.box ? (o.boxBorder ?? 24) : 0));
    const layers: string[] = [];
    for (const [i, line] of lines.entries()) {
      const file = `${name}-${i}.txt`;
      await writeFile(path.join(textDir, file), line, 'utf8');
      layers.push(drawtext({ ...o, textFile: `text/${file}`, y: String(Math.round(o.y + i * step)) }));
    }
    return layers.join(',');
  };

  const args: string[] = ['-y', '-hide_banner', '-v', 'error'];
  const filters: string[] = [];
  const concatInputs: string[] = [];

  for (const [i, clip] of input.clips.entries()) {
    args.push('-i', clip.file);
    const d = clip.duration.toFixed(3);
    // Strip bars the model baked into the picture, then scale-to-fill as usual (costs some edge, keeps full-bleed 9:16).
    const area = await detectContentArea(path.join(input.workDir, clip.file));
    const debar = area && isLetterboxed(area) ? `crop=${area.w}:${area.h}:${area.x}:${area.y},` : '';
    let v = `[${i}:v]${debar}scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${FPS},tpad=stop_mode=clone:stop_duration=2,trim=duration=${d},setpts=PTS-STARTPTS`;
    if (clip.text.trim()) {
      v += ',' + (await textLayer(`scene-${i + 1}`, clip.text.toUpperCase(), 20, { fontFile: input.fontFile, size: 68, y: H * 0.14, box: 'black@0.45', boxBorder: 28, fadeIn: i === 0 ? 0 : 0.2 }));
    }
    filters.push(`${v}[v${i}]`);

    const hasAudio = (await probe(path.join(input.workDir, clip.file)))?.streams?.some((s) => s.codec_type === 'audio');
    filters.push(
      hasAudio
        ? `[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=duration=${d},asetpts=PTS-STARTPTS,afade=t=in:d=0.04,afade=t=out:st=${(clip.duration - 0.08).toFixed(3)}:d=0.08[a${i}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${d}[a${i}]`,
    );
    concatInputs.push(`[v${i}][a${i}]`);
  }

  // End card.
  const ec = input.storyboard.end_card;
  const ecd = ec.duration.toFixed(3);
  filters.push(
    [
      `color=c=${BRAND.navy}:s=${W}x${H}:r=${FPS}:d=${ecd},format=yuv420p`,
      await textLayer('end-brand', input.brand, 40, { fontFile: input.fontFile, size: 120, y: H * 0.36 }),
      `drawbox=x=(iw-160)/2:y=${Math.round(H * 0.36 + 165)}:w=160:h=6:color=${BRAND.teal}:t=fill`,
      await textLayer('end-headline', ec.headline, 22, { fontFile: input.fontFile, size: 58, y: H * 0.36 + 225, color: 'white@0.92' }),
      await textLayer('end-cta', ec.cta.toUpperCase(), 40, { fontFile: input.fontFile, size: 50, y: H * 0.7, color: BRAND.navy, box: BRAND.teal, boxBorder: 34 }),
      'fade=t=in:st=0:d=0.3',
    ].join(',') + '[vend]',
  );
  filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${ecd}[aend]`);
  concatInputs.push('[vend][aend]');

  filters.push(`${concatInputs.join('')}concat=n=${concatInputs.length}:v=1:a=1[vout][aout]`);

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
    '-movflags', '+faststart',
    input.output,
  );
  await run(FFMPEG, args, { cwd: input.workDir });
  return path.join(input.workDir, input.output);
}
