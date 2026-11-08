import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 一次性把本地推理环境装好。
 *
 * 为什么不用 requirements.txt 一条命令搞定：torch 必须从 PyTorch 的 cu128 源装，
 * 而其余包走国内镜像更快。两个 index 混在 requirements.txt 里会让 pip 解析变慢甚至选错版本，
 * 所以分两步装。
 *
 * 全部可重复执行：已装好的步骤会跳过，权重支持断点续传。
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const engineDir = path.join(root, 'local-engine');
const venvDir = path.join(engineDir, '.venv');
const venvPython = path.join(venvDir, 'Scripts', 'python.exe');
const modelDir = path.join(engineDir, 'models', 'TripoSR');

const PYPI_MIRROR = 'https://mirrors.aliyun.com/pypi/simple/';
const TORCH_INDEX = 'https://download.pytorch.org/whl/cu128';
const HF_MIRROR = 'https://hf-mirror.com';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`)),
    );
  });
}

function findSystemPython() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Python311', 'python.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Python312', 'python.exe'),
    'C:\\Python311\\python.exe',
    'C:\\Python312\\python.exe',
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function main() {
  console.log('\n=== 1/4 检查 Python ===');

  if (!existsSync(venvPython)) {
    const base = findSystemPython();
    if (!base) {
      console.error(`
没找到 Python 3.11 / 3.12。

装一个（国内镜像，约 25 MB）：
  1. 下载 https://mirrors.aliyun.com/python-release/windows/python-3.11.9-amd64.exe
  2. 安装时勾选 "Add python.exe to PATH"
  3. 重新运行 npm run engine:setup

提示：不要用 Microsoft Store 里的 Python，它的路径会被 App Execution Alias
劫持成 python.exe 存根，pip 装完找不到。
`);
      process.exit(1);
    }
    console.log(`用 ${base} 建虚拟环境`);
    mkdirSync(venvDir, { recursive: true });
    await run(base, ['-m', 'venv', venvDir]);
  }
  const py = existsSync(venvPython) ? venvPython : path.join(venvDir, 'bin', 'python');
  console.log(`✓ venv: ${py}`);

  console.log('\n=== 2/4 装 PyTorch（CUDA 12.8，RTX 50 系必需）===');
  await run(py, ['-m', 'pip', 'install', '--upgrade', 'pip', '-q', '-i', PYPI_MIRROR]);
  await run(py, ['-m', 'pip', 'install', 'torch', 'torchvision', '--index-url', TORCH_INDEX]);

  console.log('\n=== 3/4 装其余依赖 ===');
  await run(py, [
    '-m',
    'pip',
    'install',
    '-r',
    path.join(engineDir, 'requirements.txt'),
    '-i',
    PYPI_MIRROR,
  ]);

  console.log('\n=== 4/4 下载模型权重（1.56 GB）===');
  mkdirSync(modelDir, { recursive: true });

  const files = [
    { name: 'config.yaml', url: `${HF_MIRROR}/stabilityai/TripoSR/resolve/main/config.yaml` },
    { name: 'model.ckpt', url: `${HF_MIRROR}/stabilityai/TripoSR/resolve/main/model.ckpt` },
  ];
  for (const file of files) {
    const dest = path.join(modelDir, file.name);
    console.log(`→ ${file.name}`);
    // -C - 断点续传：网络断了重跑本脚本即可接着下
    await run('curl', [
      '-L',
      '--retry',
      '3',
      '--retry-delay',
      '2',
      '-C',
      '-',
      '-o',
      dest,
      file.url,
    ]);
  }

  console.log('\n=== 自检 ===');
  await run(py, [path.join(engineDir, 'selfcheck.py')], { cwd: engineDir });

  console.log(`
装完了。

  npm run engine         # 起推理引擎（加载约 30 秒）
  npm run dev:local      # 另开一个终端：起 api + 前端，且 provider 用 local
`);
}

main().catch((error) => {
  console.error(`\n失败：${error.message}`);
  process.exit(1);
});
