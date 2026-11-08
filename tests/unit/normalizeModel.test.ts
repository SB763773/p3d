import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { computeNormalizeTransform, measureModel, normalizeModel } from '@/lib/normalizeModel';

describe('computeNormalizeTransform', () => {
  it('把最长边归一化为 1，并给出相对比例', () => {
    const box = new THREE.Box3(new THREE.Vector3(-2, -1, -0.5), new THREE.Vector3(2, 1, 0.5));
    const transform = computeNormalizeTransform(box);

    expect(transform.scale).toBeCloseTo(0.25);
    expect(transform.ratio).toEqual([1, 0.5, 0.25]);
  });

  it('退化模型（尺寸为 0）不产生 Infinity', () => {
    const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0));
    const transform = computeNormalizeTransform(box);

    expect(transform.scale).toBe(1);
    expect(Number.isFinite(transform.scale)).toBe(true);
  });
});

describe('normalizeModel', () => {
  it('任意尺寸、任意位置的模型都能变成"最长边 1、底面贴地、居中"', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(200, 100, 50));
    mesh.position.set(3000, 500, -800);

    normalizeModel(mesh);

    const box = new THREE.Box3().setFromObject(mesh);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    expect(Math.max(size.x, size.y, size.z)).toBeCloseTo(1, 5);
    // 关键回归点：曾经因为按"世界原点"换算平移量，把模型挪到了半空
    expect(box.min.y).toBeCloseTo(0, 5);
    expect(center.x).toBeCloseTo(0, 5);
    expect(center.z).toBeCloseTo(0, 5);
  });

  it('已归一化的模型再次归一化不会漂移（幂等）', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(3, 7, 1));
    normalizeModel(mesh);
    const box1 = new THREE.Box3().setFromObject(mesh);
    const size1 = box1.getSize(new THREE.Vector3());

    normalizeModel(mesh);
    const box2 = new THREE.Box3().setFromObject(mesh);
    const size2 = box2.getSize(new THREE.Vector3());

    expect(size2.x).toBeCloseTo(size1.x, 5);
    expect(size2.y).toBeCloseTo(size1.y, 5);
    expect(size2.z).toBeCloseTo(size1.z, 5);
    expect(box2.min.y).toBeCloseTo(0, 5);
  });

  it('父级只有平移时依然贴地（场景里模型都挂在定位 group 下）', () => {
    const parent = new THREE.Group();
    parent.position.set(1.4, 0, 0);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 4, 6));
    mesh.position.set(2, 3, 1);
    parent.add(mesh);

    normalizeModel(mesh);

    const box = new THREE.Box3().setFromObject(mesh);
    expect(box.min.y).toBeCloseTo(0, 5);
    expect(
      Math.max(box.getSize(new THREE.Vector3()).x, box.getSize(new THREE.Vector3()).y),
    ).toBeLessThanOrEqual(1.0001);
  });
});

describe('measureModel', () => {
  it('只测量，不改变对象', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 1));
    const before = mesh.position.clone();
    const measured = measureModel(mesh);

    expect(measured.ratio).toEqual([1, 0.5, 0.25]);
    expect(mesh.position.equals(before)).toBe(true);
    expect(mesh.scale.x).toBe(1);
  });
});
