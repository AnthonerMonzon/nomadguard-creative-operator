import type { Job } from '../jobs/job.js';

/** Human-readable run report written next to final.mp4. */
export function renderReport(job: Job, providerName: string, llmName: string): string {
  const s = job.strategy!;
  const sel = job.selection!;
  const sb = job.storyboard!;
  const tq = job.qa?.technical;
  const cq = job.qa?.creative;
  const lines: string[] = [];
  const p = (x = '') => lines.push(x);

  p(`# ${job.brief.brand}: ${sb.title}`);
  p();
  p(`Job \`${job.id}\` · status **${job.status}** · verdict **${job.final?.verdict ?? 'n/a'}** · video: ${providerName} · LLM: ${llmName}`);
  p();
  p('## 1. Strategy');
  p();
  p('| # | Angle | Emotion | Hook | CTA | Hook | Fit | Feasible | Sound-off |');
  p('|---|---|---|---|---|---|---|---|---|');
  s.angles.forEach((a, i) => {
    const sc = sel.scores.find((x) => x.index === i);
    const mark = i === sel.selected_index ? ' ✅' : '';
    p(`| ${i}${mark} | ${a.name} | ${a.target_emotion} | ${a.hook} | ${a.cta} | ${sc?.hook_strength ?? ''} | ${sc?.brief_fit ?? ''} | ${sc?.ai_feasibility ?? ''} | ${sc?.sound_off_clarity ?? ''} |`);
  });
  p();
  p(`**Why selected:** ${sel.why_selected}`);
  p();
  p(`**Audience insight:** ${sel.audience_insight}`);
  p();
  p(`**Why it performs:** ${sel.why_it_performs}`);
  if (sel.risks.length) p(`\n**Risks:** ${sel.risks.join('; ')}`);
  p();
  p('## 2. Storyboard');
  p();
  p(`Style bible: ${Object.entries(sb.style_bible).map(([k, v]) => `**${k}**: ${v}`).join(' · ')}`);
  p();
  for (const sc of sb.scenes) {
    const sj = job.scenes.find((x) => x.sceneId === sc.id);
    p(`### Scene ${sc.id} (${sc.purpose}, ${sc.duration}s) · attempts: ${sj?.attempts ?? 0}`);
    p(`- ${sc.description}`);
    p(`- Camera: ${sc.camera}`);
    p(`- Overlay: "${sc.on_screen_text}"`);
    p(`- Prompt: \`${sc.video_prompt}\``);
    p();
  }
  p(`End card (${sb.end_card.duration}s): "${sb.end_card.headline}" / CTA "${sb.end_card.cta}"`);
  p();
  p('## 3. QA');
  p();
  if (tq) {
    p(`Technical: **${tq.valid ? 'PASS' : 'FAIL'}**`);
    for (const c of tq.checks) p(`- ${c.pass ? '✅' : '❌'} ${c.name}: ${c.detail}`);
    p();
  }
  if (cq) {
    p(`Creative (vision model): avg **${cq.average}** → **${cq.verdict}**${cq.reasons.length ? ` (${cq.reasons.join('; ')})` : ''}`);
    p();
    for (const [k, v] of Object.entries(cq.review.scores)) p(`- ${k}: ${v}/10. ${cq.review.rationale[k] ?? ''}`);
    if (cq.review.issues.length) {
      p();
      p('Issues:');
      for (const i of cq.review.issues) p(`- [${i.severity}] scene ${i.scene_id ?? '-'}: ${i.description}`);
    }
    p();
    p(`> ${cq.review.summary}`);
  } else if (job.qa?.creativeError) {
    p(`Creative QA unavailable: ${job.qa.creativeError}`);
  }
  p();
  return lines.join('\n');
}
