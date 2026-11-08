import type { GenOptions, ProviderStatus, ProviderSubmitInput, ServerProvider } from '../types.ts';
import { ERROR_CODES } from '../types.ts';

/**
 * 腾讯混元生 3D 的服务端 provider。
 *
 * 这是"真会花钱"的那一个实现。三条硬性纪律：
 * 1. 密钥只从环境变量读，绝不出现在任何返回值、日志、错误信息里
 * 2. 上游的文件地址不下发前端，由 `/api/jobs/:id/model` 转发（会过期、会带签名）
 * 3. 成本以查询接口返回的 `ResultCreditConsumed` 为准，事前估算只用于闸门放行判断
 *
 * 签名用 WebCrypto 而不是 node:crypto，这样同一份代码在 Cloudflare Workers 上也能跑。
 *
 * 接口依据（2026-11-01 核对官方文档）：
 *   域名 ai3d.tencentcloudapi.com，版本 2025-05-13，服务名 ai3d
 *   提交 SubmitHunyuanTo3DProJob / SubmitHunyuanTo3DRapidJob
 *   查询 QueryHunyuanTo3DProJob / QueryHunyuanTo3DRapidJob
 */

const SERVICE = 'ai3d';
const API_VERSION = '2025-05-13';
const DEFAULT_ENDPOINT = 'ai3d.tencentcloudapi.com';
const DEFAULT_REGION = 'ap-guangzhou';

/** 预付费积分包单价 0.10 元/积分；后付费是 0.12，可用环境变量覆盖 */
const DEFAULT_POINT_YUAN = 0.1;

export interface HunyuanConfig {
  secretId: string;
  secretKey: string;
  region?: string;
  endpoint?: string;
  /** 1 积分折合多少元，默认 0.10（预付费）；后付费填 0.12 */
  pointYuan?: number;
  /** 注入测试用的 fetch */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface Edition {
  kind: 'pro' | 'rapid';
  submitAction: string;
  queryAction: string;
}

const EDITIONS: Record<'pro' | 'rapid', Edition> = {
  pro: {
    kind: 'pro',
    submitAction: 'SubmitHunyuanTo3DProJob',
    queryAction: 'QueryHunyuanTo3DProJob',
  },
  rapid: {
    kind: 'rapid',
    submitAction: 'SubmitHunyuanTo3DRapidJob',
    queryAction: 'QueryHunyuanTo3DRapidJob',
  },
};

/**
 * 档位 → 版本 / 生成类型 / 积分数。
 *
 * 积分数字来自官方《计费概述》：极速版图生 3D 15，专业版 Normal 20，
 * 附加 PBR +10、自定义面数 +10。改这里之前先看文档有没有调价。
 */
export interface Plan {
  edition: Edition;
  generateType: string | null;
  points: number;
}

export function planFor(options: GenOptions): Plan {
  if (options.quality === 'draft') {
    // 极速版没有 GenerateType，只有 PBR 一个附加项
    return {
      edition: EDITIONS.rapid,
      generateType: null,
      points: 15 + (options.pbr ? 10 : 0),
    };
  }

  // high 与 standard 都是 Normal：上游能提升观感的开关目前只有 PBR，
  // 所以 high = Normal + 强制 PBR（25+… 的 LowPoly 是减面，反而更糙，不适合当"高质量"）
  let points = 20;
  if (options.quality === 'high' || options.pbr) points += 10;
  if (options.faceCount !== undefined) points += 10;
  return { edition: EDITIONS.pro, generateType: 'Normal', points };
}

export class HunyuanProvider implements ServerProvider {
  readonly name = 'hunyuan';

  private readonly secretId: string;
  private readonly secretKey: string;
  private readonly region: string;
  private readonly endpoint: string;
  private readonly pointYuan: number;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;

  constructor(config: HunyuanConfig) {
    this.secretId = config.secretId;
    this.secretKey = config.secretKey;
    // 让密钥不可枚举：这样 JSON.stringify(provider)、console.log(provider)
    // 都不会把密钥带出去。日志和 /api/health 是密钥最常见的泄露口子
    Object.defineProperty(this, 'secretId', { enumerable: false });
    Object.defineProperty(this, 'secretKey', { enumerable: false });
    this.region = config.region ?? DEFAULT_REGION;
    this.endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
    this.pointYuan = config.pointYuan ?? DEFAULT_POINT_YUAN;
    this.doFetch = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = config.now ?? (() => Date.now());
  }

