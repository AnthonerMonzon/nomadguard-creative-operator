import { existsSync } from 'node:fs';
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
  alpha?: string; // drawtext alpha expression (animation)
  shadow?: boolean;
}

/** 0→1 progress of an animation starting at `start` seconds and lasting `dur`. */
const progress = (start: number, dur: number) => `min(1,max(0,(t-${start})/${dur}))`;

/** Use a heavier/lighter cut of the configured font when it sits next to it (e.g. Segoe UI Black beside Segoe UI Bold). */
function fontVariant(base: string | undefined, file: string): string | undefined {
  if (!base) return base;
  const candidate = path.join(path.dirname(base), file);
  return existsSync(candidate) ? candidate : base;
}

const TEAL_RGB = [0x3f, 0xd0, 0xc9] as const;

/** Anti-aliased rounded pill (radius = h/2) as an RGBA video source, fading in at `start`. */
function pillSource(w: number, h: number, seconds: string, start: number): string {
  const r = h / 2;
  const a = `255*clip(${r}+0.5-hypot(max(0,abs(X-${w / 2})-${w / 2 - r}),abs(Y-${r})),0,1)`;
  return `color=c=black:s=${w}x${h}:r=${FPS}:d=${seconds},format=rgba,geq=r=${TEAL_RGB[0]}:g=${TEAL_RGB[1]}:b=${TEAL_RGB[2]}:a='${a}',fade=t=in:st=${start}:d=0.3:alpha=1`;
}

/** Top-down dark gradient behind captions so white type reads on any footage, without hard boxes. */
function scrimSource(h: number): string {
  return `color=c=black:s=${W}x${h}:r=${FPS}:d=1,trim=end_frame=1,format=rgba,geq=r=0:g=0:b=0:a='165*pow(1-Y/${h},1.7)'`;
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
    `y='${o.y}'`,
    o.box ? `box=1:boxcolor=${o.box}:boxborderw=${o.boxBorder ?? 24}` : '',
    o.shadow ? 'shadowcolor=black@0.45:shadowx=0:shadowy=4' : '',
    o.alpha ? `alpha='${o.alpha}'` : '',
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
  const fonts = {
    heavy: fontVariant(input.fontFile, 'seguibl.ttf'),
    semibold: fontVariant(input.fontFile, 'seguisb.ttf'),
  };
  type Anim = { start: number; dur: number; slide: number };
  /**
   * One drawtext per line, each centred; drawtext itself left-aligns multi-line text. Returns a filter chain.
   * With `anim`, the block fades in while easing up by `slide` px.
   */
  const textLayer = async (
    name: string,
    text: string,
    maxChars: number,
    o: Omit<DrawTextOpts, 'textFile' | 'y' | 'alpha'> & { y: number; anim?: Anim; lineHeight?: number },
  ) => {
    const lines = wrapText(text, maxChars).split('\n');
    const step = Math.round(o.size * (o.lineHeight ?? 1.18) + (o.box ? (o.boxBorder ?? 24) : 0));
    const p = o.anim ? progress(o.anim.start, o.anim.dur) : '';
    const layers: string[] = [];
    for (const [i, line] of lines.entries()) {
      const file = `${name}-${i}.txt`;
      await writeFile(path.join(textDir, file), line, 'utf8');
      const y = Math.round(o.y + i * step);
      layers.push(
        drawtext({
          ...o,
          textFile: `text/${file}`,
          y: o.anim ? `${y}+${o.anim.slide}*pow(1-${p},3)` : String(y),
          alpha: o.anim ? p : undefined,
        }),
      );
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
    const base = `[${i}:v]${debar}scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${FPS},tpad=stop_mode=clone:stop_duration=2,trim=duration=${d},setpts=PTS-STARTPTS`;
    const isLast = i === input.clips.length - 1;
    // The last shot's final frame becomes the (blurred) end-card background, so the ad ends on its own world.
    filters.push(isLast ? `${base},split=2[base${i}][endsrc]` : `${base}[base${i}]`);

    if (clip.text.trim()) {
      // Caption: heavy sentence-case type on a soft top gradient, teal brand tick above, eased slide-up.
      // The hook (scene 1) is on screen from frame 0: no entrance delay where scroll-or-stay is decided.
      const capY = Math.round(H * 0.105);
      const anim = i === 0 ? undefined : { start: 0.08, dur: 0.35, slide: 28 };
      filters.push(`${scrimSource(720)}[scrim${i}]`);
      filters.push(
        [
          `[base${i}][scrim${i}]overlay=0:0`,
          `drawbox=x=(iw-84)/2:y=${capY - 40}:w=84:h=7:color=${BRAND.teal}:t=fill`,
          await textLayer(`scene-${i + 1}`, clip.text, 18, { fontFile: fonts.heavy, size: 80, y: capY, shadow: true, lineHeight: 1.12, anim }),
          'format=yuv420p',
        ].join(',') + `[v${i}]`,
      );
    } else {
      filters.push(`[base${i}]null[v${i}]`);
    }

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
  const lastDur = input.clips.at(-1)!.duration;
  const brandY = Math.round(H * 0.33);
  // CTA pill: width follows the label (heavy caps ≈ 0.64em per char), clamped to a comfortable thumb target.
  const ctaText = `${ec.cta.toUpperCase()}  →`;
  const ctaSize = 46;
  const pillH = 132;
  const pillW = Math.min(980, Math.max(560, Math.round(ctaText.length * ctaSize * 0.64 + 140)));
  const pillY = Math.round(H * 0.66);
  const ctaStart = 0.6;
  const ctaFile = 'end-cta-0.txt';
  await writeFile(path.join(textDir, ctaFile), ctaText, 'utf8');

  filters.push(
    [
      `[endsrc]trim=start=${Math.max(0, lastDur - 0.05).toFixed(3)},setpts=PTS-STARTPTS,trim=end_frame=1`,
      `tpad=stop_mode=clone:stop_duration=${ecd},trim=duration=${ecd},setpts=PTS-STARTPTS`,
      'gblur=sigma=32',
      `drawbox=x=0:y=0:w=iw:h=ih:color=${BRAND.navy}@0.80:t=fill`,
    ].join(',') + '[endbg]',
  );
  filters.push(`${pillSource(pillW, pillH, ecd, ctaStart)}[pill]`);
  filters.push(
    [
      `[endbg][pill]overlay=x=(main_w-overlay_w)/2:y=${pillY}`,
      await textLayer('end-brand', input.brand, 40, { fontFile: fonts.heavy, size: 132, y: brandY, anim: { start: 0.05, dur: 0.4, slide: 36 } }),
      `drawbox=x=(iw-120)/2:y=${brandY + 190}:w=120:h=7:color=${BRAND.teal}:t=fill:enable='gte(t,0.3)'`,
      await textLayer('end-headline', ec.headline, 22, {
        fontFile: fonts.semibold, size: 62, y: brandY + 245, color: 'white@0.92', anim: { start: 0.3, dur: 0.4, slide: 24 },
      }),
      drawtext({
        textFile: `text/${ctaFile}`, fontFile: fonts.heavy, size: ctaSize, color: BRAND.navy,
        y: `${pillY}+(${pillH}-text_h)/2`, alpha: progress(ctaStart, 0.3),
      }),
      'format=yuv420p',
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
