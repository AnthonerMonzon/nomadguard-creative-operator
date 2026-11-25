# NomadGuard: AI Creative Operator

A small pipeline that turns a marketing brief into a finished 9:16 social video ad:

```
brief.json ─► Strategy (4 angles) ─► Selection (scored + rationale) ─► Storyboard (rule-checked)
          ─► Prompt Builder (per model) ─► Video Provider (Veo, async, per scene) ─► Assembly (ffmpeg: captions + end card)
          ─► QA (technical: ffprobe/decode · creative: vision model) ─► final.mp4 + report.md
```

## Deliverables

| File | What |
|---|---|
| [`deliverables/nomadguard-final.mp4`](deliverables/nomadguard-final.mp4) | Final ad, "The Unshakable Traveler": 14.5s, 1080×1920 (9:16), H.264/AAC |
| [`deliverables/report.md`](deliverables/report.md) | Run report: all 4 angles with scores, selection rationale, storyboard + exact Veo prompts, QA results |
| [`deliverables/strategy.json`](deliverables/strategy.json), [`deliverables/storyboard.json`](deliverables/storyboard.json) | Raw structured output from the same run |

Produced by Gemini (strategy, storyboard, creative QA) and Veo 3.1 on Vertex AI (3 × 4s scenes), then assembled by the pipeline. Technical QA passes every check. Creative QA scored it 5.8/10 → `needs_review`: the vision model flagged hook strength and slight AI motion distortion on background figures in scene 1 (details in the report).

## Setup

Requires Node ≥ 20.12. ffmpeg/ffprobe ship as npm packages, so there is nothing else to install.

```bash
npm install
cp .env.example .env
```

| What | Why | How |
|---|---|---|
| `GEMINI_API_KEY` | strategy, storyboard, creative QA (free tier) | https://aistudio.google.com/apikey |
| `GOOGLE_CLOUD_PROJECT` | Veo on Vertex AI (Cloud trial credits) | create a project → enable billing/trial → `gcloud services enable aiplatform.googleapis.com` |
| Application Default Credentials | Veo auth | `gcloud auth application-default login` |

## Run

```bash
# Offline dry run: no keys, mock LLM + placeholder clips, still exercises real ffmpeg assembly and QA
npm run nomad -- run --llm mock --provider mock

# Real run: Gemini + Veo. Recommended: plan first, review storyboard.json, then pay for video
npm run nomad -- run --plan-only
npm run nomad -- resume <jobId>

npm run nomad -- reassemble <jobId>  # rebuild final.mp4 + QA from the existing clips, no new renders
npm run nomad -- status <jobId>      # state, per-scene attempts/errors, QA
npm run nomad -- list
npm test                             # 4 test files / 13 tests, ~40s
npm run typecheck                    # tsc --noEmit
```

`run` options:

| Flag | Default | Meaning |
|---|---|---|
| `--brief <path>` | `briefs/nomadguard.json` | Marketing brief to turn into an ad |
| `--llm gemini\|mock` | `gemini` | LLM for strategy, storyboard and creative QA |
| `--provider veo\|mock` | `veo` (or `VIDEO_PROVIDER`) | Video provider (`mock` renders placeholder clips locally) |
| `--angle N` | model's pick | Force creative angle N (0-based) instead of the selected one |
| `--plan-only` | off | Stop after strategy + storyboard; `resume <jobId>` approves and continues |

`resume` also retries a `FAILED` job: finished clips are kept and in-flight Veo renders are re-polled rather than resubmitted.

When approving a `--plan-only` job, `resume` picks up any edits made to `runs/<jobId>/storyboard.json`. The edited file is checked against the same schema and storyboard rules as model output; if it fails, the job stays `PLANNED` and nothing is paid for. Prompts are rebuilt for edited scenes unless `video_prompt` itself was hand-edited.

Each job lives in `runs/<jobId>/`: `job.json` (full state), `strategy.json`, `storyboard.json`, `clips/`, `frames/` (QA samples), `final.mp4`, `report.md`. `runs/` is git-ignored.

Optional tuning via `.env`: `VIDEO_MAX_ATTEMPTS`, `VIDEO_CONCURRENCY`, `VIDEO_POLL_INTERVAL_MS`, `VIDEO_TIMEOUT_MS`, `FONT_FILE` (see `.env.example`).

## Project layout

```
briefs/            input briefs (nomadguard.json)
deliverables/      final ad + run report from the real Gemini/Veo run
src/cli.ts         entry point: run / resume / reassemble / status / list
src/factory.ts     wires config → LLM client, video provider, job store
src/core/          config (env), typed PipelineError, logging, retry/backoff
src/domain/        zod schemas for brief, strategy, storyboard, QA
src/jobs/          job model + atomic file-based store
src/llm/           Gemini + mock clients, structured-output repair loop
src/pipeline/      planning, scene generation, orchestrator, report.md
src/prompts/       Veo prompt builder (style bible, negative prompt)
src/providers/     VideoProvider interface, Veo + mock implementations
src/media/         ffmpeg wrappers and final assembly
src/qa/            technical (hard gate) and creative (advisory) QA
tests/             vitest: structured output, scene lifecycle, technical QA, offline e2e
scripts/test.mjs   launches vitest from a normalised cwd (Windows drive-letter fix)
```

