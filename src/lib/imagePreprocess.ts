import { sha256Hex } from '@/lib/hash';

/**
 * 图片预处理流水线（方案 §7.1）。
 *
 * 为什么这一步重要：单图转 3D 会把画面里的一切都当作待重建对象。
 * 背景是桌面、手、窗户，模型就会努力去"重建"这些，产出大量垃圾几何。
 * 去背景是提升输出质量性价比最高的单点优化。
 *
 * 全部在浏览器本地完成，原图不出设备。
 */

export const IMAGE_RULES = {
  maxBytes: 8 * 1024 * 1024,
  allowedMime: ['image/jpeg', 'image/png', 'image/webp'] as const,
  maxDimension: 4096,
  longEdge: 1024,
  /** 上传前的软上限，超过就降采样 */
  uploadSoftLimitBytes: 2 * 1024 * 1024,
} as const;

export type PreprocessStage = 'decode' | 'resize' | 'cutout' | 'crop' | 'encode' | 'hash';

export interface PreprocessOptions {
  /** 是否去背景。原图已是白底产品图时关掉更快 */
  removeBackground: boolean;
  /** 去背景容差 0–255，越大去掉越多 */
  tolerance?: number;
  onProgress?: (stage: PreprocessStage, value: number) => void;
}

export interface PreprocessResult {
  blob: Blob;
  dataUrl: string;
  hash: string;
  width: number;
  height: number;
  /** 被去掉的背景像素占比，用于提示"这张图可能不适合去背景" */
  removedRatio: number;
}

// ─────────────────────────────────────────────────────────────
// 校验
// ─────────────────────────────────────────────────────────────

export type ValidateResult =
  | { ok: true; mime: 'image/jpeg' | 'image/png' | 'image/webp' }
  | { ok: false; reason: string };

/** 从 magic bytes 判断真实类型。不能只信 Content-Type / 扩展名，那是可以伪造的 */
export function detectMimeFromMagic(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  const [b0, b1, b2, b3] = [bytes[0], bytes[1], bytes[2], bytes[3]];
  if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) return 'image/jpeg';
  if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47) return 'image/png';
  // RIFF....WEBP
  if (
    b0 === 0x52 &&
    b1 === 0x49 &&
    b2 === 0x46 &&
    b3 === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

export async function validateImageFile(file: File): Promise<ValidateResult> {
  if (file.size === 0) return { ok: false, reason: '文件是空的' };
  if (file.size > IMAGE_RULES.maxBytes) {
    return {
      ok: false,
      reason: `图片超过 ${Math.round(IMAGE_RULES.maxBytes / 1024 / 1024)} MB，请先压缩`,
    };
  }

  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const magic = detectMimeFromMagic(head);
  if (!magic || !IMAGE_RULES.allowedMime.includes(magic as never)) {
    return { ok: false, reason: '这不是 JPG / PNG / WebP 图片' };
  }
  return { ok: true, mime: magic as 'image/jpeg' | 'image/png' | 'image/webp' };
}

// ─────────────────────────────────────────────────────────────
// 纯函数：alpha 包围盒
// ─────────────────────────────────────────────────────────────

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 找 alpha > threshold 的紧致包围盒。全是透明像素时返回 null。
 * 纯函数，单测覆盖。
 */
export function alphaBoundingBox(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  threshold = 12,
): Bounds | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const alpha = rgba[row + x * 4 + 3];
      if (alpha !== undefined && alpha > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0 || maxY < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** 把包围盒外扩边距并夹到画布内。留白是为了避免主体贴边被模型截断 */
export function expandBounds(
  bounds: Bounds,
  paddingRatio: number,
  width: number,
  height: number,
): Bounds {
  const padX = Math.round(bounds.width * paddingRatio);
  const padY = Math.round(bounds.height * paddingRatio);
  const x = Math.max(0, bounds.x - padX);
  const y = Math.max(0, bounds.y - padY);
  const right = Math.min(width, bounds.x + bounds.width + padX);
  const bottom = Math.min(height, bounds.y + bounds.height + padY);
  return { x, y, width: right - x, height: bottom - y };
}

// ─────────────────────────────────────────────────────────────
// 去背景：边缘种子泛洪（纯 Canvas，零依赖、零下载）
// ─────────────────────────────────────────────────────────────

function sampleBorderColor(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): [number, number, number] {
  const reds: number[] = [];
  const greens: number[] = [];
  const blues: number[] = [];
  const push = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    reds.push(rgba[i] ?? 0);
    greens.push(rgba[i + 1] ?? 0);
    blues.push(rgba[i + 2] ?? 0);
  };
  for (let x = 0; x < width; x += 2) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y += 2) {
    push(0, y);
    push(width - 1, y);
  }
  const median = (arr: number[]) => {
    arr.sort((a, b) => a - b);
    return arr[Math.floor(arr.length / 2)] ?? 0;
  };
  return [median(reds), median(greens), median(blues)];
}

function colorDistance(
  r: number,
  g: number,
  b: number,
  tr: number,
  tg: number,
  tb: number,
): number {
  // 加权欧氏距离，对亮度更敏感，比裸 RGB 距离稳
  const dr = r - tr;
  const dg = g - tg;
  const db = b - tb;
  return Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db) / 3;
}

export interface CutoutResult {
  removedRatio: number;
  /** false 表示看起来全图都是背景色，触发了保护性放弃 */
  applied: boolean;
}

/**
 * 从四边泛洪去背景，带软边。
 * 只删「与边缘连通且颜色接近背景色」的像素 —— 主体内部的白色区域不会被误删，
 * 这是它比全局色键抠图正确的关键。
 */
