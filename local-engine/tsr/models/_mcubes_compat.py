"""torchmcubes 的替代实现。

为什么需要它
------------
TripoSR 原版用 `torchmcubes` 做 marching cubes，那是个需要 CMake + MSVC 现场编译的
C++ 扩展。Windows 上没装 Visual Studio Build Tools 就装不上，而本项目的目标恰恰是
"不依赖任何账号、不依赖任何云服务，在自己机器上跑起来"。

`PyMCubes` 在 PyPI 上有 Windows 预编译包，安装即用。算法（Lorensen & Cline 的
marching cubes）与 torchmcubes 同源，返回约定也一致：

    verts: (N, 3) float，体素坐标（0 .. res-1）
    faces: (M, 3) int，顶点索引

所以只换这一个函数，其余代码（isosurface.IsosurfaceHelper 的坐标翻转、
scale_tensor 的区间映射）一行都不用动。
"""

from __future__ import annotations

import numpy as np
import torch

try:
    # 注意：PyPI 包名是 PyMCubes，import 名却是 mcubes
    import mcubes as _mcubes

    _IMPL = "pymcubes"
except ImportError:  # 兜底：scikit-image 也有实现，只是慢一些
    from skimage import measure as _measure

    _IMPL = "skimage"

    def _fallback(volume: np.ndarray, level: float):
        verts, faces, _normals, _values = _measure.marching_cubes(volume, level)
        return verts, faces

    _mcubes = None


def marching_cubes(volume: torch.Tensor | np.ndarray, level: float):
    """与 `torchmcubes.marching_cubes(volume, level)` 保持同样的返回类型。

    调用方（`MarchingCubeHelper.forward`）会把结果 `.to(level.device)` 并且
    按 `[..., [2, 1, 0]]` 翻轴，所以这里只需要保证坐标系和索引类型正确。
    """
    if isinstance(volume, torch.Tensor):
        array = volume.detach().cpu().numpy()
    else:
        array = np.asarray(volume)

    # PyMCubes 要求 C 连续的 float32/float64 三维数组，非连续会直接报错
    array = np.ascontiguousarray(array, dtype=np.float32)

    if _mcubes is not None:
        verts, faces = _mcubes.marching_cubes(array, float(level))
    else:
        verts, faces = _fallback(array, float(level))

    return (
        torch.from_numpy(np.ascontiguousarray(verts, dtype=np.float32)),
        torch.from_numpy(np.ascontiguousarray(faces, dtype=np.int64)),
    )


def backend_name() -> str:
    return _IMPL
