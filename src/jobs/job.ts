import type { Brief, Selection, Storyboard, Strategy, TechnicalReport } from '../domain/schemas.js';
import { PipelineError } from '../core/errors.js';
import type { CreativeQaResult } from '../qa/creative.js';

export type JobStatus = 'CREATED' | 'PLANNING' | 'PLANNED' | 'GENERATING' | 'ASSEMBLING' | 'EVALUATING' | 'FINALIZED' | 'FAILED';
export type SceneStatus = 'PENDING' | 'SUBMITTED' | 'SUCCEEDED' | 'FAILED';

export interface SceneJob {
  sceneId: number;
  status: SceneStatus;
  /** Provider handle for the in-flight generation. Persisted so a resume re-polls instead of re-paying. */
  jobRef?: string;
  attempts: number;
  clip?: string; // relative to job dir
  lastError?: ReturnType<PipelineError['toJSON']>;
  submittedAt?: string;
  completedAt?: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  options: { provider: string; llm: string; planOnly: boolean; angleOverride?: number };
  brief: Brief;
  // Checkpoints: each stage writes its output here; a resumed job skips stages whose output exists.
  strategy?: Strategy;
  selection?: Selection;
  storyboard?: Storyboard;
  scenes: SceneJob[];
  assembled?: string;
  qa?: { technical: TechnicalReport; creative?: Omit<CreativeQaResult, 'frames'>; creativeError?: string };
  final?: { video: string; report: string; verdict: 'approved' | 'needs_review' | 'unevaluated' };
  error?: ReturnType<PipelineError['toJSON']> & { stage: JobStatus };
  history: { status: JobStatus; at: string; note?: string }[];
}

const ALLOWED: Record<JobStatus, JobStatus[]> = {
  CREATED: ['PLANNING'],
  PLANNING: ['PLANNED', 'GENERATING'],
  PLANNED: ['GENERATING'], // human approval gate (--plan-only, then `resume`)
  GENERATING: ['ASSEMBLING'],
  ASSEMBLING: ['EVALUATING'],
  EVALUATING: ['FINALIZED'],
  FINALIZED: ['ASSEMBLING'], // `reassemble`: rebuild the ad from the kept clips, no new renders
  FAILED: ['PLANNING', 'GENERATING', 'ASSEMBLING', 'EVALUATING'], // resume re-enters at the failed stage
};

export function transition(job: Job, to: JobStatus, note?: string): void {
  if (to !== 'FAILED' && !ALLOWED[job.status].includes(to)) {
    throw new PipelineError('INVALID_REQUEST', `illegal job transition ${job.status} -> ${to}`);
  }
  if (to === 'FAILED' && job.status === 'FINALIZED') throw new PipelineError('INVALID_REQUEST', 'cannot fail a finalized job');
  job.status = to;
  job.updatedAt = new Date().toISOString();
  job.history.push({ status: to, at: job.updatedAt, note });
}
