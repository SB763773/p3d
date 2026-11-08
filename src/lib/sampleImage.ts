/**
 * 内置示例图：用 Canvas 现画一张"浅色背景 + 单一主体"的产品照。
 *
 * 目的很实际 —— 打开页面就能走完整个流程，不用先去找一张图。
 * 它同时也能验证去背景逻辑：背景是纯色，主体是暖色，色差足够大。
 */
export async function createSampleImageFile(): Promise<File> {
  const size = 900;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器不支持 Canvas 2D');

  // 背景：浅暖灰，带一点渐变，模拟真实拍摄的桌面色
  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, '#f4f2ee');
  gradient.addColorStop(1, '#e9e6e0');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  // 落地阴影
  ctx.save();
  ctx.filter = 'blur(24px)';
  ctx.fillStyle = 'rgba(90, 74, 58, 0.22)';
  ctx.beginPath();
  ctx.ellipse(size / 2, size * 0.78, 210, 34, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const cx = size / 2;
  const topY = size * 0.3;
  const bottomY = size * 0.75;
  const topHalf = 150;
  const bottomHalf = 128;

  // 杯身：上宽下窄的梯形，带圆角
  ctx.beginPath();
  ctx.moveTo(cx - topHalf, topY);
  ctx.quadraticCurveTo(cx - bottomHalf - 6, bottomY - 40, cx - bottomHalf, bottomY - 18);
  ctx.quadraticCurveTo(cx, bottomY + 26, cx + bottomHalf, bottomY - 18);
  ctx.quadraticCurveTo(cx + bottomHalf + 6, bottomY - 40, cx + topHalf, topY);
  ctx.closePath();

  const bodyGradient = ctx.createLinearGradient(cx - topHalf, 0, cx + topHalf, 0);
  bodyGradient.addColorStop(0, '#a9552c');
  bodyGradient.addColorStop(0.35, '#d1784a');
  bodyGradient.addColorStop(0.7, '#c26a38');
  bodyGradient.addColorStop(1, '#94502a');
  ctx.fillStyle = bodyGradient;
  ctx.fill();

  // 把手
  ctx.beginPath();
  ctx.lineWidth = 34;
  ctx.strokeStyle = '#b25f32';
  ctx.lineCap = 'round';
  ctx.arc(cx + topHalf - 10, (topY + bottomY) / 2 - 20, 78, -Math.PI * 0.42, Math.PI * 0.42);
  ctx.stroke();

  // 杯口
  ctx.beginPath();
  ctx.ellipse(cx, topY, topHalf, 34, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#f0e2d2';
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx, topY + 6, topHalf - 22, 24, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#5a3220';
  ctx.fill();

  // 高光
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.ellipse(cx - 70, (topY + bottomY) / 2, 20, 120, -0.06, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((value) => resolve(value), 'image/jpeg', 0.92),
  );
  if (!blob) throw new Error('示例图生成失败');
  return new File([blob], 'sample-mug.jpg', { type: 'image/jpeg' });
}
