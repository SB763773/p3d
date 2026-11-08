import { STAGE_LABEL } from '@/lib/jobMachine';
import type { JobRecord } from '@/store/useJobStore';

interface JobProgressProps {
  job: JobRecord;
  onRetry: () => void;
  onPickAnother: () => void;
}

/**
 * 任务态 UI。
 *
 * 三条硬规则（方案 §6.1）：
 * 1. 只认 status，不做时间推断。
 * 2. 不可重试的错误不给重试按钮，避免用户白点。
 * 3. 超时 ≠ 失败，要说明"上游可能还在跑"。
 */
export function JobProgress({ job, onRetry, onPickAnother }: JobProgressProps) {
  const isRunning = job.status === 'queued' || job.status === 'running';
  const percent = Math.round(job.progress * 100);

  if (isRunning) {
    return (
      <div className="card p-3.5">
        <div className="mb-2 flex items-baseline justify-between">
          <p className="text-sm font-medium text-zinc-800">
            {job.status === 'queued' ? '已提交，排队中' : STAGE_LABEL[job.stage]}
          </p>
          <p className="font-mono text-xs text-zinc-500">{percent}%</p>
        </div>
        <div
          className="h-1.5 overflow-hidden rounded-full bg-zinc-100"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-zinc-900 transition-[width] duration-300 ease-out"
            style={{ width: `${Math.max(3, percent)}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          {job.provider === 'mock' || job.provider === 'server'
            ? '流程是真的，模型是预置的：当前后端没有接真实生成服务。'
            : '生成中，请勿关闭页面。'}
        </p>
      </div>
    );
  }

  if (job.status === 'timeout') {
    return (
      <div className="card border-amber-200 bg-amber-50 p-3.5">
        <p className="text-sm font-medium text-amber-900">等待超时</p>
        <p className="mt-1 text-xs leading-relaxed text-amber-800">
          {job.error?.message ?? '超过 120 秒没有结果。'}
        </p>
        <button type="button" className="btn btn-ghost mt-2.5" onClick={onRetry}>
          用同样参数再试一次
        </button>
      </div>
    );
  }

  if (job.status === 'failed') {
    return (
      <div className="card border-red-200 bg-red-50 p-3.5">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium text-red-900">生成失败</p>
          <span className="rounded bg-red-100 px-1.5 py-0.5 font-mono text-[10px] text-red-700">
            {job.error?.code ?? 'UNKNOWN'}
          </span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-red-800">
          {job.error?.message ?? '上游返回了未知错误。'}
        </p>
        {job.error?.retryable ? (
          <div className="mt-2.5 flex gap-2">
            <button type="button" className="btn btn-primary" onClick={onRetry}>
              重试
            </button>
            <button type="button" className="btn btn-ghost" onClick={onPickAnother}>
              换张图
            </button>
          </div>
        ) : (
          <p className="mt-2 text-xs text-red-700">
            这类错误重试也没用（比如内容不合规或后端未接入），换一张图更实际。
          </p>
        )}
      </div>
    );
  }

  return null;
}
