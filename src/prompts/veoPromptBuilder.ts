import type { Scene, Storyboard } from '../domain/schemas.js';
import type { PromptBuilder } from '../providers/VideoProvider.js';

/**
 * Veo responds best to a cinematographer-style paragraph: shot + subject + action + setting + look + audio.
 * The style bible is pasted verbatim into every shot. Since each clip is generated independently,
 * repeating the exact same protagonist/wardrobe/look text is the main lever for cross-shot consistency.
 * Text and logos are pushed to the negative prompt: models garble them, so we burn text in during assembly.
 */
/** LLM fields arrive as full sentences; normalise them so they splice into one paragraph without ".." or mid-sentence capitals. */
const clause = (s: string) => s.trim().replace(/[.\s]+$/, '');
const inline = (s: string) => {
  const c = clause(s);
  return /^[A-Z](?![A-Z])/.test(c) ? c[0]!.toLowerCase() + c.slice(1) : c; // keep acronyms ("NYC") as is
};

export const veoPromptBuilder: PromptBuilder = {
  build(scene: Scene, sb: Storyboard) {
    const { protagonist, wardrobe, world, look } = sb.style_bible;
    const prompt = [
      `${clause(scene.camera)}.`,
      `${clause(scene.description)}.`,
      `The protagonist is ${inline(protagonist)}, wearing ${inline(wardrobe)}.`,
      `Action: ${clause(scene.action)}.`,
      `Setting: ${clause(world)}.`,
      `Look: ${clause(look)}. Photorealistic premium commercial footage, natural skin texture, realistic motion.`,
      `Vertical 9:16 composition with the subject in the centre of the frame, leaving the top fifth clear.`,
      `Audio: ${clause(scene.audio)}. No dialogue, no music.`,
    ].join(' ');

    const negativePrompt =
      'text, captions, subtitles, letters, signage text, logos, watermark, phone screen close-up, cartoon, CGI, 3d render, ' +
      'distorted hands, extra fingers, deformed face, face morphing, flicker, low resolution, blurry, oversaturated';

    return { prompt, negativePrompt };
  },
};
