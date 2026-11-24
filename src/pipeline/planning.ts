import type { Brief, Selection, Storyboard, Strategy } from '../domain/schemas.js';
import { SelectionSchema, StoryboardSchema, StrategySchema } from '../domain/schemas.js';
import type { LlmClient } from '../llm/LlmClient.js';
import { generateStructured } from '../llm/structured.js';
import type { VideoCapabilities } from '../providers/VideoProvider.js';

const CREATIVE_DIRECTOR = `You are a senior creative director who makes paid social ads (Instagram Reels, TikTok) for premium consumer brands.
You also know exactly what current text-to-video models can and cannot render convincingly.
Hard production constraints for everything you propose:
- 10-15 seconds, vertical 9:16, photorealistic, must work with the sound OFF.
- The first 1-2 seconds must stop the scroll with a visual, not with a logo.
- Each shot is generated separately by an AI video model, so: one recurring protagonist at most, simple single actions per shot,
  no readable text/logos/phone UI inside the footage (we add text in post), no dialogue or lip-sync, no crowds in close-up, no complex hand-object interactions.
Respond with JSON only.`;

const briefText = (b: Brief) => JSON.stringify(b, null, 2);

export async function generateStrategy(llm: LlmClient, brief: Brief): Promise<Strategy> {
  return generateStructured(llm, {
    label: 'strategy',
    schema: StrategySchema,
    system: CREATIVE_DIRECTOR,
    temperature: 0.9,
    prompt: `Brief:\n${briefText(brief)}

Generate 4 genuinely different creative angles for this ad (different emotions and different stories, not variations of one idea).
For each: name, target_emotion, hook (what the viewer SEES in the first 2 seconds), concept (the 3-beat story in 2-3 sentences), cta (max 28 characters).

JSON shape: {"angles":[{"name":"","target_emotion":"","hook":"","concept":"","cta":""}]}`,
    validate: (s) => {
      const names = new Set(s.angles.map((a) => a.name.toLowerCase()));
      const problems: string[] = [];
      if (names.size !== s.angles.length) problems.push('angle names must be unique');
      s.angles.forEach((a, i) => a.cta.length > 28 && problems.push(`angles.${i}.cta is longer than 28 characters`));
      return problems;
    },
  });
}

export async function selectAngle(llm: LlmClient, brief: Brief, strategy: Strategy): Promise<Selection> {
  return generateStructured(llm, {
    label: 'selection',
    schema: SelectionSchema,
    system: CREATIVE_DIRECTOR,
    temperature: 0.2,
    prompt: `Brief:\n${briefText(brief)}

Candidate angles (index: angle):
${strategy.angles.map((a, i) => `${i}: ${JSON.stringify(a)}`).join('\n')}

Score every angle 1-10 on:
- hook_strength: will the first 2 seconds stop a 25-40 year old frequent traveler mid-scroll?
- brief_fit: core message ("${brief.core_message}") and brand feel (${brief.brand_feel.join(', ')}).
- ai_feasibility: can today's text-to-video models render it photorealistically and consistently across separate shots?
- sound_off_clarity: is the story understood with no audio and only short text overlays?
A brilliant idea that cannot be rendered is a bad choice. Pick the best overall angle.

Explain briefly (1-2 sentences each): why_selected, audience_insight (the human truth it is built on), why_it_performs (as a paid social ad). List the main execution risks.

JSON shape: {"scores":[{"index":0,"hook_strength":0,"brief_fit":0,"ai_feasibility":0,"sound_off_clarity":0}],"selected_index":0,"why_selected":"","audience_insight":"","why_it_performs":"","risks":[""]}`,
    validate: (s) => {
      const problems: string[] = [];
      if (s.selected_index >= strategy.angles.length) problems.push(`selected_index ${s.selected_index} does not exist`);
      if (s.scores.length !== strategy.angles.length) problems.push(`expected ${strategy.angles.length} score entries, got ${s.scores.length}`);
      return problems;
    },
  });
}

/** Rules a storyboard must satisfy before we spend money rendering it. Exported for tests. */
export function storyboardProblems(sb: Storyboard, brief: Brief, caps: VideoCapabilities): string[] {
  const problems: string[] = [];
  const total = sb.scenes.reduce((s, x) => s + x.duration, 0) + sb.end_card.duration;
  if (total < brief.format.min_seconds || total > brief.format.max_seconds)
    problems.push(`total duration (scenes + end card) is ${total}s; it must be between ${brief.format.min_seconds} and ${brief.format.max_seconds}s`);
  sb.scenes.forEach((s, i) => {
    if (!caps.durations.includes(s.duration)) problems.push(`scenes.${i}.duration ${s.duration} is not supported; allowed: ${caps.durations.join(', ')}`);
    if (s.id !== i + 1) problems.push(`scenes.${i}.id must be ${i + 1}`);
  });
  const first = sb.scenes[0];
  if (first && first.purpose !== 'hook') problems.push('scenes.0.purpose must be "hook"');
  if (first && !first.on_screen_text.trim()) problems.push('scenes.0.on_screen_text must not be empty (sound-off hook)');
  return problems;
}

export async function generateStoryboard(llm: LlmClient, brief: Brief, strategy: Strategy, selection: Selection, caps: VideoCapabilities): Promise<Storyboard> {
  const angle = strategy.angles[selection.selected_index]!;
  return generateStructured(llm, {
    label: 'storyboard',
    schema: StoryboardSchema,
    system: CREATIVE_DIRECTOR,
    temperature: 0.6,
    maxAttempts: 4,
    prompt: `Brief:\n${briefText(brief)}

Selected angle:\n${JSON.stringify(angle, null, 2)}
Audience insight: ${selection.audience_insight}

Write the storyboard for a ${brief.format.min_seconds}-${brief.format.max_seconds}s vertical ad.
Rules:
- 3 scenes (2-4 allowed). Each scene duration must be one of: ${caps.durations.join(', ')} seconds. Then a branded end card of 2-3 seconds that we render ourselves.
- Total of scenes + end card must be ${brief.format.min_seconds}-${brief.format.max_seconds}s.
- Scene 1 purpose is "hook": the strongest image of the ad must be visible in its first second.
- style_bible is pasted verbatim into every video prompt, so make it concrete and visual: protagonist (age, hair, skin tone, build, face details),
  wardrobe (exact garments and colours), world (location details), look (lens, lighting, colour grade). Premium, modern, trustworthy.
- description: what we see. camera: shot size + lens + movement. action: ONE simple physical action.
- on_screen_text: short sound-off caption we burn in (max 32 characters, can be empty for non-hook scenes).
- audio: ambient sound design only (no dialogue, no voiceover, no music lyrics).
- end_card: headline (the core message, max 40 chars) and cta (max 28 chars).

JSON shape: {"title":"","style_bible":{"protagonist":"","wardrobe":"","world":"","look":""},
"scenes":[{"id":1,"purpose":"hook|tension|turn|resolution","duration":4,"description":"","camera":"","action":"","on_screen_text":"","audio":""}],
"end_card":{"headline":"","cta":"","duration":2.5}}`,
    validate: (sb) => storyboardProblems(sb, brief, caps),
  });
}
