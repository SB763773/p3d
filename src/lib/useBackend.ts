import { useEffect, useState } from 'react';

/**
 * 当前真正在干活的后端是哪个。
 *
 * 前端不再靠猜：`/api/health` 的 `providerReport.active` 是服务端如实汇报的。
 * 这件事只影响文案（本地推理不该显示"预估 ¥2.0"），不影响业务逻辑。
 *
 * 拿不到就返回 null —— 纯静态托管时本来就没有 /api，界面按未知处理。
 */
export type BackendKind = 'mock' | 'local' | 'hunyuan' | 'fal' | string;

export function useBackend(): BackendKind | null {
  const [backend, setBackend] = useState<BackendKind | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch('/api/health')
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { provider?: string; providerReport?: { active?: string } } | null) => {
        if (cancelled) return;
        setBackend(data?.providerReport?.active ?? data?.provider ?? null);
      })
      .catch(() => {
        if (!cancelled) setBackend(null);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return backend;
}