## Architecture

| Module | Responsibility |
|---|---|
| `pipeline/planning.ts` | Strategy → selection → storyboard prompts, plus the storyboard rules (10–15s total, model-supported clip lengths, hook first) |
| `llm/structured.ts` | JSON out, then **parse → zod schema → business rules**; violations go back to the model as a repair turn. Transport errors retried separately |
| `providers/VideoProvider.ts` | `generate() / getStatus() / getResult()` + `PromptBuilder`. `VeoProvider` (real) and `MockProvider` (offline). New provider = one class + one line in `factory.ts` |
| `pipeline/generateScenes.ts` | Per-scene async lifecycle: submit, poll, download, verify, retry with a new seed |
| `pipeline/orchestrator.ts` | Job state machine `CREATED → PLANNING → (PLANNED) → GENERATING → ASSEMBLING → EVALUATING → FINALIZED` / `FAILED`, checkpointed to disk |
| `media/assemble.ts` | Crops out letterbox bars baked into a clip, normalises clips to 1080×1920@30, burns in sound-off captions, renders the branded end card, encodes H.264/AAC with faststart |
| `qa/technical.ts`, `qa/creative.ts` | Hard gate (exists, decodes end to end, duration, resolution, 9:16, audio, black frames, baked-in letterbox) and advisory vision review |

## Key decisions

- **Gemini + Veo.** One SDK (`@google/genai`) covers LLM, vision QA and video. Veo 3.1 does native 9:16 with ambient audio and has the strongest photorealism I could access through an API. The Gemini free tier keeps LLM iteration at zero cost.
- **Dimensions aren't enough to trust a clip.** A real Veo 3.1 render came back as a correct 1080×1920 file with a letterboxed picture baked in. Technical QA now measures the actual picture area with `cropdetect` and fails on baked-in bars, and assembly crops them out before scaling to full-bleed 9:16.
- **Scenes are generated separately, then assembled by us.** This gives per-shot control, retries and a hook built on purpose. The cost is cross-shot consistency, mitigated by a **style bible** (protagonist, wardrobe, world, look) pasted verbatim into every prompt.
- **No text in AI footage.** Video models garble text and logos, so captions and the end card (brand, core message, CTA) are rendered with ffmpeg and are always pixel-perfect. The negative prompt bans text, logos and phone screens.
- **Feasibility is a selection criterion.** Angles are scored on `ai_feasibility` and `sound_off_clarity` as well as hook and brief fit. The best idea on paper is worthless if Veo can't render it.
- **Money-aware reliability.** The provider `jobRef` is persisted *before* polling, so a crash or timeout resumes the same paid render instead of resubmitting. 429/5xx errors are retried with backoff without spending an attempt. Filtered or bad clips get a new seed, up to 3 attempts. Non-retryable errors stop that scene only, and finished clips are always kept.
- **Human gate before spend.** `--plan-only` stops at the storyboard; `resume` approves it, including any validated edits to `storyboard.json`. `--angle N` overrides the model's choice. `reassemble` re-runs editing and QA on clips already paid for.
- **LLM calls time out.** Gemini requests have a 120s timeout that surfaces as a transient error, so an overloaded model triggers a retry with backoff instead of stalling the job.
- **QA: technical is a hard gate; creative is advisory.** The vision model only scores against an anchored rubric, and approve/needs-review is a deterministic threshold in code. An evaluator outage doesn't discard a valid video; it's marked `unevaluated`. Frames are sampled densely in the first 2.5s because the hook decides scroll-or-stay.
- **File-based job store** (atomic writes, serialised per job). Inspectable and zero infrastructure, which suits a single-operator tool.

## Trade-offs and what I intentionally did not build

- No queue, DB or web UI. A CLI plus `job.json` covers status and inspection; a polished frontend wasn't the point.
- No automatic regeneration loop from creative QA. Re-rendering on an LLM's opinion can burn credits in a loop, so QA flags `needs_review` with per-scene issues and a human decides.
- No music track or voiceover. Veo's ambient sound only (licensing, and lip-sync risk).
- One real provider (Veo). The interface and mock prove the seam; another provider would be one more adapter.
- Creative QA sees frames, not motion, so it can miss temporal artifacts (morphing mid-shot).

## With another day

1. **Character consistency**: generate one reference image of the protagonist (Imagen/Gemini image), then image-to-video or reference images for every scene.
2. **Targeted regeneration**: `regen <job> --scene 2` driven by creative-QA issues, with a cost budget per job.
3. **Video-native QA**: send the whole MP4 to Gemini (it accepts video) to catch motion artifacts; calibrate scores against a few human-rated ads.
4. Licensed music bed with beat-aligned cuts, and A/B variants (2–3 hooks on the same body) since that's how paid social is actually tested.
