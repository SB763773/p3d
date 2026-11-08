import { describe, expect, it } from 'vitest';
import {
  clampScale,
  findFreeSlotX,
  normalizeRotation,
  readTransform,
  roundPosition,
  SLOT_STEP,
  uniformScaleFrom,
} from '@/lib/sceneLayout';

describe('findFreeSlotX', () => {
  it('空场景放在原点', () => {
    expect(findFreeSlotX([])).toBe(0);
  });

  it('依次往右排，不重叠', () => {
    expect(findFreeSlotX([0])).toBeCloseTo(SLOT_STEP);
    expect(findFreeSlotX([0, SLOT_STEP])).toBeCloseTo(SLOT_STEP * 2);
  });

  it('删掉中间的对象后，新对象补进空位而不是越排越远', () => {
    // 保留了 0 和 2×step，中间空着
    expect(findFreeSlotX([0, SLOT_STEP * 2])).toBeCloseTo(SLOT_STEP);
  });

  it('被用户拖到奇怪的位置也不会崩', () => {
    expect(findFreeSlotX([0.37, -2.11])).toBeCloseTo(SLOT_STEP);
    expect(Number.isFinite(findFreeSlotX([1e6]))).toBe(true);
  });
});

describe('scale', () => {
  it('clampScale 夹住上下限，非有限值退回 1', () => {
    expect(clampScale(10)).toBe(4);
    expect(clampScale(0.01)).toBe(0.2);
    expect(clampScale(Number.NaN)).toBe(1);
    expect(clampScale(1.5)).toBe(1.5);
  });

  it('三轴缩放取几何平均并夹住', () => {
    expect(uniformScaleFrom({ x: 2, y: 2, z: 2 })).toBeCloseTo(2);
    // 拖出非等比时取几何平均：∛(1·1·4) ≈ 1.5874
    expect(uniformScaleFrom({ x: 1, y: 1, z: 4 })).toBeCloseTo(Math.cbrt(4), 6);
    expect(uniformScaleFrom({ x: 0, y: 0, z: 0 })).toBe(1);
    expect(uniformScaleFrom({ x: 99, y: 99, z: 99 })).toBe(4);
  });
});

describe('roundPosition / normalizeRotation', () => {
  it('位置保留三位小数，丢掉浮点噪声', () => {
    expect(roundPosition([0.1 + 0.2, -1.00049, 12345.6789])).toEqual([0.3, -1, 12345.679]);
  });

  it('角度兜回 [-π, π]：绕一圈不会存成 6.28', () => {
    const [x] = normalizeRotation([Math.PI * 2, 0, 0]);
    expect(x).toBeCloseTo(0);
    const [y] = normalizeRotation([Math.PI * 1.5, 0, 0]);
    expect(y).toBeCloseTo(-Math.PI / 2, 4);
    const [z] = normalizeRotation([Math.PI / 3, 0, 0]);
    expect(z).toBeCloseTo(Math.PI / 3, 4);
  });
});

describe('readTransform', () => {
  it('把被拖动过的 Object3D 收敛成可持久化的变换', () => {
    const node = {
      position: { x: 1.23456, y: 0, z: -2 },
      rotation: { x: 0, y: Math.PI * 2.5, z: 0 },
      scale: { x: 2, y: 2, z: 2 },
    };
    const result = readTransform(node);

    expect(result.position).toEqual([1.235, 0, -2]);
    expect(result.rotation[1]).toBeCloseTo(Math.PI / 2, 4);
    expect(result.scale).toBeCloseTo(2);
  });

  it('非等比缩放不会被原样存进去', () => {
    const result = readTransform({
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 3, y: 3, z: 0.5 },
    });
    expect(result.scale).toBeGreaterThan(0.2);
    expect(result.scale).toBeLessThan(3);
  });
});
