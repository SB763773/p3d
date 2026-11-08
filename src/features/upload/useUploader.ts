import { useCallback, useEffect, useRef, useState } from 'react';
import type { PreprocessResult, PreprocessStage } from '@/lib/imagePreprocess';
import { preprocess } from '@/lib/imagePreprocess';

export type UploaderStatus = 'idle' | 'working' | 'ready' | 'error';

const STAGE_TEXT: Record<PreprocessStage, string> = {
  decode: '读取图片',
  resize: '缩放',
  cutout: '去背景',
  crop: '裁切主体',
  encode: '压缩',
  hash: '计算指纹',
};

export interface UploaderState {
  status: UploaderStatus;
  result: PreprocessResult | null;
  error: string | null;
  stageText: string;
  progress: number;
  removeBackground: boolean;
  fileName: string;
  setRemoveBackground: (value: boolean) => void;
  accept: (file: File) => Promise<void>;
  reset: () => void;
}

/**
 * 上传 + 预处理的编排。
 *
 * 预处理是纯前端同步阻塞的主线程活儿（Canvas 像素循环），
 * 所以每次派发都用一个递增 token 保护：用户连续换图时，旧的异步流程必须自己作废。
 */
export function useUploader(): UploaderState {
  const [status, setStatus] = useState<UploaderStatus>('idle');
  const [result, setResult] = useState<PreprocessResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stageText, setStageText] = useState('');
  const [progress, setProgress] = useState(0);
  const [removeBackground, setRemoveBackground] = useState(true);
  const [fileName, setFileName] = useState('');
  const [source, setSource] = useState<File | null>(null);

  const tokenRef = useRef(0);

  const run = useCallback(async (file: File, withCutout: boolean) => {
    const token = ++tokenRef.current;
    setStatus('working');
    setError(null);
    setProgress(0);

    try {
      const value = await preprocess(file, {
        removeBackground: withCutout,
        onProgress: (stage, ratio) => {
          if (token !== tokenRef.current) return;
          setStageText(STAGE_TEXT[stage]);
          setProgress(ratio);
        },
      });
      if (token !== tokenRef.current) return;
      setResult(value);
      setStatus('ready');
    } catch (caught) {
      if (token !== tokenRef.current) return;
      setResult(null);
      setStatus('error');
      setError(caught instanceof Error ? caught.message : '图片处理失败');
    }
  }, []);

  const accept = useCallback(
    async (file: File) => {
      setFileName(file.name);
      setSource(file);
      await run(file, removeBackground);
    },
    [removeBackground, run],
  );

  const reset = useCallback(() => {
    tokenRef.current += 1;
    setStatus('idle');
    setResult(null);
    setError(null);
    setProgress(0);
    setStageText('');
    setFileName('');
    setSource(null);
  }, []);

  // 切换去背景开关时自动重跑，用户不用手动再点一次
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (source) void run(source, removeBackground);
  }, [removeBackground, source, run]);

  return {
    status,
    result,
    error,
    stageText,
    progress,
    removeBackground,
    fileName,
    setRemoveBackground,
    accept,
    reset,
  };
}
