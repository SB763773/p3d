/**
 * 冒烟测试的启动器：自己拉起 BFF + preview、跑完再关掉。
 *
 * 为什么需要它：
 * 1. `vite preview` 用的是 sirv，启动时就把 dist 扫进了内存索引 ——
 *    "先起 preview 再 build"会让新 chunk 404，页面卡在懒加载骨架屏上。
 * 2. BFF 是独立进程，不起它 /api 就 404，页面看起来"生成不了"。
 * 3. 每次跑都用全新的数据文件，避免反复跑把每日配额刷满导致假失败。
 *
 * 也可以对已有服务跑：P3D_BASE_URL=http://127.0.0.1:5173 node tests/e2e/smoke.mjs
 */
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const WEB_PORT = 4173;
const API_PORT = 8787;
const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;
const API_URL = `http://127.0.0.1:${API_PORT}`;
const DATA_FILE = resolve('.data/smoke-jobs.json');

function spawnProcess(args, env = {}) {
  return spawn(process.execPath, args, {
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(' ')} 退出码 ${code}`));
    });
  });
}

async function waitFor(url, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${url} 在 ${timeoutMs / 1000} 秒内没有起来`);
}

await rm(DATA_FILE, { force: true });

const api = spawnProcess(['--experimental-strip-types', 'server/index.ts'], {
  P3D_API_PORT: String(API_PORT),
  P3D_DATA_FILE: DATA_FILE,
  P3D_LOG: '0',
});

const preview = spawnProcess(
  [
    resolve('node_modules/vite/bin/vite.js'),
    'preview',
    '--port',
    String(WEB_PORT),
    '--host',
    '127.0.0.1',
  ],
  { P3D_API_PORT: String(API_PORT) },
);

let exitCode = 1;
try {
  await waitFor(`${API_URL}/api/health`);
  await waitFor(BASE_URL);
  await run(process.execPath, ['tests/e2e/smoke.mjs'], {
    env: { ...process.env, P3D_BASE_URL: BASE_URL },
  });
  exitCode = 0;
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : error}`);
} finally {
  api.kill('SIGTERM');
  preview.kill('SIGTERM');
}

process.exit(exitCode);
