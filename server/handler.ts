import { dayKeyOf, evaluateGate, limitsFromEnv, nextResetAt, summarizeToday } from './gate.ts';
import type { GenOptions, JobError, JobStage, ServerJob, ServerProvider } from './types.ts';
import { ERROR_CODES, optionsKeyOf } from './types.ts';

/**
 * BFF 的请求处理层。
 *
 * 刻意用 Web 标准的 Request → Response 写：
 * - 现在能跑在 node:http 适配器上（不需要任何云账号）
 * - 之后原样塞进 Cloudflare Pages Functions 就行，一行不用改
 *
 * 这里最重要的一条纪律：**任何 provider 的 SDK / 密钥都不允许出现在前端**。
 * 前端只能看到 /api/jobs 这套 HTTP 契约。
 */

export interface JobRepository {
  list(): ServerJob[];
  get(id: string): ServerJob | undefined;
  put(job: ServerJob): Promise<void>;
  remove(id: string): Promise<boolean>;
}

export interface HandlerDeps {
  store: JobRepository;
  provider: ServerProvider;
  env: Record<string, string | undefined>;
  now?: () => number;
  /** 便于测试替换；默认用 WebCrypto 做 SHA-256 脱敏 */
  hashIp?: (ip: string) => Promise<string>;
  /** 转发上游模型文件时用；测试里替换成假实现 */
  fetchUpstream?: typeof fetch;
  /** provider 的实际生效情况，只用于 /api/health 如实汇报 */
  providerReport?: { wanted: string; active: string; reason: string | null };
}

const MAX_BODY_BYTES = 12 * 1024 * 1024;
const RUNNING_TIMEOUT_MS = 120_000;
const QUALITIES = new Set(['draft', 'standard', 'high']);

export function createHandler(deps: HandlerDeps) {
  const now = deps.now ?? (() => Date.now());
  const hashIp = deps.hashIp ?? defaultHashIp;

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '/api/health' && request.method === 'GET') {
        return handleHealth(deps, now);
      }
      if (path === '/api/jobs' && request.method === 'POST') {
        return await handleCreate(request, deps, now, hashIp);
      }

      const match = /^\/api\/jobs\/([A-Za-z0-9_-]+)$/.exec(path);
      if (match) {
        const id = match[1];
        if (!id) return errorJson(400, ERROR_CODES.BAD_REQUEST, '任务 id 不合法');
        if (request.method === 'GET') return await handleQuery(id, deps, now);
        if (request.method === 'DELETE') return await handleDelete(id, deps);
        return errorJson(405, ERROR_CODES.BAD_REQUEST, '不支持的方法');
      }

      const modelMatch = /^\/api\/jobs\/([A-Za-z0-9_-]+)\/model$/.exec(path);
      if (modelMatch && request.method === 'GET') {
        const id = modelMatch[1];
        if (!id) return errorJson(400, ERROR_CODES.BAD_REQUEST, '任务 id 不合法');
        return await handleModel(id, deps);
      }

      return errorJson(404, ERROR_CODES.NOT_FOUND, `没有这个接口：${path}`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '服务端异常';
      return errorJson(500, ERROR_CODES.UPSTREAM_ERROR, message);
    }
  };
}

// ─────────────────────────────────────────────────────────────
// 路由实现
// ─────────────────────────────────────────────────────────────

function handleHealth(deps: HandlerDeps, now: () => number): Response {
  const limits = limitsFromEnv(deps.env);
  const snapshot = summarizeToday(deps.store.list(), now(), '—');
  return json(200, {
    ok: true,
    provider: deps.provider.name,
    providerReport: deps.providerReport ?? {
      wanted: deps.provider.name,
      active: deps.provider.name,
      reason: null,
    },
    killSwitch: limits.killSwitch,
    limits,
    budget: {
      spentTodayYuan: snapshot.spentTodayYuan,
      dayKey: snapshot.dayKey,
      resetAt: nextResetAt(now()),
    },
  });
}

