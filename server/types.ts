/**
 * 服务端类型定义。
 *
 * 注意：这个目录是给 Node 直接执行的（--experimental-strip-types），
 * 所以相对导入必须带 .ts 后缀，也不能用 enum / namespace / 构造函数参数属性。
 */

export type QualityTier = 'draft' | 'standard' | 'high';

export interface GenOptions {
  quality: QualityTier;
  pbr: boolean;
  faceCount?: number;
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'timeout';
export type JobStage = 'queued' | 'geometry' | 'texture' | 'download';

export interface JobError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ServerJob {
  id: string;
  /** 图片内容哈希，用于去重 */
  imageHash: string;
  /**
   * 上游原始模型地址。
   *
   * 刻意不把它直接给前端：上游 URL 带签名、24 小时过期，而且直接暴露等于
   * 把"去哪下载"这件事外包出去。前端只拿 `/api/jobs/:id/model`，由服务端转发。
   */
  assetUrl: string | null;
  options: GenOptions;
  optionsKey: string;
  status: JobStatus;
  stage: JobStage;
  progress: number;
  provider: string;
  providerJobId: string | null;
  glbUrl: string | null;
  sizeBytes: number;
  faceCount: number;
  costYuan: number;
  error: JobError | null;
  /** 脱敏后的 IP，只用于配额统计 */
  clientIpHash: string;
  createdAt: number;
  updatedAt: number;
}

export const ERROR_CODES = {
  INVALID_IMAGE: 'INVALID_IMAGE',
  CONTENT_BLOCKED: 'CONTENT_BLOCKED',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  TIMEOUT: 'TIMEOUT',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  RATE_LIMITED: 'RATE_LIMITED',
  KILL_SWITCH: 'KILL_SWITCH',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  BAD_REQUEST: 'BAD_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
} as const;

export interface ProviderStatus {
  state: 'pending' | 'succeeded' | 'failed';
  progress?: number;
  stage?: JobStage;
  glbUrl?: string;
  /** 上游原始地址：服务端据此转发，不直接下发前端 */
  assetUrl?: string;
  sizeBytes?: number;
  faceCount?: number;
  /**
   * 上游结算的实际成本。有就填，没有则由 handler 回退到 estimateCostYuan。
   * 混元的查询接口会返回 ResultCreditConsumed（实际消耗积分），比事前估算准。
   */
  costYuan?: number;
  code?: string;
  message?: string;
  retryable?: boolean;
}

export interface ProviderSubmitInput {
  /** 纯 base64，不含 `data:image/...` 前缀 */
  imageBase64: string;
  imageHash: string;
  options: GenOptions;
}

export interface ServerProvider {
  readonly name: string;
  /** 提交前的成本预估，仅供闸门判断是否放行 */
  estimateCostYuan(options: GenOptions): number;
  submit(input: ProviderSubmitInput): Promise<{ providerJobId: string }>;
  query(providerJobId: string): Promise<ProviderStatus>;
}

/** 参数键：图片哈希 + 这串东西相同才允许复用结果 */
export function optionsKeyOf(options: GenOptions): string {
  return `${options.quality}|pbr:${options.pbr ? 1 : 0}|faces:${options.faceCount ?? 0}`;
}
