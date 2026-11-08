import type { GenOptions, ProviderStatus, ProviderSubmitInput, ServerProvider } from '../types.ts';
import { ERROR_CODES } from '../types.ts';

/**
 * 本地推理引擎 provider。
 *
 * 对应 `local-engine/` 里那个 FastAPI 服务：TripoSR 直接跑在本机显卡上。
 * 它解决的是"没有腾讯云账号、也不打算实名"这个具体问题 ——
 * 生成完全离线，不花一分钱，也不受任何人限流。
 *
 * 为什么不让前端直连 8188：
 * 前端的契约是 `/api/jobs/:id` 这一套，如果多一个"特殊后端要直连"的分支，
 * 限流、去重、预算这些服务端逻辑就全绕过去了。所以这里仍是服务端转发，
 * 只是把"上游"换成了 localhost。
 */

const DEFAULT_BASE = 'http://127.0.0.1:8188';
const QUERY_TIMEOUT_MS = 8000;

interface LocalJobView {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  stage?: string;
  progress?: number;
  url?: string;
  sizeBytes?: number;
  faceCount?: number;
  elapsedSeconds?: number;
  error?: { code?: string; message?: string; retryable?: boolean } | null;
}

export interface LocalProviderConfig {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class LocalProvider implements ServerProvider {
  readonly name = 'local';

  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(config: LocalProviderConfig = {}) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.doFetch = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * 本地推理的电费忽略不计，成本记 0。
   * 这让闸门的"日预算"对它天然放行 —— 没有理由限制一台自己家的显卡。
   */
  estimateCostYuan(_options: GenOptions): number {
    return 0;
  }

  async submit(input: ProviderSubmitInput): Promise<{ providerJobId: string }> {
    const response = await this.post('/v1/jobs', { image: input.imageBase64 });

    if (!response.ok) {
      const detail = await textOrEmpty(response);
      throw new LocalEngineError(
        ERROR_CODES.UPSTREAM_ERROR,
        `本地引擎拒绝了请求（HTTP ${response.status}）${detail ? `：${detail}` : ''}`,
        response.status >= 500,
      );
    }

    const data = (await response.json().catch(() => null)) as { id?: string } | null;
    if (!data?.id) {
      throw new LocalEngineError(ERROR_CODES.UPSTREAM_ERROR, '本地引擎没有返回任务 id', true);
    }
    return { providerJobId: data.id };
  }

  async query(providerJobId: string): Promise<ProviderStatus> {
    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}/v1/jobs/${providerJobId}`, {
        method: 'GET',
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      });
    } catch (caught) {
      return {
        state: 'failed',
        code: ERROR_CODES.UPSTREAM_ERROR,
        message: this.offlineHint(caught),
        retryable: true,
      };
    }

    if (response.status === 404) {
      return {
        state: 'failed',
        code: ERROR_CODES.UPSTREAM_ERROR,
        message: '本地引擎里找不到这个任务了（可能服务重启过），重新生成一次即可',
        retryable: true,
      };
    }
    if (!response.ok) {
      return {
        state: 'failed',
        code: ERROR_CODES.UPSTREAM_ERROR,
        message: `查询本地引擎失败（HTTP ${response.status}）`,
        retryable: true,
      };
    }

    const job = (await response.json().catch(() => null)) as LocalJobView | null;
    if (!job) {
      return {
        state: 'failed',
        code: ERROR_CODES.UPSTREAM_ERROR,
        message: '本地引擎返回了无法解析的状态',
        retryable: true,
      };
    }

    if (job.status === 'succeeded' && job.url) {
      return {
        state: 'succeeded',
        progress: 1,
        stage: 'download',
        // 交给 handler 转发成 /api/jobs/:id/model，前端看不到 8188 这个端口
        assetUrl: `${this.baseUrl}${job.url}`,
        sizeBytes: job.sizeBytes ?? 0,
        faceCount: job.faceCount,
        costYuan: 0,
      };
    }

    if (job.status === 'failed') {
      return {
        state: 'failed',
        code: job.error?.code ?? ERROR_CODES.UPSTREAM_ERROR,
        message: job.error?.message ?? '本地推理失败',
        retryable: job.error?.retryable !== false,
      };
    }

    return {
      state: 'pending',
      progress: typeof job.progress === 'number' ? job.progress : 0.1,
      stage: mapStage(job.stage),
    };
  }

  /** 主动探活，供 /api/health 显示"引擎在不在"，而不是等用户提交了才报错 */
  async ping(): Promise<{ ok: boolean; detail: string }> {
    try {
      const response = await this.doFetch(`${this.baseUrl}/v1/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
      const data = (await response.json()) as { ok?: boolean; error?: string | null; gpu?: string };
      if (data.ok) return { ok: true, detail: data.gpu ? `${data.gpu} 就绪` : '就绪' };
      return { ok: false, detail: data.error ?? '引擎加载中' };
    } catch {
      return { ok: false, detail: '连不上 127.0.0.1:8188' };
    }
  }

  private async post(path: string, body: unknown): Promise<Response> {
    try {
      return await this.doFetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (caught) {
      // 引擎没起是"暂时不可用"，不是配置错误：把引擎拉起来之后点重试就能成，
      // 所以这里标 retryable，别让用户以为彻底坏了。
      throw new LocalEngineError(ERROR_CODES.NOT_CONFIGURED, this.offlineHint(caught), true);
    }
  }

  private offlineHint(caught: unknown): string {
    const reason = caught instanceof Error ? caught.message : String(caught);
    return `连不上本地推理引擎（${reason}）。先在另一个终端运行 npm run engine，加载约需 30 秒。`;
  }
}

export class LocalEngineError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'LocalEngineError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** Python 侧粗粒度阶段 → 项目统一的四个阶段 */
function mapStage(stage: string | undefined): 'queued' | 'geometry' | 'texture' | 'download' {
  switch (stage) {
    case 'preparing':
      return 'queued';
    case 'encoding':
      return 'geometry';
    case 'meshing':
      return 'texture';
    case 'done':
      return 'download';
    default:
      return 'queued';
  }
}

async function textOrEmpty(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return '';
  }
}
