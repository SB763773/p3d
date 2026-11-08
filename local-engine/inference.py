"""TripoSR 推理封装。

在本机 RTX 5060（8 GB，sm_120）上跑，不依赖任何账号、任何云服务。

设计约束（都是踩出来的）
------------------------
1. **HF_ENDPOINT 必须在 import transformers 之前设置**。torch/transformers 是懒加载
   网络模块的，晚一步设置就会去连 huggingface.co，国内直接挂住 30 秒再失败。
2. **显存是硬约束**。8 GB 卡在 Windows WDDM 下实际可用约 6 GB，系统本身还要占一部分。
   marching cubes 分辨率 256 时峰值最高，OOM 就自动降档重试（见 `_generate_with_fallback`）。
3. **顶点色而不是烘焙纹理**。烘焙要走 xatlas + moderngl（需要 OpenGL 上下文，在无头
   服务里容易崩），而顶点色对"先能转着看"这个目标完全够用，且 GLB 体积小一半。
"""

from __future__ import annotations

import os
import time

# 必须在 transformers / huggingface_hub 被 import 之前生效
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

from pathlib import Path  # noqa: E402

import torch  # noqa: E402
import trimesh  # noqa: E402
from PIL import Image  # noqa: E402

from tsr.system import TSR  # noqa: E402
from tsr.utils import resize_foreground  # noqa: E402

# 从低到高试；显存不足时依次降档。192 是能看出形状的下限，再低就糊成球了。
MC_RESOLUTIONS = (256, 224, 192, 160)


class OomError(RuntimeError):
    pass


class TripoEngine:
    def __init__(self, model_dir: str | Path, device: str = "cuda") -> None:
        self.model_dir = str(model_dir)
        self.device = device
        self.mc_resolution = MC_RESOLUTIONS[0]

        started = time.time()
        self.model = TSR.from_pretrained(
            self.model_dir,
            config_name="config.yaml",
            weight_name="model.ckpt",
        )
        # 分块大小决定单次 NeRF 查询的显存量。8192 是官方推荐值，
        # 在 8 GB 卡上刚好；调大容易 OOM，调小只是变慢。
        self.model.renderer.set_chunk_size(8192)
        self.model.to(device)
        self.model.eval()
        self.load_seconds = round(time.time() - started, 1)

    # ---------------------------------------------------------------- 推理

    def generate(self, image: Image.Image, foreground_ratio: float = 0.85):
        """一张图 → 一个 trimesh.Trimesh（带顶点色）。"""
        prepared = self._prepare(image, foreground_ratio)
        return self._generate_with_fallback(prepared)

    def _prepare(self, image: Image.Image, foreground_ratio: float) -> Image.Image:
        rgba = image.convert("RGBA")

        # 前端已经去过背景并裁到主体包围盒。这里再判一次：
        # 如果 alpha 全不透明（说明前端那步被跳过或失败），仍然跑，只是结果会差些。
        alpha = rgba.getchannel("A")
        has_alpha = alpha.getextrema()[0] < 255

        try:
            rgba = resize_foreground(rgba, foreground_ratio)
        except Exception:
            # resize_foreground 在主体贴边时会算不出包围盒，此时保持原图更安全
            pass

        if not has_alpha:
            return rgba.convert("RGB")

        # 必须是 RGB：上游 ImagePreprocessor 只做缩放、不处理通道，
        # 而 ViT 的 patch_embed 是 Conv2d(3, …)，喂 4 通道会直接报维度错。
        # 透明区域合成为白色 —— TripoSR 训练数据就是白底抠图，这个底色它认识。
        canvas = Image.new("RGB", rgba.size, (255, 255, 255))
        canvas.paste(rgba, mask=rgba.getchannel("A"))
        return canvas

    def _generate_with_fallback(self, image: Image.Image):
        last_error: Exception | None = None
        for resolution in MC_RESOLUTIONS:
            if resolution > self.mc_resolution and last_error is not None:
                continue  # 已经降过档，不要又跳回去
            try:
                mesh = self._run_once(image, resolution)
                self.mc_resolution = resolution  # 记住这次成功的档位，下次直接用
                return mesh
            except torch.cuda.OutOfMemoryError as error:
                last_error = error
                torch.cuda.empty_cache()
                continue
            except RuntimeError as error:
                # Windows 上显存不足有时抛的是普通 RuntimeError，消息里带 out of memory
                if "out of memory" not in str(error).lower():
                    raise
                last_error = error
                torch.cuda.empty_cache()
                continue
        raise OomError(f"显存不足，降到 {MC_RESOLUTIONS[-1]} 仍失败：{last_error}")

    def _run_once(self, image: Image.Image, resolution: int):
        with torch.inference_mode():
            scene_codes = self.model([image], device=self.device)
            meshes = self.model.extract_mesh(
                scene_codes,
                has_vertex_color=True,
                resolution=resolution,
            )
        mesh = meshes[0]
        if mesh.vertices.shape[0] == 0 or mesh.faces.shape[0] == 0:
            raise RuntimeError("生成的网格是空的，可能是这张图里没有可识别的主体")
        return mesh

    # ---------------------------------------------------------------- 导出

    @staticmethod
    def export_glb(mesh, path: Path) -> int:
        path.parent.mkdir(parents=True, exist_ok=True)
        mesh.export(str(path), file_type="glb")
        return path.stat().st_size

    # ---------------------------------------------------------------- 状态

    def describe(self) -> dict:
        info = {
            "device": self.device,
            "loadSeconds": self.load_seconds,
            "mcResolution": self.mc_resolution,
            "torch": torch.__version__,
            "cuda": torch.version.cuda,
        }
        if self.device.startswith("cuda") and torch.cuda.is_available():
            index = torch.cuda.current_device()
            info["gpu"] = torch.cuda.get_device_name(index)
            free, total = torch.cuda.mem_get_info(index)
            info["vramFreeMB"] = round(free / 1024 / 1024)
            info["vramTotalMB"] = round(total / 1024 / 1024)
        return info


def pick_device(prefer: str = "cuda") -> str:
    if prefer.startswith("cuda") and torch.cuda.is_available():
        return prefer
    return "cpu"