async function handleCreate(
  request: Request,
  deps: HandlerDeps,
  now: () => number,
  hashIp: (ip: string) => Promise<string>,
): Promise<Response> {
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return errorJson(413, ERROR_CODES.BAD_REQUEST, '图片太大，请先压缩');
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorJson(400, ERROR_CODES.BAD_REQUEST, '请求体不是合法 JSON');
  }

  const parsed = parseCreateBody(body);
  if (!parsed.ok) return errorJson(400, parsed.code, parsed.message);

  const { imageHash, imageBase64, options } = parsed.value;
  const imageSize = parsed.value.image.length;
  if (imageSize > MAX_BODY_BYTES) {
    return errorJson(413, ERROR_CODES.BAD_REQUEST, '图片太大，请先压缩');
  }

  const stamp = now();
  const dayKey = dayKeyOf(stamp);
  const ipHash = await hashIp(clientIpOf(request));

  // 去重优先于闸门：命中缓存不花钱，没必要为它扣配额
  const cacheHit = findCacheHit(deps.store.list(), imageHash, options);
  if (cacheHit) {
    return json(200, {
      id: cacheHit.id,
      status: 'succeeded',
      cached: true,
      createdAt: cacheHit.createdAt,
      result: resultOf(cacheHit),
    });
  }

  const limits = limitsFromEnv(deps.env);
  const snapshot = summarizeToday(deps.store.list(), stamp, ipHash);
  const estimate = deps.provider.estimateCostYuan(options);

  const decision = evaluateGate({
    jobCountIpToday: snapshot.jobCountIpToday,
    spentTodayYuan: snapshot.spentTodayYuan,
    estimateYuan: estimate,
    limits,
    now: stamp,
  });
  if (!decision.allow) {
    return json(
      decision.status,
      {
        error: decision.code,
        message: decision.message,
        resetAt: decision.resetAt ?? null,
      },
      {
        'retry-after': decision.resetAt
          ? String(Math.max(1, Math.ceil((decision.resetAt - stamp) / 1000)))
          : '60',
      },
    );
  }

  const id = newJobId(stamp);
  const job: ServerJob = {
    id,
    imageHash,
    options,
    optionsKey: optionsKeyOf(options),
    status: 'queued',
    stage: 'queued',
    progress: 0,
    provider: deps.provider.name,
    providerJobId: null,
    glbUrl: null,
    assetUrl: null,
    sizeBytes: 0,
    faceCount: 0,
    // 失败不扣费，所以成本在成功时才记上
    costYuan: 0,
    error: null,
    clientIpHash: ipHash,
    createdAt: stamp,
    updatedAt: stamp,
  };

  try {
    const { providerJobId } = await deps.provider.submit({ imageBase64, imageHash, options });
    job.providerJobId = providerJobId;
    job.status = 'running';
    await deps.store.put(job);
  } catch (caught) {
    // 上游异常带自己的错误码（比如内容违规、余额不足），要如实传下去，
    // 否则用户会看到"重试"按钮却怎么点都失败
    const reported = upstreamFailureOf(caught);
    job.status = 'failed';
    job.error = reported;
    await deps.store.put(job);
  }

  return json(201, { id: job.id, status: job.status, createdAt: job.createdAt, dayKey }, {});
}

