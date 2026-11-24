import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PipelineError } from '../core/errors.js';
import type { Brief } from '../domain/schemas.js';
import type { Job } from './job.js';

/**
 * One directory per job: runs/<id>/job.json plus clips, frames and the final MP4.
 * Writes are atomic (tmp + rename) and serialised per job, because scenes complete concurrently.
 * Deliberately not a database: a single-operator tool needs inspectable state, not infrastructure.
 */
export class JobStore {
  private queues = new Map<string, Promise<void>>();

  constructor(readonly root: string) {}

  dir(id: string): string {
    return path.join(this.root, id);
  }

  async create(brief: Brief, options: Job['options']): Promise<Job> {
    const now = new Date();
    const id = `${now.toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1-')}-${randomBytes(2).toString('hex')}`;
    const job: Job = {
      id,
      status: 'CREATED',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      options,
      brief,
      scenes: [],
      history: [{ status: 'CREATED', at: now.toISOString() }],
    };
    await mkdir(this.dir(id), { recursive: true });
    await this.save(job);
    return job;
  }

  save(job: Job): Promise<void> {
    const prev = this.queues.get(job.id) ?? Promise.resolve();
    const next = prev.then(async () => {
      const file = path.join(this.dir(job.id), 'job.json');
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(job, null, 2));
      await rename(tmp, file);
    });
    this.queues.set(job.id, next.catch(() => {}));
    return next;
  }

  async load(id: string): Promise<Job> {
    try {
      return JSON.parse(await readFile(path.join(this.dir(id), 'job.json'), 'utf8')) as Job;
    } catch (e) {
      throw new PipelineError('INVALID_REQUEST', `job ${id} not found in ${this.root}`, { cause: e });
    }
  }

  async list(): Promise<Job[]> {
    let ids: string[] = [];
    try {
      ids = await readdir(this.root);
    } catch {
      return [];
    }
    const jobs = await Promise.all(ids.map((id) => this.load(id).catch(() => null)));
    return jobs.filter((j): j is Job => !!j).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
