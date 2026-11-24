import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Angle, Brief, CreativeReview, Storyboard } from '../domain/schemas.js';
import { CreativeReviewSchema } from '../domain/schemas.js';
import type { LlmClient, LlmImage } from '../llm/LlmClient.js';
import { generateStructured } from '../llm/structured.js';
import { extractFrame } from '../media/ffmpeg.js';

export interface CreativeQaResult {
  review: CreativeReview;
  average: number;
  verdict: 'approved' | 'needs_review';
  reasons: string[];
  frames: string[];
}

/** Dense sampling in the hook window (what decides scroll-or-stay), then the middle of every later scene. */
export function sampleTimestamps(sb: Storyboard): { t: number; label: string }[] {
  const out: { t: number; label: string }[] = [
    { t: 0.3, label: 'hook' },
    { t: 1.2, label: 'hook' },
    { t: 2.4, label: 'hook' },
  ];
  let start = 0;
  for (const s of sb.scenes) {
    if (s.id !== 1) out.push({ t: start + s.duration / 2, label: `scene ${s.id}` });
    out.push({ t: start + s.duration - 0.3, label: `scene ${s.id} end` });
    start += s.duration;
  }
  out.push({ t: start + sb.end_card.duration / 2, label: 'end card' });
  return out;
}

const RUBRIC = `Score 1-10 with these anchors (be strict, generated video is usually over-rated):
10 = indistinguishable from a top-tier agency spot; 8 = would run as a paid ad with minor tweaks;
6 = usable but noticeably AI or generic; 4 = visible artifacts or confusing; 2 = broken.
- realism: faces, hands, physics, skin, lighting. Any morphing or extra fingers caps this at 5.
- visual_consistency: same protagonist, wardrobe and grade across scenes.
- brief_adherence: communicates the core message and brand feel.
- hook_strength: judged ONLY from the hook frames (first ~2.5s). Would the audience stop scrolling?
- advertising_quality: clear story, readable overlays, strong end card, feels like a real social ad not stitched clips.
List concrete issues with the scene_id they occur in (null for global) and a severity.`;

/**
 * Vision-model review of sampled frames against the brief and storyboard.
 * The model only scores; the approve/review decision is a deterministic threshold in code.
 */
export async function runCreativeQa(opts: {
  llm: LlmClient;
  video: string;
  workDir: string;
  brief: Brief;
  angle: Angle;
  storyboard: Storyboard;
  minScore: number;
  minAverage: number;
}): Promise<CreativeQaResult> {
  const frameDir = path.join(opts.workDir, 'frames');
  await mkdir(frameDir, { recursive: true });
  const stamps = sampleTimestamps(opts.storyboard);
  const images: LlmImage[] = [];
  const frames: string[] = [];
  for (const [i, s] of stamps.entries()) {
    const file = path.join(frameDir, `f${String(i).padStart(2, '0')}_${s.t.toFixed(1)}s.jpg`);
    await extractFrame(opts.video, s.t, file);
    frames.push(file);
    images.push({ mimeType: 'image/jpeg', base64: (await readFile(file)).toString('base64'), caption: `Frame at t=${s.t.toFixed(1)}s (${s.label}):` });
  }

  const review = await generateStructured(opts.llm, {
    label: 'creative_qa',
    schema: CreativeReviewSchema,
    temperature: 0.1,
    system: 'You are a demanding creative QA reviewer for paid social video ads. You judge only what is visible in the frames. Respond with JSON only.',
    prompt: `Brief: ${JSON.stringify(opts.brief)}
Selected concept: ${JSON.stringify(opts.angle)}
Storyboard: ${JSON.stringify({ scenes: opts.storyboard.scenes.map(({ video_prompt, negative_prompt, ...s }) => s), end_card: opts.storyboard.end_card })}

The frames below are sampled from the final 9:16 ad in time order.
${RUBRIC}

JSON shape: {"scores":{"realism":0,"visual_consistency":0,"brief_adherence":0,"hook_strength":0,"advertising_quality":0},
"rationale":{"realism":"","visual_consistency":"","brief_adherence":"","hook_strength":"","advertising_quality":""},
"issues":[{"scene_id":1,"severity":"minor|major|blocker","description":""}],"summary":""}`,
    images,
  });

  const values = Object.values(review.scores);
  const average = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
  const reasons: string[] = [];
  for (const [k, v] of Object.entries(review.scores)) if (v < opts.minScore) reasons.push(`${k} ${v} < ${opts.minScore}`);
  if (average < opts.minAverage) reasons.push(`average ${average} < ${opts.minAverage}`);
  for (const i of review.issues) if (i.severity === 'blocker') reasons.push(`blocker: ${i.description}`);

  return { review, average, verdict: reasons.length ? 'needs_review' : 'approved', reasons, frames };
}
