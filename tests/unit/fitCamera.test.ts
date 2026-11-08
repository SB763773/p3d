import { describe, expect, it } from 'vitest';
import { computeFitDistance } from '@/lib/fitCamera';

describe('computeFitDistance', () => {
  it('物体越大，相机退得越远（线性）', () => {
    const small = computeFitDistance({ x: 1, y: 1, z: 1 }, 40, 1.6);
    const big = computeFitDistance({ x: 2, y: 2, z: 2 }, 40, 1.6);
    expect(big).toBeCloseTo(small * 2, 5);
  });

  it('只按最长边算，扁的东西不会因为宽度多退', () => {
    const cube = computeFitDistance({ x: 1, y: 1, z: 1 }, 40, 1.6);
    const flat = computeFitDistance({ x: 1, y: 0.2, z: 0.3 }, 40, 1.6);
    expect(flat).toBeCloseTo(cube, 5);
  });

  it('竖屏（aspect < 1）需要比横屏退得更远', () => {
    const landscape = computeFitDistance({ x: 1, y: 1, z: 1 }, 40, 1.6);
    const portrait = computeFitDistance({ x: 1, y: 1, z: 1 }, 40, 0.5);
    expect(portrait).toBeGreaterThan(landscape);
  });

  it('margin 直接按倍数放大距离', () => {
    const tight = computeFitDistance({ x: 1, y: 1, z: 1 }, 40, 1.6, 1);
    const loose = computeFitDistance({ x: 1, y: 1, z: 1 }, 40, 1.6, 2);
    expect(loose).toBeCloseTo(tight * 2, 5);
  });

  it('退化尺寸不给 NaN / Infinity，退回一个安全距离', () => {
    expect(computeFitDistance({ x: 0, y: 0, z: 0 }, 40, 1.6)).toBe(3);
    expect(Number.isFinite(computeFitDistance({ x: Number.NaN, y: 0, z: 0 }, 40, 1.6))).toBe(true);
  });
});
