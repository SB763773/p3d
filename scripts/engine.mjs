import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 起本地推理引擎（TripoSR on GPU）。
 *
 * 和 server/index.ts 一样是独立进程：它属于"上游"，不是 BFF 的一部分。
 * 分开的好处是引擎崩了（多半是显存）不会把 API 一起带走，
 * 前端还能拿到"引擎挂了"这个明确状态。
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const engineDir = path.join(root, 'local-engine');
const python = path.join(engineDir, '.venv', 'Scripts', 'python.exe');
const port = process.env.P3D_ENGINE_PORT ?? '8188';

if (!existsSync(python)) {
  console.error(`
还没建 Python 环境。

  npm run engine:setup      # 一次性，装 Python 依赖（约 4 GB 下载）

之后再来 npm run engine。
`);
  process.exit(1);
}

if (!existsSync(path.join(engineDir, 'models', 'TripoSR', 'model.ckpt'))) {
  console.error(`
模型权重还没下。

  npm run engine:setup      # 会把 model.ckpt（1.56 GB）一起下下来
`);
  process.exit(1);
}

console.log(`本地推理引擎 → http://127.0.0.1:${port}`);
console.log('首次启动要加载 1.56 GB 权重，约 30 秒，看到 "就绪" 再提交任务。\n');

const child = spawn(
  python,
  ['-m', 'uvicorn', 'engine:app', '--host', '127.0.0.1', '--port', port],
  {
    cwd: engineDir,
    stdio: 'inherit',
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  },
);

child.on('exit', (code) => {
  if (code === 0 || code === null) return;
  console.error(`\n引擎退出码 ${code}`);
  if (code === 3221225477) {
    console.error('这个码通常意味着显存不足或驱动异常。关掉游戏、模拟器再试。');
  }
  process.exit(code);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill('SIGTERM'));
}
