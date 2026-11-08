import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { JobHistory } from '@/features/job/JobHistory';
import { JobProgress } from '@/features/job/JobProgress';
import { JobResult } from '@/features/job/JobResult';
import { UploadDropzone } from '@/features/upload/UploadDropzone';
import { useUploader } from '@/features/upload/useUploader';
import { ScenePanel } from '@/features/viewer/ScenePanel';
import { useSceneHotkeys } from '@/features/viewer/useSceneHotkeys';
import { ViewerToolbar } from '@/features/viewer/ViewerToolbar';
import { classifyDevice, detectDeviceSignals, renderProfileFor } from '@/lib/deviceTier';
import { makeThumbnail } from '@/lib/format';
import { QUALITY_LABEL } from '@/lib/jobMachine';
import { getProvider } from '@/lib/providers';
import type { GenOptions, QualityTier } from '@/lib/providers/types';
import { createSampleImageFile } from '@/lib/sampleImage';
import type { UiMode } from '@/lib/uiMode';
import { resolveSceneAction, UI_MODE_HINT, UI_MODE_LABEL } from '@/lib/uiMode';
import { useBackend } from '@/lib/useBackend';
import { useJobStore } from '@/store/useJobStore';
import { useSceneStore } from '@/store/useSceneStore';
import { useUiStore } from '@/store/useUiStore';

// three.js 那一坨体积很大，懒加载让它不拖累首屏（§3.3 A-01）
const SceneCanvas = lazy(() =>
  import('@/features/viewer/SceneCanvas').then((mod) => ({ default: mod.SceneCanvas })),
);

const FACE_OPTIONS = [
  { value: 0, label: '由后端决定' },
  { value: 20_000, label: '2 万面（轻）' },
  { value: 30_000, label: '3 万面（标准）' },
  { value: 60_000, label: '6 万面（重）' },
];

