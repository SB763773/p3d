/**
 * 场景摆放的纯计算。
 *
 * 抽出来是因为这些规则（沿 X 轴找空位、缩放上下限）错了不会报错，
 * 只会让用户觉得"模型怎么叠在一起了"，很难靠肉眼发现 —— 得有单测盯着。
 */

/** 相邻模型之间的默认间距（模型最长边已归一化为 1） */
export const SLOT_STEP = 1.4;

export const SCALE_MIN = 0.2;
export const SCALE_MAX = 4;

/**
 * 找一个没被占用的 X 槽位。
 * 用 Set 记录已占用槽位而不是"数量 × 间距"，这样删掉中间某个模型后，
 * 新加入的模型会补进空位，而不是越排越远。
 */
export function findFreeSlotX(positionsX: readonly number[], step = SLOT_STEP): number {
  if (positionsX.length === 0) return 0;
  const occupied = new Set(positionsX.map((x) => Math.round(x / step)));
  let slot = 0;
  while (occupied.has(slot)) slot += 1;
  return Number((slot * step).toFixed(3));
}

/** TransformControls 的 scale 是三轴的，这里统一成等比标量并夹到合理区间 */
export function clampScale(value: number, min = SCALE_MIN, max = SCALE_MAX): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(max, Math.max(min, value));
}

/** 把三轴缩放收成一个等比标量：取几何平均，比取算术平均更不容易被单轴抖动带偏 */
export function uniformScaleFrom(
  scale: { x: number; y: number; z: number },
  min = SCALE_MIN,
  max = SCALE_MAX,
): number {
  const values = [scale.x, scale.y, scale.z].filter((v) => Number.isFinite(v) && v > 0);
  if (values.length === 0) return 1;
  const geometric = Math.cbrt(values.reduce((acc, v) => acc * v, 1));
  return clampScale(geometric, min, max);
}

/** 位置保留 3 位小数，避免 localStorage 里塞一堆浮点噪声 */
export function roundPosition(position: readonly number[]): [number, number, number] {
  return [
    Number((position[0] ?? 0).toFixed(3)),
    Number((position[1] ?? 0).toFixed(3)),
    Number((position[2] ?? 0).toFixed(3)),
  ];
}

/** 角度（弧度）归一化到 [-π, π]，并保留 4 位 */
export function normalizeRotation(rotation: readonly number[]): [number, number, number] {
  const wrap = (value: number | undefined) => {
    const raw = value ?? 0;
    const wrapped = Math.atan2(Math.sin(raw), Math.cos(raw));
    return Number(wrapped.toFixed(4));
  };
  return [wrap(rotation[0]), wrap(rotation[1]), wrap(rotation[2])];
}

/** 只取 TransformControls 能改的那几个字段，便于单测与类型隔离 */
export interface TransformableLike {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
}

export interface ReadTransform {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: number;
}

/**
 * 从被拖动过的 Object3D 读出要写回 store 的变换。
 *
 * 为什么要"读"而不是直接沿用 gizmo 的矩阵：three 里的 rotation 是欧拉角，
 * 绕一圈下来可能累积成 6.5 弧度，直接存进 localStorage 会让下次加载明显不对；
 * 三轴缩放也会被拖成非等比，必须收敛成一个标量。
 */
export function readTransform(node: TransformableLike): ReadTransform {
  return {
    position: roundPosition([node.position.x, node.position.y, node.position.z]),
    rotation: normalizeRotation([node.rotation.x, node.rotation.y, node.rotation.z]),
    scale: uniformScaleFrom(node.scale),
  };
}
