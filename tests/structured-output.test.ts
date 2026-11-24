import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PipelineError } from '../src/core/errors.js';
import { generateStructured } from '../src/llm/structured.js';
import { generateStoryboard } from '../src/pipeline/planning.js';
import { MockProvider } from '../src/providers/MockProvider.js';
import { brief, clone, noSleep, ScriptedLlm, selection, storyboard, strategy } from './helpers.js';

/**
 * Risk: the LLM is the least reliable component, and a bad storyboard silently wastes paid video renders.
 * Everything it returns must be parsed, schema-checked and rule-checked, with errors fed back for repair.
 */
describe('LLM structured output', () => {
  const caps = new MockProvider().capabilities;

  it('repairs malformed JSON and a storyboard that breaks the 10-15s rule before accepting it', async () => {
    const good = storyboard();
    const tooLong = clone(good);
    tooLong.scenes = tooLong.scenes.map((s) => ({ ...s, duration: 8 })); // 24s + end card

    const llm = new ScriptedLlm(['```json\n{"title": "oops", ', JSON.stringify(tooLong), JSON.stringify(good)]);
    const result = await generateStoryboard(llm, brief, strategy(), selection(), caps);

    expect(result.scenes.reduce((s, x) => s + x.duration, 0) + result.end_card.duration).toBe(14.5);
    expect(llm.prompts).toHaveLength(3);
    expect(llm.prompts[1]).toContain('not valid JSON'); // model is told what was wrong...
    expect(llm.prompts[2]).toContain('total duration (scenes + end card) is 26.5s'); // ...including business rules
  });

  it('rejects unsupported clip durations and a missing hook overlay', async () => {
    const bad = storyboard();
    bad.scenes[0]!.duration = 5; // Veo only accepts 4/6/8
    bad.scenes[0]!.on_screen_text = '';
    const llm = new ScriptedLlm([JSON.stringify(bad), JSON.stringify(bad), JSON.stringify(bad), JSON.stringify(bad)]);

    const err = await generateStoryboard(llm, brief, strategy(), selection(), caps).catch((e) => e);
    expect(err).toBeInstanceOf(PipelineError);
    expect(err.code).toBe('INVALID_OUTPUT');
    expect(err.message).toMatch(/duration 5 is not supported/);
    expect(err.message).toMatch(/on_screen_text must not be empty/);
  });

  it('retries transport errors (503/429) without spending repair attempts', async () => {
    const llm = new ScriptedLlm([Object.assign(new Error('unavailable'), { status: 503 }), Object.assign(new Error('quota'), { status: 429 }), '{"ok": true}']);
    const out = await generateStructured(llm, { label: 't', system: '', prompt: 'p', schema: z.object({ ok: z.boolean() }), maxAttempts: 1, sleep: noSleep });
    expect(out).toEqual({ ok: true });
  });
});
