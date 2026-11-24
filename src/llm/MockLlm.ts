import { PipelineError } from '../core/errors.js';
import type { LlmClient, LlmRequest } from './LlmClient.js';

/**
 * Deterministic LLM for offline runs (`--llm mock`) and tests: returns a canned, hand-written plan.
 * This is also the reference plan we used to sanity-check what the real model produces.
 */
export const MOCK_RESPONSES: Record<string, unknown> = {
  strategy: {
    angles: [
      {
        name: 'Calm in the Chaos',
        target_emotion: 'quiet confidence',
        hook: 'A packed gate erupts after a cancellation; one traveler stays perfectly still in the middle of it.',
        concept: 'Everyone around her panics; she just glances at her phone and smiles. She stands up and walks away from the chaos into golden light. Disruption is inevitable, panic is optional.',
        cta: 'Get covered in 60 seconds',
      },
      {
        name: 'The Receipt Pile',
        target_emotion: 'frustration to relief',
        hook: 'Receipts for a hotel, taxi and rebooked flight pile up on a cafe table.',
        concept: 'A traveler tallies the cost of a missed connection. One tap and the pile is swept away. NomadGuard pays it back.',
        cta: 'Stop paying for delays',
      },
      {
        name: '2AM Terminal Floor',
        target_emotion: 'empathy',
        hook: 'Close-up of a traveler trying to sleep on a cold airport floor under fluorescent light.',
        concept: 'We have all been there. Cut to the same traveler in a crisp hotel bed that NomadGuard booked. Rest is part of the plan.',
        cta: 'Never sleep at the gate',
      },
      {
        name: 'Plan B Is Already Done',
        target_emotion: 'empowerment',
        hook: 'A departure board flips to CANCELLED and the traveler does not even break stride.',
        concept: 'While the crowd queues at the desk, she is already boarding the next flight. NomadGuard rebooks before you ask.',
        cta: 'Travel with a Plan B',
      },
    ],
  },
  selection: {
    scores: [
      { index: 0, hook_strength: 9, brief_fit: 9, ai_feasibility: 8, sound_off_clarity: 9 },
      { index: 1, hook_strength: 6, brief_fit: 7, ai_feasibility: 6, sound_off_clarity: 6 },
      { index: 2, hook_strength: 8, brief_fit: 6, ai_feasibility: 8, sound_off_clarity: 8 },
      { index: 3, hook_strength: 8, brief_fit: 8, ai_feasibility: 4, sound_off_clarity: 7 },
    ],
    selected_index: 0,
    why_selected:
      'Strongest hook through visual contrast (chaos versus stillness), it states the core message without words, and it needs no on-screen text or UI inside the footage.',
    audience_insight:
      'Frequent travelers pride themselves on being the savvy one; they accept that disruption will happen but hate looking and feeling helpless when it does.',
    why_it_performs:
      'A single still figure in a moving crowd is a pattern interrupt in the feed, the protagonist is aspirational rather than a victim (premium tone), and the story reads with the sound off.',
    risks: ['Crowd faces may show AI artifacts, so keep the crowd in motion blur', 'Keep the phone screen out of shot'],
  },
  storyboard: {
    title: 'Calm in the Chaos',
    style_bible: {
      protagonist: 'a woman in her early 30s with shoulder-length dark brown hair, warm medium skin tone, calm expression, minimal makeup, small gold hoop earrings',
      wardrobe: 'a camel wool overcoat over a cream knit sweater, black tailored trousers, white leather sneakers, a tan leather weekender bag',
      world: 'a modern international airport terminal with glass walls, steel beams, polished stone floor and aircraft visible through tall windows',
      look: 'shot on a 35mm cinema camera, shallow depth of field, soft natural window light, warm highlights and cool teal shadows, premium commercial colour grade, subtle film grain',
    },
    scenes: [
      {
        id: 1,
        purpose: 'hook',
        duration: 4,
        description:
          'A crowded departure gate in sudden chaos: stressed travelers rush past in heavy motion blur, rolling suitcases, one man throws his hands up. In the exact centre, the protagonist sits perfectly still on a bench holding a coffee cup, untouched by the commotion.',
        camera: 'Locked-off medium-wide shot at seated eye level, 35mm lens, slow subtle push-in',
        action: 'She calmly lifts her coffee cup and takes a sip while the crowd streaks past her.',
        on_screen_text: 'Flight cancelled.',
        audio: 'busy terminal ambience, overlapping murmurs, rolling suitcase wheels, a distant boarding chime',
      },
      {
        id: 2,
        purpose: 'turn',
        duration: 4,
        description: 'Close-up of the protagonist. Her phone buzzes in her hand, she glances down at it (screen not visible to camera), exhales and a small relieved smile appears.',
        camera: 'Close-up, 85mm lens, shallow depth of field, gentle handheld',
        action: 'She glances at her phone, then looks up with a small confident smile.',
        on_screen_text: 'Rebooked. Hotel covered.',
        audio: 'soft phone vibration, terminal ambience muffled and softer',
      },
      {
        id: 3,
        purpose: 'resolution',
        duration: 4,
        description: 'The protagonist walks away from the crowded gate down a bright, quiet concourse toward tall windows with golden-hour sunlight and parked aircraft outside.',
        camera: 'Smooth gimbal tracking shot from behind and slightly to the side, 35mm lens, warm sun flare',
        action: 'She walks forward with a confident, relaxed stride, bag over her shoulder.',
        on_screen_text: "You're covered.",
        audio: 'footsteps on stone floor, calm open-space ambience',
      },
    ],
    end_card: { headline: 'Protected when things go wrong.', cta: 'Get covered in 60 sec', duration: 2.5 },
  },
  creative_qa: {
    scores: { realism: 7, visual_consistency: 7, brief_adherence: 8, hook_strength: 8, advertising_quality: 7 },
    rationale: { realism: 'mock review' },
    issues: [],
    summary: 'Mock review: no model was called.',
  },
};

export class MockLlm implements LlmClient {
  readonly name = 'mock';
  async generateJson(req: LlmRequest): Promise<string> {
    const r = MOCK_RESPONSES[req.label];
    if (!r) throw new PipelineError('INVALID_REQUEST', `MockLlm has no response for "${req.label}"`);
    return JSON.stringify(r);
  }
}