export function App() {
  useSceneHotkeys();
  const uploader = useUploader();
  const jobs = useJobStore((state) => state.jobs);
  const activeId = useJobStore((state) => state.activeId);
  const submit = useJobStore((state) => state.submit);
  const select = useJobStore((state) => state.select);
  const retry = useJobStore((state) => state.retry);
  const reportMeasured = useJobStore((state) => state.reportMeasured);
  const objects = useSceneStore((state) => state.objects);
  const addObject = useSceneStore((state) => state.addObject);
  const selectObject = useSceneStore((state) => state.selectObject);
  const clearScene = useSceneStore((state) => state.clearScene);

  const uiMode = useUiStore((state) => state.mode);
  const setUiMode = useUiStore((state) => state.setMode);
  // 简单模式：只留"选图 → 选档位 → 生成 → 下载"
  const simple = uiMode === 'simple';

  const [options, setOptions] = useState<GenOptions>({
    quality: 'standard',
    pbr: true,
    faceCount: 30_000,
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [sampleBusy, setSampleBusy] = useState(false);

  const provider = useMemo(() => getProvider(), []);
  const backend = useBackend();
  const profile = useMemo(() => renderProfileFor(classifyDevice(detectDeviceSignals())), []);

  const activeJob = jobs.find((job) => job.id === activeId) ?? null;
  const inSceneKeys = useMemo(() => new Set(objects.map((object) => object.assetKey)), [objects]);

  /** 场景里的模型按序号命名，比用任务 id 后缀好认 */
  const nextLabel = useCallback(
    () => `模型 ${String(useSceneStore.getState().objects.length + 1).padStart(2, '0')}`,
    [],
  );

  /**
   * 把模型摆进场景。
   *
   * 去重缓存的坑：同图同参数再生成会命中缓存拿到同一个 glbUrl，
   * 如果按"任务 id"判断，场景里就会出现两个一模一样的模型。
   *
   * 简单模式下新模型**替换**旧的，而不是并排再摆一个 ——
   * 否则"再生成一次"会堆出三四个一样的模型，还得手动删。
   */
  const placeModel = useCallback(
    (glbUrl: string) => {
      const current = useSceneStore.getState().objects;
      const action = resolveSceneAction({
        mode: uiMode,
        assetKey: glbUrl,
        existing: current.map((item) => item.assetKey),
      });
      if (action === 'skip') {
        selectObject(null);
        return;
      }
      if (action === 'replace') clearScene();
      addObject({ assetKey: glbUrl, label: nextLabel() });
    },
    [addObject, clearScene, nextLabel, selectObject, uiMode],
  );

  // 生成成功自动进场景 —— 少一次点击，用户马上看到东西。
  // 只认"任务 id 第一次成功"：否则切一下界面模式，placeModel 换了引用、
  // effect 重跑，场景里就凭空多出一个一模一样的模型。
  const placedJobRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeJob?.status !== 'succeeded' || !activeJob.glbUrl) return;
    if (placedJobRef.current === activeJob.id) return;
    placedJobRef.current = activeJob.id;
    placeModel(activeJob.glbUrl);
    // 窄屏是上下布局，画布在侧栏下方；不平移过去的话用户会以为"点了没反应"
    if (window.innerWidth < 1024) {
      document.querySelector('main')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [activeJob, placeModel]);

  const canGenerate =
    Boolean(uploader.result) && uploader.status === 'ready' && activeJob?.status !== 'running';

  const generate = async () => {
    const result = uploader.result;
    if (!result) return;
    setNotice(null);
    const thumb = await makeThumbnail(result.dataUrl);
    await submit({
      imageDataUrl: result.dataUrl,
      imageThumb: thumb,
      imageHash: result.hash,
      options,
    });
  };

  const trySample = async () => {
    setSampleBusy(true);
    try {
      const file = await createSampleImageFile();
      await uploader.accept(file);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : '示例图生成失败');
    } finally {
      setSampleBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-zinc-50">
      <header className="flex shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-4 py-2.5">
        <div className="flex items-baseline gap-2.5">
          <span className="text-base font-semibold tracking-tight text-zinc-900">p3d</span>
          <span className="hidden text-xs text-zinc-500 sm:inline">
            图片 → 3D 场景 · Photo to 3D
          </span>
        </div>
        <div className="flex items-center gap-2">
          <fieldset className="flex items-center rounded-full bg-zinc-100 p-0.5">
            <legend className="sr-only">界面模式</legend>
            {(['simple', 'pro'] as UiMode[]).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={uiMode === value}
                onClick={() => setUiMode(value)}
                title={UI_MODE_HINT[value]}
                className={[
                  'rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors',
                  uiMode === value
                    ? 'bg-white text-zinc-900 shadow-sm'
                    : 'text-zinc-500 hover:text-zinc-800',
                ].join(' ')}
              >
                {UI_MODE_LABEL[value]}
              </button>
            ))}
          </fieldset>
          <span
            className="hidden rounded-full bg-zinc-100 px-2.5 py-1 text-[11px] font-medium text-zinc-600 sm:inline"
            title={`P3D_PROVIDER=${provider.name}`}
          >
            后端：{provider.label}
          </span>
          <span className="hidden rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-700 sm:inline">
            生成结果是草稿，不保证还原真实尺寸
          </span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="w-full shrink-0 overflow-y-auto border-b border-zinc-200 bg-white p-4 lg:h-full lg:w-[380px] lg:border-b-0 lg:border-r">
          <div className="space-y-5">
            <section>
              <div className="mb-2 flex items-center justify-between">
                <p className="label-xs">1 · 选一张图</p>
                <button
                  type="button"
                  onClick={() => void trySample()}
                  disabled={sampleBusy}
                  className="text-[11px] text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline disabled:opacity-50"
                >
                  {sampleBusy ? '准备中…' : '没有图？用示例图'}
                </button>
              </div>
              <UploadDropzone uploader={uploader} />
            </section>

            <section>
              <p className="label-xs mb-2">2 · 生成参数</p>
              <div className="space-y-2.5">
                <div className="flex flex-col gap-1">
                  {(['draft', 'standard', 'high'] as QualityTier[]).map((tier) => (
                    <label
                      key={tier}
                      className={[
                        'flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors',
                        options.quality === tier
                          ? 'border-zinc-900 bg-zinc-50 text-zinc-900'
                          : 'border-zinc-200 text-zinc-600 hover:border-zinc-300',
                      ].join(' ')}
                    >
                      <input
                        type="radio"
                        name="quality"
                        className="h-3 w-3"
                        checked={options.quality === tier}
                        onChange={() => setOptions((prev) => ({ ...prev, quality: tier }))}
                      />
                      {QUALITY_LABEL[tier]}
                    </label>
                  ))}
                </div>

                {/* PBR 与面数是"调效果"用的，简单模式不暴露 */}
                {simple ? null : (
                  <>
                    <label className="flex items-center gap-2 text-xs text-zinc-600">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 rounded border-zinc-300"
                        checked={options.pbr}
                        disabled={!provider.capabilities.pbr}
                        onChange={(event) =>
                          setOptions((prev) => ({ ...prev, pbr: event.target.checked }))
                        }
                      />
                      生成 PBR 材质
                      {!provider.capabilities.pbr ? (
                        <span className="text-zinc-400">（当前后端不支持）</span>
                      ) : null}
                    </label>

                    <label className="flex items-center justify-between gap-2 text-xs text-zinc-600">
                      面数
                      <select
                        className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 disabled:bg-zinc-50 disabled:text-zinc-400"
                        value={provider.capabilities.faceCount ? (options.faceCount ?? 0) : 0}
                        disabled={!provider.capabilities.faceCount}
                        onChange={(event) =>
                          setOptions((prev) => ({ ...prev, faceCount: Number(event.target.value) }))
                        }
                      >
                        {FACE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}

                <p className="text-[11px] text-zinc-400">
                  {backend === 'local'
                    ? '本地推理 · 跑在本机显卡上，不产生费用'
                    : backend === 'mock'
                      ? '预估成本约 ¥' +
                        provider.capabilities.estimateCostYuan(options).toFixed(1) +
                        '（mock 不产生真实费用）'
                      : '预估成本约 ¥' +
                        provider.capabilities.estimateCostYuan(options).toFixed(1) +
                        '（以实际结算为准）'}
                </p>

                <button
                  type="button"
                  className="btn btn-primary w-full py-2.5"
                  disabled={!canGenerate}
                  onClick={() => void generate()}
                >
                  {activeJob?.status === 'running' ? '生成中…' : '开始生成 3D 模型'}
                </button>
              </div>
            </section>

            {activeJob ? (
              <section className="space-y-2">
                <p className="label-xs">
                  3 · 当前任务
                  <span className="ml-2 font-mono font-normal normal-case text-zinc-400">
                    {activeJob.id}
                  </span>
                </p>
                {activeJob.status === 'succeeded' && activeJob.glbUrl ? (
                  <JobResult
                    job={activeJob}
                    inScene={inSceneKeys.has(activeJob.glbUrl)}
                    showSceneActions={!simple}
                    onAddToScene={(job) => {
                      if (!job.glbUrl) return;
                      placeModel(job.glbUrl);
                    }}
                    onRegenerate={() => {
                      uploader.reset();
                      setNotice(null);
                    }}
                  />
                ) : (
                  <JobProgress
                    job={activeJob}
                    onRetry={() => void retry(activeJob.id)}
                    onPickAnother={() => uploader.reset()}
                  />
                )}
              </section>
            ) : null}

            {simple ? (
              <p className="text-[11px] leading-relaxed text-zinc-400">
                想在一个场景里摆多个模型、拖动位置、开关网格？把右上角切成「完整」。
              </p>
            ) : null}

            {/* 场景对象列表与历史记录属于"摆场景"那一层，简单模式收起 */}
            {simple ? null : (
              <>
                <ScenePanel />

                <JobHistory
                  onSelect={(job) => {
                    select(job.id);
                    if (job.glbUrl) placeModel(job.glbUrl);
                  }}
                />

                <section className="rounded-lg bg-zinc-50 p-3">
                  <p className="text-[11px] leading-relaxed text-zinc-500">
                    单图转 3D 是<b className="text-zinc-700">推测</b>而不是提取：照片里没有背面、
                    底面和内部结构，模型只能靠先验去猜。所以常见物体效果好，冷门物件会崩 ——
                    这不是工具坏了，是输入里真的没有那些信息。
                  </p>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-400">
                    去背景在浏览器本地完成，原图不出设备；历史记录只存本机。
                  </p>
                </section>
              </>
            )}
          </div>
        </aside>

        <main className="relative min-h-[420px] flex-1 lg:min-h-0">
          <Suspense
            fallback={
              <div className="absolute inset-0 grid place-items-center">
                <div className="shimmer h-24 w-40 rounded-xl" />
              </div>
            }
          >
            <SceneCanvas onMeasured={reportMeasured} onError={(message) => setNotice(message)} />
          </Suspense>
          <ViewerToolbar />

          {objects.length === 0 ? (
            <div className="pointer-events-none absolute inset-0 grid place-items-center p-6">
              <div className="rounded-xl border-2 border-dashed border-zinc-300 bg-white/70 px-6 py-8 text-center backdrop-blur-sm">
                <p className="text-sm font-medium text-zinc-700">场景是空的</p>
                <p className="mt-1 text-xs text-zinc-500">
                  左侧上传一张图并生成，或点上方「没有图？用示例图」
                </p>
              </div>
            </div>
          ) : null}

          <div className="pointer-events-none absolute bottom-3 left-3 flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-1.5">
              {simple ? null : (
                <>
                  <span className="rounded-full bg-white/90 px-2 py-0.5 text-[10px] text-zinc-600 shadow-sm">
                    {profile.tierLabel}
                  </span>
                  <span className="rounded-full bg-white/90 px-2 py-0.5 text-[10px] text-zinc-600 shadow-sm">
                    场景内 {objects.length} 个模型
                  </span>
                </>
              )}
              <span className="rounded-full bg-amber-50/95 px-2 py-0.5 text-[10px] text-amber-700 shadow-sm">
                背面与底面是推测的
              </span>
            </div>
            {notice ? (
              <p className="max-w-sm rounded-lg bg-red-50/95 px-2.5 py-1.5 text-[11px] text-red-700 shadow-sm">
                {notice}
              </p>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}
