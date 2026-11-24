# AI usage

> ✏️ Review before submitting: this file must describe *your* supervision. Edit or replace anything that doesn't match what you did.

## Tools

- **Claude Code** (VS Code extension): reading the challenge PDF, planning, scaffolding, writing most of the TypeScript, tests and docs, running the dry runs and tests.
- **Gemini** (runtime, not dev tooling): strategy, storyboard and creative QA inside the pipeline.
- **Veo** (runtime): video generation.

## What was AI-generated

Roughly 90% of the code and docs were AI-written. Architecture, provider choice, the concept selection criteria, prompt strategy and the QA policy were discussed and decided in conversation, then reviewed: running the offline pipeline, looking at extracted frames, and reading the diffs.

## An AI-generated decision I changed or rejected

*(Fill in with your own: candidates from this session)*
- Creative QA as a **gate that auto-regenerates** scenes when the vision model scores them low was rejected. An LLM's opinion in a paid render loop can burn credits indefinitely, so QA is advisory (`needs_review` + issues) and a human decides.
- Caption text **generated inside the video** by the model was rejected in favour of ffmpeg-rendered overlays and end card (models garble text).

## Problems introduced by AI that were detected and corrected

1. **Lost failure reason on submit errors.** The first version of `generateScenes` incremented the attempt counter and then called `provider.generate()`. If the submit itself failed (e.g. model not available in region), the scene stayed `PENDING` with no `lastError`, so `status` showed nothing useful. The end-to-end test caught it (`expected FAILED, got PENDING`). Fixed by recording the error on the scene before rethrowing.
2. **Left-aligned multi-line captions.** ffmpeg `drawtext` left-aligns multi-line text even with a centred `x`. This was only visible by actually looking at extracted frames (the end-card headline's second line hugged the left). Fixed by rendering one centred layer per line.
3. **A broken automated patch.** An AI-generated shell edit chained a no-op Python heredoc with `||` before the real Node patch, so the patch silently never ran and the "fixed" render was identical. A second attempt then wrote a literal newline into a TypeScript string. Both were caught by checking output frames and the type-checker rather than trusting the "patched" message.
4. **Test runner failing on Windows.** Every suite failed with `Cannot read properties of undefined (reading 'config')`. Root cause: the shell's cwd used a lowercase drive (`d:`) while Node resolved `D:`, loading two copies of vitest. Fixed with `scripts/test.mjs`, which launches vitest from a normalised cwd.
