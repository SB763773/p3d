import { describe, expect, it } from 'vitest';
import type { DeviceSignals } from '@/lib/deviceTier';
import { classifyDevice, renderProfileFor } from '@/lib/deviceTier';

const base: DeviceSignals = {
  coarsePointer: false,
  cores: 12,
  memoryGB: 16,
  devicePixelRatio: 2,
  webgl2: true,
};

describe('classifyDevice', () => {
  it('没有 WebGL2 直接降到最低档', () => {
    expect(classifyDevice({ ...base, webgl2: false })).toBe('low');
  });

  it('触屏/粗指针（手机、平板）走低档', () => {
    expect(classifyDevice({ ...base, coarsePointer: true })).toBe('low');
  });

  it('核心数或内存偏低的桌面走中档', () => {
    expect(classifyDevice({ ...base, cores: 4 })).toBe('medium');
    expect(classifyDevice({ ...base, memoryGB: 4 })).toBe('medium');
  });

  it('读不到 deviceMemory 时不因为 null 就降档', () => {
    expect(classifyDevice({ ...base, memoryGB: null })).toBe('high');
  });
});

describe('renderProfileFor', () => {
  it('低档关阴影、锁 DPR 1、关环境贴图', () => {
    const profile = renderProfileFor('low');
    expect(profile.shadows).toBe(false);
    expect(profile.dpr).toEqual([1, 1]);
    expect(profile.envPreset).toBe(false);
  });

  it('高档允许 DPR 2 与阴影', () => {
    const profile = renderProfileFor('high');
    expect(profile.shadows).toBe(true);
    expect(profile.dpr[1]).toBe(2);
  });

  it('所有档位都限制俯仰角：允许略微俯视，但不允许翻到地面以下', () => {
    for (const tier of ['low', 'medium', 'high'] as const) {
      const angle = renderProfileFor(tier).maxPolarAngle;
      expect(angle).toBeGreaterThanOrEqual(Math.PI / 2); // 可以平视或略俯
      expect(angle).toBeLessThan(Math.PI * 0.6); // 但远不到仰视地面底部
    }
  });
});
