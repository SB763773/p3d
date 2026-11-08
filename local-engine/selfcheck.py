"""环境自检。

这套东西的失败点很多（CUDA 版本、算力不匹配、模型没下全、GLB 导出缺依赖），
与其等 `npm run engine` 起不来再猜，不如一次把该验的都验一遍。

    python selfcheck.py            全检（含加载 1.56 GB 模型，约 40 秒）
    python selfcheck.py --quick    跳过模型加载，3 秒内出结果
"""

from __future__ import annotations

import os
import sys
import tempfile

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

from pathlib import Path  # noqa: E402

ENGINE_DIR = Path(__file__).parent
MODEL_DIR = ENGINE_DIR / "models" / "TripoSR"

failures: list[str] = []


def step(name: str) -> None:
    print(f"\n[{name}]")


def ok(text: str) -> None:
    print(f"  OK   {text}")


def bad(text: str, hint: str = "") -> None:
    print(f"  FAIL {text}")
    if hint:
        print(f"       → {hint}")
    failures.append(text)


print(f"Python {sys.version.split()[0]}  ({sys.executable})")

# ---------------------------------------------------------------- 系统策略
step("Windows 应用控制策略")
try:
    import regex

    ok(f"regex 可加载（{regex.__version__}）")
except ImportError as error:
    bad(
        f"regex 的 C 扩展加载不了：{error}",
        "这是 Smart App Control / WDAC 拦了 _regex*.pyd。"
        "先试 pip install regex==2024.11.6（旧版二进制一般能过）；"
        "实在不行只能在 Windows 安全中心关掉 Smart App Control（会降低防护，自己权衡）。"
        "注意 transformers 5.x 会强制要新版 regex，所以这里配套锁了 transformers<5。",
    )

# ---------------------------------------------------------------- PyTorch
step("PyTorch / CUDA")
try:
    import torch

    ok(f"torch {torch.__version__}（CUDA 编译版本 {torch.version.cuda}）")

    if not torch.cuda.is_available():
        bad(
            "torch.cuda.is_available() = False",
            "装了 CPU 版轮子。重装：pip install torch torchvision "
            "--index-url https://download.pytorch.org/whl/cu128",
        )
    else:
        index = torch.cuda.current_device()
        name = torch.cuda.get_device_name(index)
        major, minor = torch.cuda.get_device_capability(index)
        free, total = torch.cuda.mem_get_info(index)
        ok(f"GPU {name}（sm_{major}{minor}，显存 {total // 1024**2} MB，空闲 {free // 1024**2} MB）")

        if free / 1024**2 < 4500:
            print(
                f"  警告 可用显存只有 {free // 1024**2} MB。TripoSR 需要约 4.5 GB，\n"
                "       建议关掉游戏、安卓模拟器、多的浏览器标签页。"
            )

        # Blackwell（sm_120）需要新版轮子。跑一次真实算子才知道里面有没有对应 kernel，
        # 只看 is_available() 是不够的 —— 老轮子在 50 系上会"能初始化但一算就炸"。
        try:
            a = torch.randn(256, 256, device="cuda", dtype=torch.float16)
            _ = a @ a
            torch.cuda.synchronize()
            ok("CUDA kernel 实跑通过（半精度矩阵乘）")
        except Exception as error:  # noqa: BLE001
            bad(
                f"GPU 上跑不了算子：{error}",
                "多半是 torch 版本不认这张卡（sm_120 需要 CUDA 12.8+ 的轮子）",
            )
except Exception as error:  # noqa: BLE001
    bad(f"import torch 失败：{error}")

# ---------------------------------------------------------------- marching cubes
step("Marching Cubes 后端")
try:
    from tsr.models import _mcubes_compat

    ok(f"使用 {_mcubes_compat.backend_name()}（替代 torchmcubes，无需编译）")
except Exception as error:  # noqa: BLE001
    bad(f"兼容层加载失败：{error}")

# ---------------------------------------------------------------- GLB 导出
step("GLB 导出")
try:
    import trimesh

    box = trimesh.creation.box()
    out = Path(tempfile.gettempdir()) / "p3d_selfcheck.glb"
    box.export(str(out), file_type="glb")
    size = out.stat().st_size
    out.unlink(missing_ok=True)
    ok(f"trimesh {trimesh.__version__} 可导出 GLB（{size} 字节）")
except Exception as error:  # noqa: BLE001
    bad(f"GLB 导出失败：{error}", "pip install pygltflib")

# ---------------------------------------------------------------- 模型文件
step("模型权重")
weights = MODEL_DIR / "model.ckpt"
config = MODEL_DIR / "config.yaml"
if not config.exists():
    bad("缺 config.yaml", "跑 npm run engine:setup")
elif not weights.exists():
    bad("缺 model.ckpt", "跑 npm run engine:setup")
else:
    gb = weights.stat().st_size / 1024**3
    if gb < 1.5:
        bad(f"model.ckpt 只有 {gb:.2f} GB（应为 1.56 GB）", "下载没完成，重跑 npm run engine:setup 续传")
    else:
        ok(f"model.ckpt {gb:.2f} GB，config.yaml 就位")

# ---------------------------------------------------------------- 加载模型
quick = "--quick" in sys.argv
if quick:
    print("\n（--quick：跳过模型加载）")
elif not weights.exists():
    print("\n（权重不全，跳过模型加载）")
else:
    step("加载模型")
    try:
        import time

        from inference import TripoEngine, pick_device

        started = time.time()
        engine = TripoEngine(MODEL_DIR, device=pick_device())
        ok(f"加载成功，用时 {time.time() - started:.1f}s")
        for key, value in engine.describe().items():
            print(f"       {key}: {value}")
    except Exception as error:  # noqa: BLE001
        bad(f"模型加载失败：{type(error).__name__}: {error}")

# ---------------------------------------------------------------- 结论
print()
if failures:
    print(f"有 {len(failures)} 项没通过：")
    for item in failures:
        print(f"  - {item}")
    sys.exit(1)
print("全部通过。可以 npm run engine 了。")