export function chromaCutout(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  tolerance = 34,
): CutoutResult {
  const [br, bg, bb] = sampleBorderColor(rgba, width, height);
  const total = width * height;
  // 先只算掩码，不动原像素：判成"全图都是背景"时要能干净地放弃
  const isBackground = new Uint8Array(total);
  const stack: number[] = [];

  const colorAt = (idx: number) => {
    const i = idx * 4;
    return colorDistance(rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0, br, bg, bb);
  };

  const seed = (x: number, y: number) => {
    const idx = y * width + x;
    if (isBackground[idx]) return;
    if (colorAt(idx) <= tolerance) {
      isBackground[idx] = 1;
      stack.push(idx);
    }
  };

  for (let x = 0; x < width; x++) {
    seed(x, 0);
    seed(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    seed(0, y);
    seed(width - 1, y);
  }

  let removed = 0;
  while (stack.length > 0) {
    const idx = stack.pop();
    if (idx === undefined) break;
    removed += 1;
    const x = idx % width;
    const y = (idx - x) / width;

    if (x > 0) seed(x - 1, y);
    if (x < width - 1) seed(x + 1, y);
    if (y > 0) seed(x, y - 1);
    if (y < height - 1) seed(x, y + 1);
  }

  const removedRatio = removed / total;
  // 全图几乎都被判为背景 → 背景不是纯色，去背景只会毁图，放弃且不改动原像素
  if (removedRatio > 0.97) {
    return { removedRatio: 0, applied: false };
  }

  // 应用掩码：越接近容差上限越接近半透明，减少锯齿
  const softFloor = tolerance * 0.75;
  for (let idx = 0; idx < total; idx++) {
    if (!isBackground[idx]) continue;
    const dist = colorAt(idx);
    const feather = dist <= softFloor ? 0 : 1 - (dist - softFloor) / (tolerance - softFloor);
    const i = idx * 4;
    rgba[i + 3] = Math.round((rgba[i + 3] ?? 255) * Math.min(1, feather * 1.15));
  }

  return { removedRatio, applied: true };
}

// ─────────────────────────────────────────────────────────────
// 流水线主体
// ─────────────────────────────────────────────────────────────

function toCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('浏览器不支持 Canvas 2D，无法处理图片');
  return ctx;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'));
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('图片编码失败'))),
      type,
      quality,
    );
  });
}

async function decodeImage(file: File): Promise<ImageBitmap> {
  // imageOrientation: 'from-image' 直接按 EXIF 摆正，省掉自己读 EXIF 的麻烦
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // 某些浏览器不支持该选项，退回默认解码
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return await createImageBitmap(img);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function preprocess(
  file: File,
  options: PreprocessOptions,
): Promise<PreprocessResult> {
  const report = options.onProgress ?? (() => {});
  const validation = await validateImageFile(file);
  if (!validation.ok) throw new Error(validation.reason);

  report('decode', 0.05);
  const bitmap = await decodeImage(file);

  // 1. 缩放到长边 1024：再大对生成质量没帮助，只会拖慢上传
  const longEdge = Math.max(bitmap.width, bitmap.height);
  const scale = longEdge > IMAGE_RULES.longEdge ? IMAGE_RULES.longEdge / longEdge : 1;
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  report('resize', 0.2);
  const base = toCanvas(w, h);
  const baseCtx = context2d(base);
  baseCtx.imageSmoothingQuality = 'high';
  baseCtx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  // 2. 去背景
  let removedRatio = 0;
  if (options.removeBackground) {
    report('cutout', 0.35);
    const imageData = baseCtx.getImageData(0, 0, w, h);
    const result = chromaCutout(imageData.data, w, h, options.tolerance ?? 34);
    removedRatio = result.removedRatio;
    // applied=false 时 chromaCutout 没有改动像素，原图保持完整
    if (result.applied) {
      baseCtx.putImageData(imageData, 0, 0);
    }
  }

  // 3. 裁到主体包围盒 + 留 8% 边距
  report('crop', 0.55);
  let output = base;
  if (options.removeBackground && removedRatio > 0) {
    const data = context2d(base).getImageData(0, 0, w, h);
    const box = alphaBoundingBox(data.data, w, h);
    if (box) {
      const padded = expandBounds(box, 0.08, w, h);
      const cropped = toCanvas(padded.width, padded.height);
      context2d(cropped).drawImage(base, -padded.x, -padded.y);
      output = cropped;
    }
  }

  // 4. 编码：先试无损 PNG，超软上限就降质量
  report('encode', 0.75);
  const preferLossy = !options.removeBackground;
  let blob = await canvasToBlob(output, preferLossy ? 'image/jpeg' : 'image/png', 0.92);

  if (blob.size > IMAGE_RULES.uploadSoftLimitBytes) {
    const lossy = await canvasToBlob(output, 'image/jpeg', 0.84);
    if (lossy.size < blob.size) blob = lossy;
  }
  if (blob.size > IMAGE_RULES.uploadSoftLimitBytes) {
    // 还是太大 → 降采样到 768 再压
    const smaller = toCanvas(Math.round(output.width * 0.75), Math.round(output.height * 0.75));
    context2d(smaller).drawImage(output, 0, 0, smaller.width, smaller.height);
    const lossy = await canvasToBlob(smaller, 'image/jpeg', 0.8);
    if (lossy.size < blob.size) blob = lossy;
  }

  // 5. 内容哈希（去重键的一半）
  report('hash', 0.9);
  const hash = await sha256Hex(await blob.arrayBuffer());
  const dataUrl = await blobToDataUrl(blob);

  report('hash', 1);
  return {
    blob,
    dataUrl,
    hash,
    width: output.width,
    height: output.height,
    removedRatio,
  };
}
