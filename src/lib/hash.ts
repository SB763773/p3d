/** SHA-256（hex），用于图片内容去重。浏览器与 Node 18+ 都有 WebCrypto。 */
export async function sha256Hex(input: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 去重键：图片内容 + 生成参数。
 * 同一张图 + 同一组参数 → 直接复用已有 GLB，零成本秒回（方案 §6.3）。
 */
export function cacheKey(imageHash: string, optionsKey: string): string {
  return `${imageHash}::${optionsKey}`;
}

export function optionsKeyOf(options: {
  quality: string;
  pbr: boolean;
  faceCount?: number;
}): string {
  return `${options.quality}|pbr:${options.pbr ? 1 : 0}|faces:${options.faceCount ?? 0}`;
}

interface CacheableJob {
  status: string;
  glbUrl: string | null;
  imageHash: string;
  options: { quality: string; pbr: boolean; faceCount?: number };
}

/**
 * 在已有任务里找可复用的成功结果。
 * 抽成纯函数是为了能脱离 store / DOM 单测（方案 §10 的单测清单第 5 条）。
 */
export function findCacheHit<T extends CacheableJob>(
  jobs: readonly T[],
  imageHash: string,
  options: { quality: string; pbr: boolean; faceCount?: number },
): T | undefined {
  const wanted = optionsKeyOf(options);
  return jobs.find(
    (job) =>
      job.status === 'succeeded' &&
      job.glbUrl !== null &&
      job.imageHash === imageHash &&
      optionsKeyOf(job.options) === wanted,
  );
}
