import { create } from 'zustand';
import { findCacheHit } from '@/lib/hash';
import type { JobStage, JobStatus } from '@/lib/jobMachine';
import { canTransition, projectProgress } from '@/lib/jobMachine';
import { getProvider } from '@/lib/providers';
import type { GenOptions } from '@/lib/providers/types';
import { ERROR_CODES, ProviderError } from '@/lib/providers/types';

export interface JobError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface JobRecord {
  id: string;
  createdAt: number;
  status: JobStatus;
  stage: JobStage;
  progress: number;
  provider: string;
  providerJobId: string | null;
  options: GenOptions;
  imageHash: string;
  /** 用于重试与历史回看；过大时持久化阶段会被丢弃 */
  imageDataUrl: string;
  imageThumb: string;
  glbUrl: string | null;
  sizeBytes: number;
  faceCount: number;
  bbox: [number, number, number] | null;
  error: JobError | null;
  costYuan: number;
  /** 命中去重缓存，未产生上游费用 */
  cached: boolean;
}

interface SubmitPayload {
  imageDataUrl: string;
  imageThumb: string;
  imageHash: string;
  options: GenOptions;
}

interface JobState {
  jobs: JobRecord[];
  activeId: string | null;
  submitting: boolean;
  activeJob: () => JobRecord | null;
  submit: (payload: SubmitPayload) => Promise<void>;
  retry: (id: string) => Promise<void>;
  remove: (id: string) => void;
  select: (id: string | null) => void;
  /** 查看器量出真实包围盒后回填（按 GLB 地址匹配任务），UI 用它显示相对比例 */
  reportMeasured: (assetKey: string, bbox: [number, number, number], faceCount: number) => void;
}

const STORAGE_KEY = 'p3d:jobs:v1';
const HISTORY_LIMIT = 20;
/** localStorage 约 5 MB，给原图 dataURL 留的预算 */
const PERSIST_IMAGE_BUDGET = 2_800_000;

const initialJobs = loadJobs();

let seq = 0;
function newId(): string {
  seq += 1;
  return `job_${Date.now().toString(36)}_${seq.toString(36)}`;
}

export const useJobStore = create<JobState>((set, get) => ({
  jobs: initialJobs,
  activeId: initialJobs[0]?.id ?? null,
  submitting: false,

  activeJob: () => {
    const { jobs, activeId } = get();
    return jobs.find((job) => job.id === activeId) ?? null;
  },

  submit: async (payload) => {
    const provider = getProvider();

    // 去重即省钱（方案 §6.3）：同一张图 + 同一组参数，直接复用已有结果，零成本秒回
    const cached = findCacheHit(get().jobs, payload.imageHash, payload.options);

    const id = newId();
    const base: JobRecord = {
      id,
      createdAt: Date.now(),
      status: 'queued',
      stage: 'queued',
      progress: 0,
      provider: provider.name,
      providerJobId: null,
      options: payload.options,
      imageHash: payload.imageHash,
      imageDataUrl: payload.imageDataUrl,
      imageThumb: payload.imageThumb,
      glbUrl: null,
      sizeBytes: 0,
      faceCount: 0,
      bbox: null,
      error: null,
      costYuan: 0,
      cached: false,
    };

    if (cached) {
      const reused: JobRecord = {
        ...base,
        status: 'succeeded',
        stage: 'download',
        progress: 1,
        glbUrl: cached.glbUrl,
        sizeBytes: cached.sizeBytes,
        faceCount: cached.faceCount,
        bbox: cached.bbox,
        cached: true,
        costYuan: 0,
      };
      set((state) => ({
        jobs: [reused, ...state.jobs].slice(0, HISTORY_LIMIT),
        activeId: id,
      }));
      persist(get().jobs);
      return;
    }

    set((state) => ({
      jobs: [base, ...state.jobs].slice(0, HISTORY_LIMIT),
      activeId: id,
      submitting: true,
    }));

    try {
      const { providerJobId } = await provider.submit({
        imageDataUrl: payload.imageDataUrl,
        mimeType: payload.imageDataUrl.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png',
        options: payload.options,
        imageHash: payload.imageHash,
      });

      patch(id, {
        providerJobId,
        status: 'running',
        stage: 'queued',
      });
      startPolling(id);
    } catch (error) {
      // 带错误码的异常优先：限流/额度这类错误不该给"重试"按钮
      const failure =
        error instanceof ProviderError
          ? { code: error.code, message: error.message, retryable: error.retryable }
          : {
              code: ERROR_CODES.UPSTREAM_ERROR,
              message: error instanceof Error ? error.message : '提交失败',
              retryable: true,
            };
      patch(id, { status: 'failed', error: failure });
      set({ submitting: false });
      persist(get().jobs);
    }
  },

  retry: async (id) => {
    const job = get().jobs.find((item) => item.id === id);
    if (!job) return;
    await get().submit({
      imageDataUrl: job.imageDataUrl,
      imageThumb: job.imageThumb,
      imageHash: job.imageHash,
      options: job.options,
    });
  },

  remove: (id) => {
    stopPolling(id);
    set((state) => {
      const jobs = state.jobs.filter((job) => job.id !== id);
      return {
        jobs,
        activeId: state.activeId === id ? (jobs[0]?.id ?? null) : state.activeId,
      };
    });
    persist(get().jobs);
  },

  select: (id) => set({ activeId: id }),

  reportMeasured: (assetKey, bbox, faceCount) => {
    if (!assetKey) return;
    const targets = get().jobs.filter((item) => item.glbUrl === assetKey);
    if (targets.length === 0) return;
    if (targets.every((item) => item.bbox && item.faceCount === faceCount)) return;
    set((state) => ({
      jobs: state.jobs.map((item) =>
        item.glbUrl === assetKey ? { ...item, bbox, faceCount: faceCount || item.faceCount } : item,
      ),
    }));
  },
}));

