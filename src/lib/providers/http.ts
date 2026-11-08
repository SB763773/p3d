import type {
  GenOptions,
  ImageTo3DProvider,
  ProviderCapabilities,
  ProviderStatus,
  SubmitInput,
} from '@/lib/providers/types';
import { ERROR_CODES, ProviderError } from '@/lib/providers/types';

/**
 * 走自家 BFF 的 provider。
 *
 * 这是唯一"正确"的接入方式（方案 §8.1）：前端只认 /api/jobs 这套 HTTP 契约，
 * 生成后端的 SDK 和密钥全部留在服务端。前端直连 = Key 泄露 = 余额被刷光。
 */

interface JobView {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'timeout';
  progress: number;
  stage: 'queued' | 'geometry' | 'texture' | 'download';
  result: { glbUrl: string; sizeBytes: number; faceCount: number | null } | null;
  error: { code: string; message: string; retryable: boolean } | null;
  cost?: { estimatedYuan: number; charged: boolean; chargedYuan: number };
}

const NETWORK_MESSAGE =
  '连不上服务端。本地开发请用 npm run dev（会同时起 api），或检查 /api 是否可达。';

export class HttpProvider implements ImageTo3DProvider {
  readonly name = 'server';
  /** 后端究竟是 mock / 本地显卡 / 混元，由服务端决定，前端不假设 */
  readonly label = '服务端 BFF';

  readonly capabilities: ProviderCapabilities = {
    pbr: true,
    faceCount: false,
    multiView: false,
    // 对齐官方定价（预付费 0.10 元/积分）；真实金额仍以服务端结算为准
    estimateCostYuan: (options: GenOptions) =>
      options.quality === 'draft' ? 1.5 : options.quality === 'high' ? 3 : 2,
  };

  async submit(input: SubmitInput): Promise<{ providerJobId: string }> {
    const response = await this.request('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        image: input.imageDataUrl,
        mimeType: input.mimeType,
        imageHash: input.imageHash,
        options: input.options,
      }),
    });

    if (!response.ok) {
      const body = (await safeJson(response)) as { error?: string; message?: string } | null;
      const code = body?.error ?? ERROR_CODES.UPSTREAM_ERROR;
      // 限流和额度用完重试也没用，不要给用户一个假按钮
      const retryable = code !== ERROR_CODES.RATE_LIMITED && code !== ERROR_CODES.QUOTA_EXCEEDED;
      throw new ProviderError(
        code,
        body?.message ?? `提交失败（HTTP ${response.status}）`,
        retryable,
      );
    }

    const data = (await safeJson(response)) as { id?: string } | null;
    if (!data?.id) throw new ProviderError(ERROR_CODES.UPSTREAM_ERROR, '服务端没有返回任务 id');
    return { providerJobId: data.id };
  }

  async query(providerJobId: string): Promise<ProviderStatus> {
    const response = await this.request(`/api/jobs/${providerJobId}`, { method: 'GET' });
    if (!response.ok) {
      return {
        state: 'failed',
        code: ERROR_CODES.UPSTREAM_ERROR,
        message: `查询任务失败（HTTP ${response.status}）`,
        retryable: true,
      };
    }

    const job = (await safeJson(response)) as JobView | null;
    if (!job) {
      return {
        state: 'failed',
        code: ERROR_CODES.UPSTREAM_ERROR,
        message: '服务端返回了无法解析的任务状态',
        retryable: true,
      };
    }

    if (job.status === 'succeeded' && job.result) {
      return {
        state: 'succeeded',
        glbUrl: job.result.glbUrl,
        sizeBytes: job.result.sizeBytes,
        costYuan: job.cost?.chargedYuan,
        meta: { faceCount: job.result.faceCount ?? undefined },
      };
    }

    if (job.status === 'failed' || job.status === 'timeout') {
      return {
        state: 'failed',
        code: job.error?.code ?? ERROR_CODES.UPSTREAM_ERROR,
        message: job.error?.message ?? (job.status === 'timeout' ? '上游超时' : '生成失败'),
        retryable: job.error?.retryable ?? true,
      };
    }

    // 服务端上报的 progress 是"整条任务"的比值，直接交给上层的阶段映射归一化
    return { state: 'pending', progress: job.progress, stage: job.stage };
  }

  private async request(input: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(input, init);
    } catch {
      throw new ProviderError(ERROR_CODES.NOT_CONFIGURED, NETWORK_MESSAGE, false);
    }
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
