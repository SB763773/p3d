/** 数值展示与下载的小工具，集中一处，避免各组件各写一份格式。 */

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function formatYuan(yuan: number): string {
  if (!yuan) return '¥0';
  return `¥${yuan.toFixed(2).replace(/\.00$/, '')}`;
}

export function formatRatio(ratio: [number, number, number] | null): string {
  if (!ratio) return '—';
  return ratio.map((value) => value.toFixed(2)).join(' : ');
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return `今天 ${time}`;
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

/**
 * 下载 GLB。
 * 走 fetch → blob 而不是直接 <a download>，这样跨域 URL 也能拿到确定的文件名。
 */
export async function downloadFile(url: string, filename: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // 给浏览器一点时间真正开始下载再回收
    setTimeout(() => URL.revokeObjectURL(objectUrl), 5_000);
  }
}

/** 历史列表用小缩略图，160px 的 JPEG 大约 6–10 KB，不占配额 */
export async function makeThumbnail(dataUrl: string, size = 160): Promise<string> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();

  const scale = Math.min(1, size / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;
  // 透明底在小图上会变黑，铺一层白
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', 0.72);
}