// ─────────────────────────────────────────────────────────────
// 轮询
// ─────────────────────────────────────────────────────────────

const timers = new Map<string, ReturnType<typeof setInterval>>();
const deadlines = new Map<string, number>();
/** 超时上限：上游可能还在跑，所以只标 timeout，不判死（方案 §6.1） */
const TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 600;

function startPolling(id: string) {
  stopPolling(id);
  deadlines.set(id, Date.now() + TIMEOUT_MS);

  const timer = setInterval(async () => {
    const job = useJobStore.getState().jobs.find((item) => item.id === id);
    if (!job?.providerJobId) return stopPolling(id);
    if (job.status === 'succeeded' || job.status === 'failed') return stopPolling(id);

    if (Date.now() > (deadlines.get(id) ?? 0)) {
      patch(id, { status: 'timeout', error: timeoutError() });
      stopPolling(id);
      persist(useJobStore.getState().jobs);
      return;
    }

    try {
      const provider = getProvider();
      const status = await provider.query(job.providerJobId);

      if (status.state === 'pending') {
        const stage = status.stage ?? job.stage;
        const next = projectProgress({ status: 'running', stage, raw: status.progress });
        patch(id, {
          status: 'running',
          stage,
          // 进度只增不减，避免上游抖动导致进度条倒退
          progress: Math.max(job.progress, next),
        });
        return;
      }

      if (status.state === 'failed') {
        patch(id, {
          status: 'failed',
          error: { code: status.code, message: status.message, retryable: status.retryable },
          progress: job.progress,
        });
        stopPolling(id);
        persist(useJobStore.getState().jobs);
        return;
      }

      // succeeded
      if (!canTransition(job.status, 'succeeded')) return stopPolling(id);
      patch(id, {
        status: 'succeeded',
        stage: 'download',
        progress: 1,
        glbUrl: status.glbUrl,
        sizeBytes: status.sizeBytes ?? 0,
        // 服务端结算过就以服务端为准
        costYuan: job.cached
          ? 0
          : (status.costYuan ?? provider.capabilities.estimateCostYuan(job.options)),
      });
      stopPolling(id);
      useJobStore.setState({ submitting: false });
      persist(useJobStore.getState().jobs);
    } catch (error) {
      const message = error instanceof Error ? error.message : '查询任务失败';
      patch(id, {
        status: 'failed',
        error: { code: ERROR_CODES.UPSTREAM_ERROR, message, retryable: true },
      });
      stopPolling(id);
      persist(useJobStore.getState().jobs);
    }
  }, POLL_INTERVAL_MS);

  timers.set(id, timer);
}

function stopPolling(id: string) {
  const timer = timers.get(id);
  if (timer) {
    clearInterval(timer);
    timers.delete(id);
  }
}

function timeoutError(): JobError {
  return {
    code: ERROR_CODES.TIMEOUT,
    message: '等待超过 120 秒仍未完成。上游可能还在生成，可以稍后再试或降低质量档位。',
    retryable: true,
  };
}

function patch(id: string, delta: Partial<JobRecord>) {
  useJobStore.setState((state) => ({
    jobs: state.jobs.map((job) => (job.id === id ? { ...job, ...delta } : job)),
  }));
}

// ─────────────────────────────────────────────────────────────
// 持久化：只留最近 20 条，原图按预算保留
// ─────────────────────────────────────────────────────────────

interface PersistedJob extends Omit<JobRecord, 'imageDataUrl'> {
  imageDataUrl: string | null;
}

function persist(jobs: JobRecord[]) {
  if (typeof localStorage === 'undefined') return;
  try {
    let budget = PERSIST_IMAGE_BUDGET;
    const trimmed: PersistedJob[] = jobs.slice(0, HISTORY_LIMIT).map((job) => {
      const keepImage = job.imageDataUrl.length <= budget;
      if (keepImage) budget -= job.imageDataUrl.length;
      return { ...job, imageDataUrl: keepImage ? job.imageDataUrl : null };
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, jobs: trimmed }));
  } catch {
    // 配额满了就只留元数据，不能让持久化把应用搞崩
    try {
      const slim = jobs.slice(0, HISTORY_LIMIT).map((job) => ({ ...job, imageDataUrl: null }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, jobs: slim }));
    } catch {
      /* 忽略 */
    }
  }
}

function loadJobs(): JobRecord[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { version?: number; jobs?: PersistedJob[] };
    if (!Array.isArray(parsed.jobs)) return [];

    return parsed.jobs
      .filter((job) => job && typeof job.id === 'string')
      .map((job) => ({
        ...job,
        imageDataUrl: job.imageDataUrl ?? '',
        // 刷新后不该继续显示"生成中"——浏览器关了，轮询也没了
        status: job.status === 'running' || job.status === 'queued' ? 'failed' : job.status,
        error:
          job.status === 'running' || job.status === 'queued'
            ? {
                code: ERROR_CODES.TIMEOUT,
                message: '页面刷新导致任务中断，需要重新生成',
                retryable: job.imageDataUrl !== null,
              }
            : job.error,
      })) satisfies JobRecord[];
  } catch {
    return [];
  }
}
