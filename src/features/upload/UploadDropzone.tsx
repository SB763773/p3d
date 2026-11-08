import { useCallback, useEffect, useRef, useState } from 'react';
import type { UploaderState } from '@/features/upload/useUploader';
import { formatBytes } from '@/lib/format';

interface UploadDropzoneProps {
  uploader: UploaderState;
}

const ACCEPT = 'image/jpeg,image/png,image/webp';

/** 从粘贴事件里捞图片；Ctrl+V 是最快的路径，很多人根本不想找文件夹 */
function fileFromClipboard(event: ClipboardEvent): File | null {
  const items = event.clipboardData?.items;
  if (!items) return null;
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

export function UploadDropzone({ uploader }: UploadDropzoneProps) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { accept, status, result, error, stageText, progress, fileName } = uploader;

  const pick = useCallback(
    (files: FileList | null) => {
      const file = files?.[0];
      if (file) void accept(file);
    },
    [accept],
  );

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = fileFromClipboard(event);
      if (file) {
        event.preventDefault();
        void accept(file);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [accept]);

  const isWorking = status === 'working';

  return (
    <div>
      {/* 用 <label> 而不是 div+role=button：点击、键盘 Enter/Space 都由原生控件负责，
          不用自己补一套可访问性，也不会出现"看起来能点但 Tab 不到"的问题 */}
      <label
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          pick(event.dataTransfer.files);
        }}
        className={[
          'relative flex min-h-[132px] cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-5 text-center transition-colors focus-within:ring-2 focus-within:ring-zinc-400',
          dragging
            ? 'border-zinc-900 bg-zinc-50'
            : 'border-zinc-300 bg-white hover:border-zinc-400 hover:bg-zinc-50/60',
        ].join(' ')}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          aria-label="上传图片"
          className="sr-only"
          onChange={(event) => {
            pick(event.target.files);
            event.target.value = '';
          }}
        />

        {result ? (
          <div className="flex w-full items-center gap-3">
            <div
              className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-lg border border-zinc-200"
              style={{
                backgroundImage:
                  'linear-gradient(45deg,#eee 25%,transparent 25%),linear-gradient(-45deg,#eee 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#eee 75%),linear-gradient(-45deg,transparent 75%,#eee 75%)',
                backgroundSize: '10px 10px',
                backgroundPosition: '0 0,0 5px,5px -5px,-5px 0',
              }}
            >
              <img
                src={result.dataUrl}
                alt="预处理后的图片"
                className="max-h-16 max-w-16 object-contain"
              />
            </div>
            <div className="min-w-0 flex-1 text-left">
              <p className="truncate text-sm font-medium text-zinc-800">
                {fileName || '已选择图片'}
              </p>
              <p className="mt-0.5 text-xs text-zinc-500">
                {result.width}×{result.height} · {formatBytes(result.blob.size)}
              </p>
              <p className="mt-0.5 text-xs text-zinc-400">点击可换一张</p>
            </div>
          </div>
        ) : (
          <>
            <div className="mb-2 text-2xl" aria-hidden="true">
              🖼️
            </div>
            <p className="text-sm font-medium text-zinc-700">
              拖入图片 · 点击选择 · 或按 Ctrl+V 粘贴
            </p>
            <p className="mt-1 text-xs text-zinc-500">JPG / PNG / WebP，单张 ≤ 8 MB</p>
          </>
        )}

        {isWorking ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-xl bg-white/85 backdrop-blur-[1px]">
            <p className="text-xs font-medium text-zinc-700">
              {stageText || '处理中'} {Math.round(progress * 100)}%
            </p>
            <div className="h-1 w-32 overflow-hidden rounded-full bg-zinc-200">
              <div
                className="h-full rounded-full bg-zinc-900 transition-[width] duration-200"
                style={{ width: `${Math.max(4, progress * 100)}%` }}
              />
            </div>
          </div>
        ) : null}
      </label>

      {error ? (
        <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
      ) : null}

      {result && result.removedRatio === 0 && uploader.removeBackground ? (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          这张图的背景不是纯色，自动去背景已经放弃（原图未改动）。背景杂乱时先手动抠图，生成质量会明显不同。
        </p>
      ) : null}

      <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-zinc-600">
        <input
          type="checkbox"
          className="h-3.5 w-3.5 rounded border-zinc-300"
          checked={uploader.removeBackground}
          onChange={(event) => uploader.setRemoveBackground(event.target.checked)}
        />
        <span className="shrink-0">自动去背景</span>
        <span className="text-zinc-400">（纯色背景效果最好；已是白底产品图可关掉，更快）</span>
      </label>
    </div>
  );
}
