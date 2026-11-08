import * as THREE from 'three';

export interface NormalizeTransform {
  /** 等比缩放系数：最长边 → 1.0 */
  scale: number;
  /** 归一化后的相对比例（最长边 = 1） */
  ratio: [number, number, number];
}

/**
 * 纯计算：给定世界包围盒，算出缩放系数与相对比例。
 *
 * 这里刻意不返回"平移量"——缩放是绕物体自身原点发生的，
 * 不是绕世界原点，所以平移必须在缩放**之后**重新量一次包围盒才能算准。
 * 早期版本在这里想当然地按世界原点换算，结果模型被挪到了半空（497.5 单位那种）。
 */
export function computeNormalizeTransform(box: THREE.Box3): NormalizeTransform {
  const size = box.getSize(new THREE.Vector3());
  const maxAxis = Math.max(size.x, size.y, size.z);

  // 退化情况（空模型 / 单点）：不缩放，避免除零得到 Infinity
  if (!Number.isFinite(maxAxis) || maxAxis <= 1e-9) {
    return { scale: 1, ratio: [1, 1, 1] };
  }

  const scale = 1 / maxAxis;
  return {
    scale,
    ratio: [size.x * scale, size.y * scale, size.z * scale].map(round3) as [number, number, number],
  };
}

/**
 * 就地把任意尺寸模型归一化：最长边 1.0、包围盒底面中心落在原点。
 *
 * 前提：调用对象的父级只有平移、没有旋转/缩放（本项目里父级就是一个定位用的 group）。
 */
export function normalizeModel(object: THREE.Object3D): NormalizeTransform {
  object.updateMatrixWorld(true);
  const transform = computeNormalizeTransform(new THREE.Box3().setFromObject(object));

  object.scale.multiplyScalar(transform.scale);
  object.updateMatrixWorld(true);

  // 缩放之后重新量，才能把底面中心准确对齐到 (0,0,0)
  const scaled = new THREE.Box3().setFromObject(object);
  const center = scaled.getCenter(new THREE.Vector3());
  object.position.x -= center.x;
  object.position.y -= scaled.min.y;
  object.position.z -= center.z;
  object.updateMatrixWorld(true);

  return transform;
}

/** 只读地取归一化比例，不改动对象（用于 UI 显示"高:宽:深"） */
export function measureModel(object: THREE.Object3D): NormalizeTransform {
  return computeNormalizeTransform(new THREE.Box3().setFromObject(object));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