async function handleQuery(id: string, deps: HandlerDeps, now: () => number): Promise<Response> {
  const job = deps.store.get(id);
  if (!job) return errorJson(404, ERROR_CODES.NOT_FOUND, '任务不存在');

  if (job.status === 'running' || job.status === 'queued') {
    if (now() - job.createdAt > RUNNING_TIMEOUT_MS) {
      // 超时不判死：保留 providerJobId，后台还能捞回结果（方案 §6.1）
      job.status = 'timeout';
      job.error = {
        code: ERROR_CODES.TIMEOUT,
        message: '等待超过 120 秒仍未完成，上游可能还在生成。',
        retryable: true,
      };
      job.updatedAt = now();
      await deps.store.put(job);
      return json(200, viewOf(job, deps));
    }

    if (!job.providerJobId) return json(200, viewOf(job, deps));

    const status = await deps.provider.query(job.providerJobId);
    if (status.state === 'pending') {
      job.status = 'running';
      job.stage = (status.stage ?? job.stage) as JobStage;
      // 进度只增不减，上游抖动不该让进度条倒退
      job.progress = Math.max(job.progress, round(status.progress ?? 0));
      job.updatedAt = now();
      await deps.store.put(job);
      return json(200, viewOf(job, deps));
    }

    if (status.state === 'failed') {
      job.status = 'failed';
      job.error = {
        code: status.code ?? ERROR_CODES.UPSTREAM_ERROR,
        message: status.message ?? '上游生成失败',
        retryable: status.retryable ?? true,
      };
      job.updatedAt = now();
      await deps.store.put(job);
      return json(200, viewOf(job, deps));
    }

    job.status = 'succeeded';
    job.stage = 'download';
    job.progress = 1;
    job.assetUrl = status.assetUrl ?? null;
    // 上游地址不下发前端：换成自家转发接口，前端只看到 /api/jobs/:id/model
    job.glbUrl = status.glbUrl ?? (job.assetUrl ? `/api/jobs/${job.id}/model` : null);
    job.sizeBytes = status.sizeBytes ?? 0;
    job.faceCount = status.faceCount ?? 0;
    // 上游结算多少就是多少；上游没给才退回事前估算
    job.costYuan = status.costYuan ?? deps.provider.estimateCostYuan(job.options);
    job.updatedAt = now();
    await deps.store.put(job);
    return json(200, viewOf(job, deps));
  }

  return json(200, viewOf(job, deps));
}

/**
 * 转发上游的模型文件。
 *
 * 为什么不直接把上游 URL 给前端：
 * 1. 上游地址带签名且 24 小时过期，直接暴露等于把凭据短期外借
 * 2. 跨域不可控，浏览器能不能 fetch 到取决于对方 CORS 配置
 * 3. 换成自家路径后，以后要换成"存进 R2 再发"也只改这一处
 */
async function handleModel(id: string, deps: HandlerDeps): Promise<Response> {
  const job = deps.store.get(id);
  if (!job) return errorJson(404, ERROR_CODES.NOT_FOUND, '任务不存在');
  if (job.status !== 'succeeded' || !job.assetUrl) {
    return errorJson(404, ERROR_CODES.NOT_FOUND, '这个任务没有可下载的模型');
  }

  // 只放行 http(s)：挡掉 file:// 之类可能读到本地文件的协议
  let target: URL;
  try {
    target = new URL(job.assetUrl);
  } catch {
    return errorJson(500, ERROR_CODES.UPSTREAM_ERROR, '上游地址不合法');
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return errorJson(500, ERROR_CODES.UPSTREAM_ERROR, '上游协议不受支持');
  }

  const doFetch = deps.fetchUpstream ?? globalThis.fetch;
  try {
    const upstream = await doFetch(target.href);
    if (!upstream.ok || !upstream.body) {
      // 上游文件已过期（24 小时）时最常见，如实说明，别让用户以为是我们坏了
      return errorJson(
        502,
        ERROR_CODES.UPSTREAM_ERROR,
        `取不回模型文件（上游返回 ${upstream.status}），可能已过期，重新生成一次即可`,
      );
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'content-type': 'model/gltf-binary',
        'cache-control': 'private, max-age=3600',
      },
    });
  } catch (caught) {
    return errorJson(
      502,
      ERROR_CODES.UPSTREAM_ERROR,
      `取模型文件失败：${caught instanceof Error ? caught.message : '未知原因'}`,
    );
  }
}

/** 从上游异常里尽量还原错误码与可重试性，拿不到才退回通用错误 */
function upstreamFailureOf(caught: unknown): JobError {
  if (caught && typeof caught === 'object') {
    const record = caught as { code?: unknown; retryable?: unknown };
    if (typeof record.code === 'string') {
      return {
        code: record.code,
        message: caught instanceof Error ? caught.message : '上游提交失败',
        retryable: record.retryable === true,
      };
    }
  }
  return {
    code: ERROR_CODES.UPSTREAM_ERROR,
    message: caught instanceof Error ? caught.message : '上游提交失败',
    retryable: true,
  };
}

async function handleDelete(id: string, deps: HandlerDeps): Promise<Response> {
  const removed = await deps.store.remove(id);
  if (!removed) return errorJson(404, ERROR_CODES.NOT_FOUND, '任务不存在');
  return json(200, { ok: true });
}

