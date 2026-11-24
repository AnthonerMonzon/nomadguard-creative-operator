import { z } from 'zod';

/** Input: the marketing brief. */
export const BriefSchema = z.object({
  brand: z.string(),
  description: z.string(),
  audience: z.string(),
  problem: z.array(z.string()).min(1),
  core_message: z.string(),
  brand_feel: z.array(z.string()).min(1),
  format: z.object({
    min_seconds: z.number().positive(),
    max_seconds: z.number().positive(),
    aspect_ratio: z.literal('9:16'),
    platforms: z.array(z.string()),
  }),
});
export type Brief = z.infer<typeof BriefSchema>;

/** Part 1: strategy. */
export const AngleSchema = z.object({
  name: z.string().min(1),
  target_emotion: z.string().min(1),
  hook: z.string().min(1),
  concept: z.string().min(1),
  cta: z.string().min(1),
});
export type Angle = z.infer<typeof AngleSchema>;

export const StrategySchema = z.object({ angles: z.array(AngleSchema).min(3) });
export type Strategy = z.infer<typeof StrategySchema>;

const Score = z.number().min(1).max(10);
export const SelectionSchema = z.object({
  scores: z
    .array(
      z.object({
        index: z.number().int().min(0),
        hook_strength: Score,
        brief_fit: Score,
        ai_feasibility: Score, // can current text-to-video render this convincingly?
        sound_off_clarity: Score,
      }),
    )
    .min(1),
  selected_index: z.number().int().min(0),
  why_selected: z.string().min(1),
  audience_insight: z.string().min(1),
  why_it_performs: z.string().min(1),
  risks: z.array(z.string()).default([]),
});
export type Selection = z.infer<typeof SelectionSchema>;

/** Part 2: storyboard. `video_prompt` is filled in by the provider-specific PromptBuilder, not the LLM. */
export const SceneSchema = z.object({
  id: z.number().int().min(1),
  purpose: z.enum(['hook', 'tension', 'turn', 'resolution']),
  duration: z.number().positive(),
  description: z.string().min(1),
  camera: z.string().min(1),
  action: z.string().min(1),
  on_screen_text: z.string().max(48),
  audio: z.string().min(1),
  video_prompt: z.string().optional(),
  negative_prompt: z.string().optional(),
});
export type Scene = z.infer<typeof SceneSchema>;

export const StoryboardSchema = z.object({
  title: z.string(),
  style_bible: z.object({
    protagonist: z.string().min(1), // repeated verbatim in every prompt -> character consistency
    wardrobe: z.string().min(1),
    world: z.string().min(1),
    look: z.string().min(1), // lens, lighting, colour grade
  }),
  scenes: z.array(SceneSchema).min(2).max(5),
  end_card: z.object({
    headline: z.string().min(1).max(40),
    cta: z.string().min(1).max(28),
    duration: z.number().min(1.5).max(4),
  }),
});
export type Storyboard = z.infer<typeof StoryboardSchema>;

/** Part 6: QA. */
export const CreativeScoresSchema = z.object({
  realism: Score,
  visual_consistency: Score,
  brief_adherence: Score,
  hook_strength: Score,
  advertising_quality: Score,
});
export type CreativeScores = z.infer<typeof CreativeScoresSchema>;

export const CreativeReviewSchema = z.object({
  scores: CreativeScoresSchema,
  rationale: z.record(z.string(), z.string()).default({}),
  issues: z
    .array(
      z.object({
        scene_id: z.number().int().nullable().default(null),
        severity: z.enum(['minor', 'major', 'blocker']),
        description: z.string(),
      }),
    )
    .default([]),
  summary: z.string(),
});
export type CreativeReview = z.infer<typeof CreativeReviewSchema>;

export interface TechnicalReport {
  exists: boolean;
  playable: boolean;
  duration: number | null;
  resolution: string | null;
  aspect_ratio: string | null;
  fps: number | null;
  has_audio: boolean;
  black_segments: { start: number; end: number }[];
  checks: { name: string; pass: boolean; detail: string }[];
  valid: boolean;
}
