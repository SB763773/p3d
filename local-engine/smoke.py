"""端到端冒烟：真的跑一次生成，确认「图进 → GLB 出」。

和 selfcheck 的分工：
- `selfcheck.py` 验环境能不能用（CUDA、mcubes、权重完整性）
- 这个验**结果对不对**：有没有顶点、有没有面、GLB 能不能被读回来

它不看模型好不好看 —— 那需要人眼判断。这里只保证链路没断。
换机器、换图、升级依赖后都可以跑一遍。
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

from PIL import Image, ImageDraw  # noqa: E402

from inference import TripoEngine, pick_device  # noqa: E402


def make_test_image(size: int = 768) -> Image.Image:
    """画一个浅色背景 + 暖色花瓶。背景纯、主体居中、色差大 —— 最容易成功的输入。"""
    image = Image.new("RGB", (size, size), (244, 242, 238))
    draw = ImageDraw.Draw(image)

    body = (196, 106, 72)
    dark = (150, 76, 48)

    draw.ellipse([size * 0.33, size * 0.38, size * 0.67, size * 0.82], fill=body)
    draw.rectangle([size * 0.46, size * 0.26, size * 0.54, size * 0.42], fill=body)
    draw.ellipse([size * 0.44, size * 0.24, size * 0.56, size * 0.29], fill=dark)

    # 一点高光，给模型一个"左侧受光"的线索
    draw.ellipse([size * 0.38, size * 0.46, size * 0.44, size * 0.66], fill=(222, 150, 118))

    return image


def main() -> int:
    out_dir = HERE / "out"
    out_dir.mkdir(parents=True, exist_ok=True)

    image_path = out_dir / "smoke-input.png"
    glb_path = out_dir / "smoke-output.glb"
    make_test_image().save(image_path)
    print(f"测试图：{image_path}")

    device = pick_device()
    print(f"设备：{device}")

    started = time.time()
    engine = TripoEngine(HERE / "models" / "TripoSR", device=device)
    print(f"模型加载：{engine.load_seconds}s")

    generate_started = time.time()
    mesh = engine.generate(Image.open(image_path))
    elapsed = time.time() - generate_started

    vertices = mesh.vertices.shape[0]
    faces = mesh.faces.shape[0]
    print(f"生成耗时：{elapsed:.1f}s   顶点 {vertices}   面 {faces}")

    if vertices == 0 or faces == 0:
        print("FAIL 空网格")
        return 1

    size = TripoEngine.export_glb(mesh, glb_path)
    print(f"GLB：{glb_path}  {size / 1024 / 1024:.2f} MB")

    import trimesh

    reloaded = trimesh.load(glb_path, force="mesh")
    print(f"回读：顶点 {len(reloaded.vertices)}   面 {len(reloaded.faces)}")

    print(f"总耗时：{time.time() - started:.1f}s")
    print("PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
