import type {
  GenOptions,
  ImageTo3DProvider,
  ProviderCapabilities,
  ProviderStatus,
  SubmitInput,
} from '@/lib/providers/types';
import { ERROR_CODES } from '@/lib/providers/types';

/**
 * 本地 Mock provider。
 *
 * 这不是"临时妥协"，而是必须长期保留的开发与测试基础设施（方案 §4.1 路线 C）：
 * - 零成本、零网络、绝对可控
 * - 所有单测和冒烟测试跑它，CI 里不花一分钱
 * - 没有 Key 的时候，全链路照样跑通、照样能演示
 *
 * 诚实声明：它不生成任何真实内容，只会在几百毫秒后交回一个预置 GLB。
 */

/** 三个预置模型，按图片哈希确定性地挑一个（同一张图永远给同一个，便于比对） */
const SAMPLES = [
  { url: '/mock/sample-vase.glb', name: '花瓶（示例）' },
  { url: '/mock/sample-knot.glb', name: '扭结（示例）' },
  { url: '/mock/sample-rock.glb', name: '石块（示例）' },
] as const;

const DURATION_MS: Record<GenOptions['quality'], number> = {
  draft: 2400,
  standard: 3800,
  high: 5200,
};

interface MockJob {
  startedAt: number;
  duration: number;
  sample: (typeof SAMPLES)[number];
  sizeBytes: number;
  shouldFail: boolean;
}

export interface MockProviderOptions {
  /** 注入时钟，单测里可以手动快进 */
  now?: () => number;
  /** 全局模拟失败，用于验证错误 UI */
  failAll?: boolean;
}

export class MockProvider implements ImageTo3DProvider {
  readonly name = 'mock';
  readonly label = '本地 Mock（不生成真实内容）';
  private readonly jobs = new Map<string, MockJob>();
  private readonly now: () => number;
  private failNext = false;
  private seq = 0;

  constructor(options: MockProviderOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.failNext = options.failAll ?? false;
  }

  readonly capabilities: ProviderCapabilities = {
    pbr: true,
    faceCount: false,
    multiView: false,
    /**
     * 对齐腾讯混元生 3D 官方定价（2026-11-01 核对，预付费 0.10 元/积分）：
     *   draft    = 极速版图生 3D              15 积分 → ¥1.5
     *   standard = 专业版 Normal              20 积分 → ¥2.0
     *   high     = 专业版 Normal + PBR(+10)   30 积分 → ¥3.0
     * 用真实单价而不是随手填的数字，成本熔断的阈值才有意义。
     */
    estimateCostYuan: (o) => (o.quality === 'draft' ? 1.5 : o.quality === 'high' ? 3 : 2),
  };

  /** 让下一次提交失败，供"错误态"手动验证 */
  setFailNext(value: boolean) {
    this.failNext = value;
  }

  async submit(input: SubmitInput): Promise<{ providerJobId: string }> {
    if (!input.imageDataUrl?.startsWith('data:image/')) {
      throw new Error('图片数据无效');
    }
    if (input.options.pbr && !this.capabilities.pbr) {
      throw new Error('当前后端不支持 PBR');
    }

    const id = `mock_${this.now()}_${this.seq++}`;
    const sample = pickSample(input.imageHash);
    this.jobs.set(id, {
      startedAt: this.now(),
      duration: DURATION_MS[input.options.quality],
      sample,
      sizeBytes: 0,
      shouldFail: this.failNext,
    });
    this.failNext = false;
    return { providerJobId: id };
  }

  async query(providerJobId: string): Promise<ProviderStatus> {
    const job = this.jobs.get(providerJobId);
    if (!job) {
      return {
        state: 'failed',
        code: ERROR_CODES.UPSTREAM_ERROR,
        message: '任务不存在或已过期',
        retryable: true,
      };
    }

    const elapsed = this.now() - job.startedAt;
    const ratio = Math.min(1, elapsed / job.duration);

    if (job.shouldFail && ratio > 0.35) {
      this.jobs.delete(providerJobId);
      return {
        state: 'failed',
        code: ERROR_CODES.UPSTREAM_ERROR,
        message: '示例失败：模拟上游生成异常（仅用于验证错误提示）',
        retryable: true,
      };
    }

    if (ratio < 1) {
      if (ratio < 0.2) return { state: 'pending', progress: ratio, stage: 'queued' };
      if (ratio < 0.6) return { state: 'pending', progress: ratio, stage: 'geometry' };
      if (ratio < 0.95) return { state: 'pending', progress: ratio, stage: 'texture' };
      return { state: 'pending', progress: ratio, stage: 'download' };
    }

    if (!job.sizeBytes) {
      job.sizeBytes = await measureRemoteSize(job.sample.url);
    }
    this.jobs.delete(providerJobId);

    return {
      state: 'succeeded',
      glbUrl: job.sample.url,
      sizeBytes: job.sizeBytes,
      meta: {
        pbr: true,
        faceCount: 0,
      },
    };
  }

  async cancel(providerJobId: string): Promise<void> {
    this.jobs.delete(providerJobId);
  }
}

function pickSample(imageHash: string): (typeof SAMPLES)[number] {
  let sum = 0;
  for (let i = 0; i < imageHash.length; i++) sum = (sum + imageHash.charCodeAt(i)) % 9973;
  const index = sum % SAMPLES.length;
  return SAMPLES[index] ?? SAMPLES[0];
}

async function measureRemoteSize(url: string): Promise<number> {
  try {
    const head = await fetch(url, { method: 'HEAD' });
    const length = head.headers.get('content-length');
    return length ? Number(length) : 0;
  } catch {
    return 0;
  }
}
