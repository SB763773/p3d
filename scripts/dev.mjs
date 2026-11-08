import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * 一条命令同时起 api 与前端。
 *
 * 为什么需要它：BFF 是独立进程（node --experimental-strip-types server/index.ts），
 * 只跑 `vite` 的话 /api 会 404，页面看起来"生成不了"。
 * 两个进程的生命周期绑在一起，Ctrl+C 一次全退。
 */

const API_PORT = process.env.P3D_API_PORT ?? '8787';
const WEB_PORT = process.env.P3D_WEB_PORT ?? '5173';

// --provider=local 让 api 用本机显卡那套后端；不传就沿用环境变量或默认 mock
const providerArg = process.argv.slice(2).find((arg) => arg.startsWith('--provider='));
const provider = providerArg ? providerArg.slice('--provider='.length) : process.env.P3D_PROVIDER;

const children = [];

function launch(name, command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[${name}] 退出码 ${code}`);
      shutdown(code);
    }
  });
  children.push(child);
  return child;
}

let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 200);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

launch('api', process.execPath, ['--experimental-strip-types', 'server/index.ts'], {
  P3D_API_PORT: API_PORT,
  ...(provider ? { P3D_PROVIDER: provider } : {}),
});

launch(
  'web',
  process.execPath,
  [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)), '--port', WEB_PORT],
  {
    P3D_API_PORT: API_PORT,
  },
);

console.log(`\n开发环境：前端 http://127.0.0.1:${WEB_PORT}   api http://127.0.0.1:${API_PORT}`);
console.log(
  `生成后端：${provider ?? 'mock（默认）'}${provider === 'local' ? '  ← 需要另一个终端跑 npm run engine' : ''}\n`,
);