// ─────────────────────────────────────────────────────────────
// 解析 / 视图 / 工具
// ─────────────────────────────────────────────────────────────

type ParseResult =
  | {
      ok: true;
      value: { image: string; imageBase64: string; imageHash: string; options: GenOptions };
    }
  | { ok: false; code: string; message: string };

export function parseCreateBody(body: unknown): ParseResult {
  if (!body || typeof body !== 'object') {
    return { ok: false, code: ERROR_CODES.BAD_REQUEST, message: '请求体必须是对象' };
  }
  const record = body as Record<string, unknown>;
  const image = record.image;
  const imageHash = record.imageHash;
  const rawOptions = record.options;

  if (typeof image !== 'string' || !image.startsWith('data:image/')) {
    return { ok: false, code: ERROR_CODES.INVALID_IMAGE, message: '图片数据无效' };
  }
  if (typeof imageHash !== 'string' || !/^[0-9a-f]{8,64}$/i.test(imageHash)) {
    return { ok: false, code: ERROR_CODES.BAD_REQUEST, message: 'imageHash 缺失或格式不对' };
  }

  const options = sanitizeOptions(rawOptions);
  if (!options) {
    return { ok: false, code: ERROR_CODES.BAD_REQUEST, message: '生成参数不合法' };
  }

  let imageBase64 = '';
  const comma = image.indexOf(',');
  if (comma === -1)
    return { ok: false, code: ERROR_CODES.INVALID_IMAGE, message: '图片数据格式不对' };
  imageBase64 = image.slice(comma + 1).trim();
  if (!imageBase64) return { ok: false, code: ERROR_CODES.INVALID_IMAGE, message: '图片内容为空' };

  return { ok: true, value: { image, imageBase64, imageHash: imageHash.toLowerCase(), options } };
}

export function sanitizeOptions(raw: unknown): GenOptions | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;

  const quality = typeof record.quality === 'string' ? record.quality : 'standard';
  if (!QUALITIES.has(quality)) return null;

  const pbr = record.pbr === true;
  const faceCountRaw = record.faceCount;
  let faceCount: number | undefined;
  if (typeof faceCountRaw === 'number' && Number.isFinite(faceCountRaw)) {
    if (faceCountRaw < 0 || faceCountRaw > 200_000) return null;
    faceCount = Math.round(faceCountRaw);
  }

  return { quality: quality as GenOptions['quality'], pbr, faceCount };
}

export function findCacheHit(
  jobs: readonly ServerJob[],
  imageHash: string,
  options: GenOptions,
): ServerJob | undefined {
  const key = optionsKeyOf(options);
  return jobs.find(
    (job) =>
      job.status === 'succeeded' &&
      job.glbUrl !== null &&
      job.imageHash === imageHash &&
      job.optionsKey === key,
  );
}

function resultOf(job: ServerJob) {
  if (!job.glbUrl) return null;
  return {
    glbUrl: job.glbUrl,
    sizeBytes: job.sizeBytes,
    faceCount: job.faceCount || null,
  };
}

function viewOf(job: ServerJob, deps: HandlerDeps) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    provider: job.provider,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    options: job.options,
    result: resultOf(job),
    error: job.error,
    cost: {
      estimatedYuan: deps.provider.estimateCostYuan(job.options),
      charged: job.costYuan > 0,
      chargedYuan: job.costYuan,
    },
  };
}

function clientIpOf(request: Request): string {
  // node 适配器会把真实 IP 塞进 x-forwarded-for；Cloudflare 用 cf-connecting-ip
  const forwarded = request.headers.get('x-forwarded-for') ?? '';
  const first = forwarded.split(',')[0]?.trim();
  return (
    first ||
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

async function defaultHashIp(ip: string): Promise<string> {
  const data = new TextEncoder().encode(`p3d:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

let seq = 0;

function newJobId(timestamp: number): string {
  seq = (seq + 1) % 1296;
  return `job_${timestamp.toString(36)}${seq.toString(36).padStart(2, '0')}`;
}

function round(value: number): number {
  return Math.min(1, Math.max(0, Math.round(value * 100) / 100));
}

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

function errorJson(status: number, code: string, message: string): Response {
  return json(status, { error: code, message });
}
