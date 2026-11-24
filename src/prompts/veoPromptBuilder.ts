import type { Scene, Storyboard } from '../domain/schemas.js';
import type { PromptBuilder } from '../providers/VideoProvider.js';

/**
 * Veo responds best to a cinematographer-style paragraph: shot + subject + action + setting + look + audio.
 * The style bible is pasted verbatim into every shot. Since each clip is generated independently,
 * repeating the exact same protagonist/wardrobe/look text is the main lever for cross-shot consistency.
 * Text and logos are pushed to the negative prompt: models garble them, so we burn text in during assembly.
 */
export const veoPromptBuilder: PromptBuilder = {
  build(scene: Scene, sb: Storyboard) {
    const { protagonist, wardrobe, world, look } = sb.style_bible;
    const prompt = [
      `${scene.camera}.`,
      `${scene.description}`,
      `The protagonist is ${protagonist}, wearing ${wardrobe}.`,
      `Action: ${scene.action}`,
      `Setting: ${world}.`,
      `Look: ${look}. Photorealistic premium commercial footage, natural skin texture, realistic motion.`,
      `Vertical 9:16 composition with the subject in the centre of the frame, leaving the top fifth clear.`,
      `Audio: ${scene.audio}. No dialogue, no music.`,
    ].join(' ');

    const negativePrompt =
      'text, captions, subtitles, letters, signage text, logos, watermark, phone screen close-up, cartoon, CGI, 3d render, ' +
      'distorted hands, extra fingers, deformed face, face morphing, flicker, low resolution, blurry, oversaturated';

    return { prompt, negativePrompt };
  },
};
