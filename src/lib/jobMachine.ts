import type { JobStage, QualityTier } from '@/lib/providers/types';

export type { JobStage, QualityTier } from '@/lib/providers/types';

/**
 * 任务状态机。
 *
 * 关键约定（方案 §6.1）：
 * - 状态只增不减，前端只看 status 决定 UI，不做时间推断。
 * - failed 必须带 retryable，不可重试的错误不显示重试按钮。
 * - timeout 不是 failed：上游可能还在跑，要保留 providerJobId 以便续捞。
 */

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'timeout';

const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ['running', 'failed', 'succeeded'],
  running: ['succeeded', 'failed', 'timeout'],
  // 终态：succeeded 不允许回退到 running
  succeeded: [],
  // 重试会新建一个任务，而不是把 failed 改回 queued
  failed: [],
  timeout: ['succeeded', 'failed'],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: JobStatus): boolean {
  return status === 'succeeded' || status === 'failed';
}

/** 阶段 → 进度区间映射，避免进度条跳变 */
const STAGE_RANGE: Record<JobStage, readonly [number, number]> = {
  queued: [0, 0.2],
  geometry: [0.2, 0.6],
  texture: [0.6, 0.95],
  download: [0.95, 1],
};

export interface StageProgress {
  status: JobStatus;
  stage: JobStage;
  /** 后端自报的原始进度 0..1 */
  raw: number;
}

/**
 * 把后端上报的原始进度压进当前阶段的区间。
 * 上游给的是全局百分比时直接透传；给的是阶段内百分比时不会让进度条倒退。
 */
export function projectProgress({ status, stage, raw }: StageProgress): number {
  if (status === 'succeeded') return 1;
  if (status !== 'running') return 0;

  const [lo, hi] = STAGE_RANGE[stage];
  const clamped = Math.min(1, Math.max(0, raw));
  const value = lo + (hi - lo) * clamped;
  return Math.min(0.99, Math.round(value * 100) / 100);
}

export const STAGE_LABEL: Record<JobStage, string> = {
  queued: '排队中',
  geometry: '生成几何',
  texture: '生成纹理',
  download: '下载模型',
};

/** 质量档位 → 人类可读的说明，避免用户以为 high 一定更好 */
export const QUALITY_LABEL: Record<QualityTier, string> = {
  draft: '快速（低面数，先看个大概）',
  standard: '标准（平衡，推荐）',
  high: '高质量（面数高，更慢更贵）',
};
