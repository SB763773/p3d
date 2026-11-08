import type { GenOptions, ProviderStatus, ProviderSubmitInput, ServerProvider } from '../types.ts';

/**
 * 服务端 Mock provider。
 *
 * 和前端那个 mock 的区别：这个跑在服务端，所以整条链路（提交 → 轮询 → 落库 → 闸门计费）
 * 都是真的，只有"生成"这一步是假的。它对项目的作用是：
 * - 把"密钥只在服务端"这条架构要求坐实，前端一行 provider SDK 都碰不到
 * - 让限流、预算、熔断这类逻辑能在零成本、零网络的前提下被真实触发和测试
 */

const SAMPLES = [
  { url: '/mock/sample-vase.glb', sizeBytes: 131_704 },
  { url: '/mock/sample-knot.glb', sizeBytes: 319_260 },
  { url: '/mock/sample-rock.glb', sizeBytes: 49_288 },
] as const;

const DURATION_MS: Record<GenOptions['quality'], number> = {
  draft: 2400,
  standard: 3800,
  high: 5200,
};

// 对齐官方定价（预付费 0.10 元/积分）：极速版 15、专业版 Normal 20、LowPoly+PBR 30
const COST_YUAN: Record<GenOptions['quality'], number> = {
  draft: 1.5,
  standard: 2,
  high: 3,
};

interface MockJob {
  startedAt: number;
  duration: number;
  sample: (typeof SAMPLES)[number];
}

export class ServerMockProvider implements ServerProvider {
  readonly name = 'mock';
  private jobs = new Map<string, MockJob>();
  private seq = 0;
  private now: () => number;

  constructor(now?: () => number) {
    this.now = now ?? (() => Date.now());
  }

  estimateCostYuan(options: GenOptions): number {
    return COST_YUAN[options.quality] ?? COST_YUAN.standard;
  }

  async submit(input: ProviderSubmitInput): Promise<{ providerJobId: string }> {
    const id = `srv_${this.now()}_${this.seq++}`;
    this.jobs.set(id, {
      startedAt: this.now(),
      duration: DURATION_MS[input.options.quality] ?? DURATION_MS.standard,
      sample: pickSample(input.imageHash),
    });
    return { providerJobId: id };
  }

  async query(providerJobId: string): Promise<ProviderStatus> {
    const job = this.jobs.get(providerJobId);
    if (!job) {
      return {
        state: 'failed',
        code: 'UPSTREAM_ERROR',
        message: '任务不存在或已过期',
        retryable: true,
      };
    }

    const ratio = Math.min(1, (this.now() - job.startedAt) / job.duration);
    if (ratio < 1) {
      const stage =
        ratio < 0.2 ? 'queued' : ratio < 0.6 ? 'geometry' : ratio < 0.95 ? 'texture' : 'download';
      return { state: 'pending', progress: ratio, stage };
    }

    this.jobs.delete(providerJobId);
    return {
      state: 'succeeded',
      progress: 1,
      stage: 'download',
      // mock 用的是仓库里的静态资源，本来就在自家域下，不需要转发
      glbUrl: job.sample.url,
      sizeBytes: job.sample.sizeBytes,
    };
  }
}

function pickSample(imageHash: string): (typeof SAMPLES)[number] {
  let sum = 0;
  for (let i = 0; i < imageHash.length; i++) sum = (sum + imageHash.charCodeAt(i)) % 9973;
  return SAMPLES[sum % SAMPLES.length] ?? SAMPLES[0];
}
