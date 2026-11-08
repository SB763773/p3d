/**
 * 自动取景的数学部分。
 *
 * 为什么不直接用 drei 的 <Bounds fit>：它的 fit 在挂载时算一次，
 * 而模型是走 Suspense 异步加载的 —— 挂载那一刻画布里还是空的，
 * 于是取景算了个寂寞，模型最终只占屏幕一小块。
 * 自己算距离的好处是：可单测、可解释、什么时候重算完全由我们决定。
 */

/** 让 size 尺寸的包围盒刚好填满视野所需的相机距离 */
export function computeFitDistance(
  size: { x: number; y: number; z: number },
  fovDeg: number,
  aspect: number,
  margin = 1.25,
): number {
  const maxDim = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(maxDim) || maxDim <= 0) return 3;

  const fovRad = (fovDeg * Math.PI) / 180;
  // 竖直方向能容纳的高度 = 2 * d * tan(fov/2)
  const fitHeight = maxDim / (2 * Math.tan(fovRad / 2));
  // 横向视野 = 竖直视野 × aspect，所以窄屏（手机竖屏）必须退得更远
  const fitWidth = fitHeight / Math.max(aspect, 0.2);

  return margin * Math.max(fitHeight, fitWidth);
}
