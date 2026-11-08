/**
 * 设备降级分级（方案 §7.3 性能开关表）。
 *
 * 纯函数便于单测：传入观测值，返回档位，不直接读 window。
 */

export type DeviceTier = 'high' | 'medium' | 'low';

export interface DeviceSignals {
  coarsePointer: boolean;
  cores: number;
  /** navigator.deviceMemory，单位 GB，部分浏览器没有 */
  memoryGB: number | null;
  devicePixelRatio: number;
  /** 是否支持 WebGL2 */
  webgl2: boolean;
}

export interface RenderProfile {
  tier: DeviceTier;
  tierLabel: string;
  shadows: boolean;
  dpr: [number, number];
  envPreset: boolean;
  maxPolarAngle: number;
}

export function classifyDevice(signals: DeviceSignals): DeviceTier {
  if (!signals.webgl2) return 'low';
  if (signals.coarsePointer) return 'low';

  const weakCpu = signals.cores > 0 && signals.cores <= 4;
  const lowMemory = signals.memoryGB !== null && signals.memoryGB <= 4;
  if (weakCpu || lowMemory) return 'medium';

  return 'high';
}

export function renderProfileFor(tier: DeviceTier): RenderProfile {
  switch (tier) {
    case 'low':
      return {
        tier,
        tierLabel: '移动端 / 弱设备（已关闭阴影与环境贴图）',
        shadows: false,
        dpr: [1, 1],
        envPreset: false,
        maxPolarAngle: Math.PI / 1.85,
      };
    case 'medium':
      return {
        tier,
        tierLabel: '集显 / 中端设备',
        shadows: true,
        dpr: [1, 1.5],
        envPreset: true,
        maxPolarAngle: Math.PI / 1.85,
      };
    default:
      return {
        tier,
        tierLabel: '独显 / 高配设备',
        shadows: true,
        dpr: [1, 2],
        envPreset: true,
        maxPolarAngle: Math.PI / 1.85,
      };
  }
}

export function detectDeviceSignals(): DeviceSignals {
  const nav = navigator as Navigator & { deviceMemory?: number };
  let webgl2 = false;
  try {
    const canvas = document.createElement('canvas');
    webgl2 = Boolean(canvas.getContext('webgl2'));
  } catch {
    webgl2 = false;
  }
  return {
    coarsePointer: window.matchMedia('(pointer: coarse)').matches,
    cores: nav.hardwareConcurrency ?? 0,
    memoryGB: nav.deviceMemory ?? null,
    devicePixelRatio: window.devicePixelRatio || 1,
    webgl2,
  };
}
