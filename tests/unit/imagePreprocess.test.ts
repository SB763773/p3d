import { describe, expect, it } from 'vitest';
import {
  alphaBoundingBox,
  chromaCutout,
  detectMimeFromMagic,
  expandBounds,
} from '@/lib/imagePreprocess';

function makeImage(
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number, number],
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fill(x, y);
      const index = (y * width + x) * 4;
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
      data[index + 3] = a;
    }
  }
  return data;
}

describe('detectMimeFromMagic', () => {
  it('认出 JPEG / PNG / WebP', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

    expect(detectMimeFromMagic(jpeg)).toBe('image/jpeg');
    expect(detectMimeFromMagic(png)).toBe('image/png');
    expect(detectMimeFromMagic(webp)).toBe('image/webp');
  });

  it('伪装成 .png 的文本被拒', () => {
    const fake = new TextEncoder().encode('<svg>not an image');
    expect(detectMimeFromMagic(fake)).toBeNull();
  });

  it('字节不足直接返回 null，不做越界读取', () => {
    expect(detectMimeFromMagic(new Uint8Array([0x89, 0x50]))).toBeNull();
  });
});

describe('alphaBoundingBox', () => {
  it('找的是 alpha 的紧致包围盒', () => {
    const width = 10;
    const height = 10;
    const data = makeImage(width, height, (x, y) =>
      x >= 3 && x <= 6 && y >= 2 && y <= 5 ? [255, 0, 0, 255] : [0, 0, 0, 0],
    );

    expect(alphaBoundingBox(data, width, height)).toEqual({ x: 3, y: 2, width: 4, height: 4 });
  });

  it('全透明返回 null（调用方要能处理"什么都没剩下"）', () => {
    const data = makeImage(4, 4, () => [0, 0, 0, 0]);
    expect(alphaBoundingBox(data, 4, 4)).toBeNull();
  });
});

describe('expandBounds', () => {
  it('外扩指定比例', () => {
    const bounds = expandBounds({ x: 4, y: 4, width: 2, height: 2 }, 0.5, 10, 10);
    expect(bounds).toEqual({ x: 3, y: 3, width: 4, height: 4 });
  });

  it('外扩不能越出画布', () => {
    const bounds = expandBounds({ x: 0, y: 0, width: 10, height: 10 }, 0.2, 10, 10);
    expect(bounds.x).toBe(0);
    expect(bounds.y).toBe(0);
    expect(bounds.width).toBe(10);
    expect(bounds.height).toBe(10);
  });
});

describe('chromaCutout', () => {
  it('纯色背景下只删与边缘连通的背景，不碰主体内部', () => {
    const width = 12;
    const height = 12;
    // 背景 #f0f0f0，中间 4×4 一块"白色但属于主体"的区域（颜色和背景几乎一样）
    const data = makeImage(width, height, (x, y) => {
      const inSubject = x >= 4 && x <= 7 && y >= 4 && y <= 7;
      const isHole = x >= 5 && x <= 6 && y >= 5 && y <= 6;
      if (inSubject) return isHole ? [240, 240, 240, 255] : [40, 80, 160, 255];
      return [240, 240, 240, 255];
    });

    const result = chromaCutout(data, width, height, 34);
    expect(result.applied).toBe(true);
    expect(result.removedRatio).toBeGreaterThan(0.5);

    const alphaAt = (x: number, y: number) => data[(y * width + x) * 4 + 3];
    // 角落背景被删
    expect(alphaAt(0, 0)).toBe(0);
    // 主体保留
    expect(alphaAt(4, 4)).toBe(255);
    // 主体内部的"洞"没有与边缘连通，必须保留 —— 这正是全局色键抠图会做错的地方
    expect(alphaAt(5, 5)).toBe(255);
  });

  it('背景杂乱（全图都被判为背景）时保护性放弃', () => {
    const width = 8;
    const height = 8;
    // 全图同色 → 泛洪会吃掉 100%，应当拒绝应用
    const data = makeImage(width, height, () => [18, 52, 86, 255]);
    const result = chromaCutout(data, width, height, 60);

    expect(result.applied).toBe(false);
    expect(result.removedRatio).toBe(0);
    // 放弃时不能改动 alpha
    expect(data[3]).toBe(255);
  });
});