  estimateCostYuan(options: GenOptions): number {
    return round2(planFor(options).points * this.pointYuan);
  }

  async submit(input: ProviderSubmitInput): Promise<{ providerJobId: string }> {
    const plan = planFor(input.options);
    const body: Record<string, unknown> = { ImageBase64: input.imageBase64 };

    // 极速版不支持 GenerateType / 面数，传了会被当成无效参数
    if (plan.generateType) body.GenerateType = plan.generateType;
    // high 档 = Normal + PBR，所以这里强制开启
    if (input.options.pbr || input.options.quality === 'high') body.EnablePBR = true;
    if (plan.edition.kind === 'pro' && input.options.faceCount !== undefined) {
      body.FaceCount = clampFaceCount(input.options.faceCount);
    }

    const response = await this.call(plan.edition.submitAction, body);
    const jobId = response.JobId;
    if (typeof jobId !== 'string' || jobId === '') {
      throw new Error('上游没有返回 JobId');
    }
    // 把版本编码进 id：查询时要知道该调 Pro 还是 Rapid 的查询接口
    return { providerJobId: `${plan.edition.kind}:${jobId}` };
  }

  async query(providerJobId: string): Promise<ProviderStatus> {
    const split = providerJobId.indexOf(':');
    const kind = (split === -1 ? 'pro' : providerJobId.slice(0, split)) as 'pro' | 'rapid';
    const jobId = split === -1 ? providerJobId : providerJobId.slice(split + 1);
    const edition = EDITIONS[kind] ?? EDITIONS.pro;

    const response = await this.call(edition.queryAction, { JobId: jobId });
    const status = typeof response.Status === 'string' ? response.Status : '';

    if (status === 'WAIT' || status === 'RUN') {
      return {
        state: 'pending',
        progress: status === 'WAIT' ? 0.05 : 0.6,
        stage: status === 'WAIT' ? 'queued' : 'geometry',
      };
    }

    if (status === 'FAIL') {
      const rawCode = String(response.ErrorCode ?? 'UPSTREAM_ERROR');
      const mapped = mapUpstreamError(rawCode, String(response.ErrorMessage ?? '上游生成失败'));
      return {
        state: 'failed',
        code: mapped.code,
        message: mapped.message,
        retryable: mapped.retryable,
      };
    }

    if (status !== 'DONE') {
      return {
        state: 'failed',
        code: ERROR_CODES.UPSTREAM_ERROR,
        message: `上游返回了未知状态：${status || '(空)'}`,
        retryable: false,
      };
    }

    const files = Array.isArray(response.ResultFile3Ds) ? response.ResultFile3Ds : [];
    const glb = files.find(isGlbFile);
    if (!glb) {
      // 不伪造地址。没有 GLB 就是没有，让上层如实报错
      const types = files.map((item) => String((item as { Type?: unknown }).Type ?? '?'));
      return {
        state: 'failed',
        code: ERROR_CODES.UPSTREAM_ERROR,
        message: `上游没返回 GLB（只返回了 ${types.join('/') || '空'}），无法在浏览器里渲染`,
        retryable: false,
      };
    }

    const consumed = Number(response.ResultCreditConsumed);
    return {
      state: 'succeeded',
      progress: 1,
      stage: 'download',
      assetUrl: String(glb.Url),
      // 上游给了实际消耗就按实际的算，没给才回退到事前估算
      costYuan: Number.isFinite(consumed) && consumed > 0 ? round2(consumed * this.pointYuan) : 0,
    };
  }

  /** 统一的 API 3.0 调用：加签名 → 发请求 → 剥掉 Response 外壳 → 处理公共错误 */
  private async call(
    action: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const body = JSON.stringify(payload);
    const stamp = Math.floor(this.now() / 1000);
    const headers = await tc3Headers({
      secretId: this.secretId,
      secretKey: this.secretKey,
      service: SERVICE,
      host: this.endpoint,
      action,
      version: API_VERSION,
      region: this.region,
      payload: body,
      timestamp: stamp,
    });

    const response = await this.doFetch(`https://${this.endpoint}/`, {
      method: 'POST',
      headers,
      body,
    });

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`上游返回的不是 JSON（HTTP ${response.status}）`);
    }

    const envelope = (parsed as { Response?: Record<string, unknown> } | null)?.Response;
    if (!envelope) {
      throw new Error(`上游响应缺少 Response 字段（HTTP ${response.status}）`);
    }

