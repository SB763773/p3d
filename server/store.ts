import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ServerJob } from './types.ts';

/**
 * 任务存储。
 *
 * 现在落本地 JSON 文件，是因为这台机器没有 D1 / R2，而且项目还没有云账号。
 * 接口刻意做成"读写 + 按天统计"这几个动作，之后换 D1 只需照着重写一个同名实现。
 *
 * 两个必须处理对的点：
 * 1. 原子写：先写 .tmp 再 rename，否则进程被杀会留下半截 JSON，下次启动全崩。
 * 2. 写串行化：多个请求同时落库时，后写的不能覆盖先写的，用 promise 链排队。
 */
export class JobStore {
  filePath: string;
  /** 最多保留多少条历史，避免文件无限膨胀 */
  maxJobs: number;

  private jobs = new Map<string, ServerJob>();
  private ready: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string, maxJobs = 500) {
    this.filePath = filePath;
    this.maxJobs = maxJobs;
  }

  init(): Promise<void> {
    if (!this.ready) this.ready = this.load();
    return this.ready;
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as { jobs?: ServerJob[] };
      for (const job of parsed.jobs ?? []) {
        if (job && typeof job.id === 'string') this.jobs.set(job.id, job);
      }
    } catch {
      // 文件不存在 / 内容损坏都当作空库，不能让启动失败
    }
  }

  list(): ServerJob[] {
    return [...this.jobs.values()];
  }

  get(id: string): ServerJob | undefined {
    return this.jobs.get(id);
  }

  async put(job: ServerJob): Promise<void> {
    this.jobs.set(job.id, job);
    this.prune();
    await this.flush();
  }

  async remove(id: string): Promise<boolean> {
    const existed = this.jobs.delete(id);
    if (existed) await this.flush();
    return existed;
  }

  private prune(): void {
    if (this.jobs.size <= this.maxJobs) return;
    const sorted = this.list().sort((a, b) => a.createdAt - b.createdAt);
    const overflow = sorted.slice(0, this.jobs.size - this.maxJobs);
    for (const job of overflow) this.jobs.delete(job.id);
  }

  private flush(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const payload = JSON.stringify({ version: 1, jobs: this.list() }, null, 0);
      const temporary = `${this.filePath}.tmp`;
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(temporary, payload, 'utf8');
      await rename(temporary, this.filePath);
    });
    return this.writeChain;
  }
}
