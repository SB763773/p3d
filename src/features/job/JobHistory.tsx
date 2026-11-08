import { formatBytes, formatTime } from '@/lib/format';
import type { JobRecord } from '@/store/useJobStore';
import { useJobStore } from '@/store/useJobStore';

interface JobHistoryProps {
  onSelect: (job: JobRecord) => void;
}

const STATUS_DOT: Record<JobRecord['status'], string> = {
  queued: 'bg-zinc-300',
  running: 'bg-blue-500',
  succeeded: 'bg-emerald-500',
  failed: 'bg-red-500',
  timeout: 'bg-amber-500',
};

const STATUS_TEXT: Record<JobRecord['status'], string> = {
  queued: '排队',
  running: '生成中',
  succeeded: '完成',
  failed: '失败',
  timeout: '超时',
};

/** 本地历史（F-09）：最近 20 条，存在 localStorage，不上传任何服务器 */
export function JobHistory({ onSelect }: JobHistoryProps) {
  const jobs = useJobStore((state) => state.jobs);
  const activeId = useJobStore((state) => state.activeId);
  const remove = useJobStore((state) => state.remove);

  if (jobs.length === 0) {
    return (
      <div>
        <p className="label-xs mb-2">历史记录</p>
        <p className="rounded-lg border border-dashed border-zinc-200 px-3 py-6 text-center text-xs text-zinc-400">
          还没有生成过。完成第一次生成后，这里会保留最近 20 条记录。
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="label-xs">历史记录</p>
        <p className="text-[11px] text-zinc-400">{jobs.length} 条 · 仅本机</p>
      </div>
      <ul className="space-y-1">
        {jobs.map((job) => (
          <li key={job.id}>
            <div
              className={[
                'group flex items-center gap-2 rounded-lg border px-2 py-1.5 transition-colors',
                activeId === job.id
                  ? 'border-zinc-300 bg-white'
                  : 'border-transparent hover:border-zinc-200 hover:bg-white',
              ].join(' ')}
            >
              <button
                type="button"
                onClick={() => onSelect(job)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <span className="h-10 w-10 shrink-0 overflow-hidden rounded border border-zinc-200 bg-zinc-50">
                  {job.imageThumb ? (
                    <img src={job.imageThumb} alt="" className="h-full w-full object-cover" />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[job.status]}`} />
                    <span className="text-xs font-medium text-zinc-700">
                      {STATUS_TEXT[job.status]}
                    </span>
                    <span className="truncate text-[11px] text-zinc-400">
                      {job.options.quality}
                      {job.options.pbr ? ' · PBR' : ''}
                    </span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-2 text-[11px] text-zinc-400">
                    <span>{formatTime(job.createdAt)}</span>
                    {job.sizeBytes ? <span>{formatBytes(job.sizeBytes)}</span> : null}
                  </span>
                </span>
              </button>
              <button
                type="button"
                aria-label="删除这条记录"
                onClick={() => remove(job.id)}
                className="rounded px-1.5 py-0.5 text-xs text-zinc-400 opacity-0 transition-opacity hover:bg-zinc-100 hover:text-red-600 group-hover:opacity-100 focus:opacity-100"
              >
                ✕
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