    const error = envelope.Error as { Code?: unknown; Message?: unknown } | undefined;
    if (error) {
      // 注意：Message 里可能夹带密钥相关信息，只取官方 Code 做分类，message 重新生成
      const code = String(error.Code ?? 'UPSTREAM_ERROR');
      const mapped = mapUpstreamError(code, String(error.Message ?? '上游调用失败'));
      throw new UpstreamError(mapped.code, mapped.message, mapped.retryable, code);
    }

    return envelope;
  }
}

export class UpstreamError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly upstreamCode: string;

  constructor(code: string, message: string, retryable: boolean, upstreamCode: string) {
    super(message);
    this.name = 'UpstreamError';
    this.code = code;
    this.retryable = retryable;
    this.upstreamCode = upstreamCode;
  }
}

/**
 * 把腾讯云的错误码映射成我们自己的错误码 + 该不该重试。
 *
 * 分类错了代价很大：把"内容违规"标成可重试，用户会连点十次然后被风控；
 * 把"限流"标成不可重试，用户会以为彻底坏了。所以宁可保守。
 */
export function mapUpstreamError(
  code: string,
  message: string,
): {
  code: string;
  message: string;
  retryable: boolean;
} {
  const upper = code.toUpperCase();

  if (upper.includes('ILLEGAL') || upper.includes('RISK') || upper.includes('SENSITIVE')) {
    return {
      code: ERROR_CODES.CONTENT_BLOCKED,
      message: '这张图没能通过内容审核，换一张试试',
      retryable: false,
    };
  }
  if (upper.includes('LIMITEXCEEDED') || upper.includes('REQUESTLIMIT')) {
    return {
      code: ERROR_CODES.RATE_LIMITED,
      message: '上游限流了，稍等一会儿再试',
      retryable: true,
    };
  }
  if (
    upper.includes('BALANCE') ||
    upper.includes('INSUFFICIENT') ||
    upper.includes('QUOTA') ||
    upper.includes('ARREARS')
  ) {
    return {
      code: ERROR_CODES.QUOTA_EXCEEDED,
      message: '账号积分或余额不足，需要充值后才能继续生成',
      retryable: false,
    };
  }
  if (upper.includes('AUTHFAILURE') || upper.includes('INVALIDPARAMETER')) {
    return {
      code: ERROR_CODES.NOT_CONFIGURED,
      message: '密钥配置有问题，或者参数不被上游接受',
      retryable: false,
    };
  }
  return { code: ERROR_CODES.UPSTREAM_ERROR, message, retryable: true };
}

// ─────────────────────────────────────────────────────────────
// TC3-HMAC-SHA256 签名（腾讯云 API 3.0）
// ─────────────────────────────────────────────────────────────

export interface Tc3SignInput {
  secretId: string;
  secretKey: string;
  service: string;
  host: string;
  action: string;
  version: string;
  region: string;
  payload: string;
  timestamp: number;
}

export async function tc3Headers(input: Tc3SignInput): Promise<Record<string, string>> {
  const date = utcDateOf(input.timestamp);
  const hashedPayload = await sha256Hex(input.payload);

  const canonicalHeaders = `content-type:application/json\nhost:${input.host}\nx-tc-action:${input.action}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, hashedPayload].join(
    '\n',
  );

  const scope = `${date}/${input.service}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(input.timestamp),
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const secretDate = await hmac(`TC3${input.secretKey}`, date);
  const secretService = await hmac(secretDate, input.service);
  const secretSigning = await hmac(secretService, 'tc3_request');
  const signature = toHex(await hmac(secretSigning, stringToSign));

  return {
    'content-type': 'application/json',
    host: input.host,
    'x-tc-action': input.action,
    'x-tc-version': input.version,
    'x-tc-region': input.region,
    'x-tc-timestamp': String(input.timestamp),
    authorization: `TC3-HMAC-SHA256 Credential=${input.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function utcDateOf(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

async function hmac(key: string | Uint8Array, data: string): Promise<Uint8Array> {
  const raw = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    raw as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  return new Uint8Array(signature);
}

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

// ─────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────

function isGlbFile(item: unknown): item is { Url: string } {
  if (!item || typeof item !== 'object') return false;
  const record = item as { Type?: unknown; Url?: unknown };
  return String(record.Type ?? '').toUpperCase() === 'GLB' && typeof record.Url === 'string';
}

/** 官方范围 10000–1500000，超了上游会直接拒 */
function clampFaceCount(value: number): number {
  return Math.min(1_500_000, Math.max(10_000, Math.round(value)));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
