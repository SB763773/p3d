import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { createHandler } from './handler.ts';
import { createProvider } from './providers/index.ts';
import { JobStore } from './store.ts';

/**
 * node:http 适配器。
 *
 * 唯一职责：把 node 的 req/res 翻译成 Web 标准的 Request/Response。
 * 业务逻辑一行都不在这儿 —— 这样同一份 handler 之后能原样跑在
 * Cloudflare Pages Functions（那里直接给你 Request，返回值就是 Response）。
 */

const PORT = Number(process.env.P3D_API_PORT ?? 8787);
const HOST = process.env.P3D_API_HOST ?? '127.0.0.1';
const DATA_FILE = process.env.P3D_DATA_FILE ?? '.data/jobs.json';
const MAX_BODY_BYTES = 12 * 1024 * 1024;

const store = new JobStore(DATA_FILE);
await store.init();

// 密钥只在服务端读；没配就退回 mock，并由 /api/health 如实说明
const bundle = createProvider(process.env);
const provider = bundle.provider;

/**
 * 本地推理（provider=local）不花钱，产品侧的两条限制对它没有意义：
 * 单 IP 每日 10 次是防云端账单失控的，自家显卡没有账单可言。
 * 这里只在没显式配置时放宽默认值 —— 想限制仍然可以设环境变量。
 */
const effectiveEnv =
  bundle.active === 'local'
    ? {
        ...process.env,
        P3D_IP_DAILY_QUOTA: process.env.P3D_IP_DAILY_QUOTA ?? '10000',
        P3D_DAILY_BUDGET_YUAN: process.env.P3D_DAILY_BUDGET_YUAN ?? '10000',
      }
    : process.env;

const handle = createHandler({
  store,
  provider,
  env: effectiveEnv,
  providerReport: { wanted: bundle.wanted, active: bundle.active, reason: bundle.reason },
});

async function readBody(request: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function toHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(', '));
    else if (typeof value === 'string') headers.set(key, value);
  }
  // 给 handler 一个可信的客户端 IP：反代场景下 x-forwarded-for 已存在则保留
  if (!headers.has('x-forwarded-for')) {
    const remote = request.socket.remoteAddress ?? 'unknown';
    headers.set('x-forwarded-for', remote);
  }
  return headers;
}

const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
  const started = Date.now();
  const method = request.method ?? 'GET';
  const host = request.headers.host ?? `${HOST}:${PORT}`;
  const url = new URL(request.url ?? '/', `http://${host}`);

  let body: Buffer | null = Buffer.alloc(0);
  if (method !== 'GET' && method !== 'HEAD') {
    body = await readBody(request);
    if (body === null) {
      response.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'BAD_REQUEST', message: '请求体太大' }));
      return;
    }
  }

  const webRequest = new Request(url, {
    method,
    headers: toHeaders(request),
    // Buffer 的 ArrayBufferLike 泛型与 BodyInit 不兼容，包一层 Uint8Array
    body: method === 'GET' || method === 'HEAD' || body === null ? undefined : new Uint8Array(body),
  });

  try {
    const webResponse = await handle(webRequest);
    const payload = Buffer.from(await webResponse.arrayBuffer());
    const headers: Record<string, string> = {};
    webResponse.headers.forEach((value, key) => {
      headers[key] = value;
    });
    response.writeHead(webResponse.status, headers);
    response.end(payload);
    if (process.env.P3D_LOG !== '0') {
      console.log(`${method} ${url.pathname} → ${webResponse.status} (${Date.now() - started}ms)`);
    }
  } catch (caught) {
    console.error('handler 抛异常', caught);
    response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'UPSTREAM_ERROR', message: '服务端异常' }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`p3d api  →  http://${HOST}:${PORT}`);
  console.log(
    `  provider = ${bundle.active}${bundle.reason ? `（${bundle.reason}）` : ''}   data = ${DATA_FILE}`,
  );
  const quota = effectiveEnv.P3D_IP_DAILY_QUOTA ?? '10';
  const budget = effectiveEnv.P3D_DAILY_BUDGET_YUAN ?? '30';
  if (bundle.active === 'local') {
    console.log('  本地推理：不花钱、不计配额（额度仍可显式配置）');
    console.log(`  引擎地址：${process.env.P3D_ENGINE_URL ?? 'http://127.0.0.1:8188'}`);
  } else {
    console.log(
      `  闸门：单 IP ${quota} 次/日，全局预算 ¥${budget}/日，熔断 ${process.env.P3D_KILL_SWITCH === '1' ? 'ON' : 'OFF'}`,
    );
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n收到 ${signal}，关闭 api`);
    server.close(() => process.exit(0));
  });
}
