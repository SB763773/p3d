import { useState } from 'react';
import { downloadFile, formatBytes, formatRatio, formatYuan } from '@/lib/format';
import type { JobRecord } from '@/store/useJobStore';

interface JobResultProps {
  job: JobRecord;
  onAddToScene: (job: JobRecord) => void;
  onRegenerate: () => void;
  inScene: boolean;
  /** 简单模式下模型会自动替换进场景，"加入场景 / 再加一个"没有意义 */
  showSceneActions: boolean;
}

export function JobResult({
  job,
  onAddToScene,
  onRegenerate,
  inScene,
  showSceneActions,
}: JobResultProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    if (!job.glbUrl) return;
    setBusy(true);
    setError(null);
    try {
      await downloadFile(job.glbUrl, `p3d-${job.id}.glb`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '下载失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card border-emerald-200 bg-emerald-50/60 p-3.5">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-emerald-900">生成完成</p>
        <span className="rounded bg-white/70 px-1.5 py-0.5 text-[10px] text-emerald-700">
          {job.cached ? '命中缓存 · 未计费' : `本次约 ${formatYuan(job.costYuan)}`}
        </span>
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-zinc-600">
        <div className="flex justify-between">
          <dt>体积</dt>
          <dd className="font-mono">{formatBytes(job.sizeBytes)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>面数</dt>
          <dd className="font-mono">{job.faceCount ? job.faceCount.toLocaleString() : '—'}</dd>
        </div>
        <div className="col-span-2 flex justify-between">
          <dt>相对比例 高:宽:深</dt>
          <dd className="font-mono">{formatRatio(job.bbox)}</dd>
        </div>
      </dl>

      <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
        尺度已归一化为最长边 1.0，所以这里只有比例，没有绝对尺寸。
      </p>

      <div className="mt-2.5 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void download()}
          disabled={busy}
        >
          {busy ? '下载中…' : '下载 .glb'}
        </button>
        {showSceneActions ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onAddToScene(job)}
            title={inScene ? '同一个模型再摆一个（摆在旁边空位）' : '摆进场景，和别的模型一起看'}
          >
            {inScene ? '再加一个' : '加入场景'}
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost" onClick={onRegenerate}>
          重新生成
        </button>
      </div>

      {error ? <p className="mt-2 text-xs text-red-700">{error}</p> : null}
    </div>
  );
}
