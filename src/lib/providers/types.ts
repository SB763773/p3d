/**
 * 生成后端的统一抽象层。
 *
 * 设计约束（来自方案 §4.4）：
 * 1. 任何一家的 SDK 都不允许直接进业务代码 —— 价格会调、模型会换代、接口会改。
 * 2. 成本预估挂在 provider 上，熔断逻辑只写一遍。
 * 3. 所有单测跑 mock，零花费、零网络依赖。
 */

export type QualityTier = 'draft' | 'standard' | 'high';

export interface GenOptions {
  /** 质量档位，各 provider 自行映射到自己的计费档 */
  quality: QualityTier;
  /** 是否要求生成 PBR 纹理 */
  pbr: boolean;
  /** 期望面数，0 / undefined 表示由后端决定 */
  faceCount?: number;
}

export interface SubmitInput {
  /** 已去背景、已缩放、已压缩的图片（data URL） */
  imageDataUrl: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  options: GenOptions;
  /** 预处理阶段算出的内容哈希，用于去重与缓存命中 */
  imageHash: string;
}

export interface ProviderCapabilities {
  pbr: boolean;
  faceCount: boolean;
  multiView: boolean;
  /** 该档位预估消耗（人民币元），用于成本熔断 */
  estimateCostYuan: (options: GenOptions) => number;
}

export type ProviderStatus =
  | { state: 'pending'; progress: number; stage?: JobStage }
  | {
      state: 'succeeded';
      /** 可直接渲染的 GLB 地址（blob: 或 https:） */
      glbUrl: string;
      sizeBytes?: number;
      thumbnailUrl?: string;
      /** 服务端结算的真实成本；没有则由前端按档位估算 */
      costYuan?: number;
      meta?: ModelMeta;
    }
  | { state: 'failed'; code: string; message: string; retryable: boolean };

export type JobStage = 'queued' | 'geometry' | 'texture' | 'download';

export interface ModelMeta {
  faceCount?: number;
  pbr?: boolean;
  /** 归一化后的包围盒相对比例 [x, y, z]，最长边为 1 */
  bbox?: [number, number, number];
}

export interface ImageTo3DProvider {
  readonly name: string;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;
  submit(input: SubmitInput): Promise<{ providerJobId: string }>;
  query(providerJobId: string): Promise<ProviderStatus>;
  cancel?(providerJobId: string): Promise<void>;
}

/** 统一错误码，前端据此决定是否显示"重试"按钮 */
export const ERROR_CODES = {
  INVALID_IMAGE: 'INVALID_IMAGE',
  CONTENT_BLOCKED: 'CONTENT_BLOCKED',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  TIMEOUT: 'TIMEOUT',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  RATE_LIMITED: 'RATE_LIMITED',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
} as const;

/**
 * 带错误码的 provider 异常。
 *
 * 为什么不用普通 Error：上层要据此决定"显不显示重试按钮"
 * 和"告诉用户是限流还是后端没起来"，靠 message 字符串匹配太脆。
 */
export class ProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = true) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = retryable;
  }
}
