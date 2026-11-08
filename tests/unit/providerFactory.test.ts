import { describe, expect, it } from 'vitest';
import { createProvider } from '../../server/providers/index.ts';

/**
 * Provider 工厂的测试。
 *
 * 这里守的是一条安全底线：**密钥没配的时候不许假装在跑真后端**。
 * 退回 mock 可以，但必须留下原因，让 /api/health 能如实汇报。
 */
describe('provider 工厂', () => {
  it('默认用 mock，不需要任何密钥', () => {
    const bundle = createProvider({});
    expect(bundle.active).toBe('mock');
    expect(bundle.reason).toBeNull();
  });

  it('指定 hunyuan 但没给密钥 → 退回 mock，并说明原因', () => {
    const bundle = createProvider({ P3D_PROVIDER: 'hunyuan' });
    expect(bundle.wanted).toBe('hunyuan');
    expect(bundle.active).toBe('mock');
    expect(bundle.reason).toContain('SECRET_ID');
  });

  it('只给了一半密钥也退回 mock —— 少一个就签不了名', () => {
    expect(createProvider({ P3D_PROVIDER: 'hunyuan', TENCENTCLOUD_SECRET_ID: 'AKID' }).active).toBe(
      'mock',
    );
    expect(createProvider({ P3D_PROVIDER: 'hunyuan', TENCENTCLOUD_SECRET_KEY: 'k' }).active).toBe(
      'mock',
    );
  });

  it('密钥齐全时真的切到 hunyuan', () => {
    const bundle = createProvider({
      P3D_PROVIDER: 'hunyuan',
      TENCENTCLOUD_SECRET_ID: 'AKIDxxx',
      TENCENTCLOUD_SECRET_KEY: 'secretxxx',
    });
    expect(bundle.active).toBe('hunyuan');
    expect(bundle.provider.name).toBe('hunyuan');
    expect(bundle.reason).toBeNull();
  });

  it('切到真实后端后，成本预估变成真实单价量级（不是 mock 的 0）', () => {
    const bundle = createProvider({
      P3D_PROVIDER: 'hunyuan',
      TENCENTCLOUD_SECRET_ID: 'AKIDxxx',
      TENCENTCLOUD_SECRET_KEY: 'secretxxx',
    });
    expect(bundle.provider.estimateCostYuan({ quality: 'standard', pbr: false })).toBe(2);
  });

  it('积分单价可用环境变量覆盖（后付费 0.12）', () => {
    const bundle = createProvider({
      P3D_PROVIDER: 'hunyuan',
      TENCENTCLOUD_SECRET_ID: 'AKIDxxx',
      TENCENTCLOUD_SECRET_KEY: 'secretxxx',
      P3D_POINT_YUAN: '0.12',
    });
    expect(bundle.provider.estimateCostYuan({ quality: 'standard', pbr: false })).toBe(2.4);
  });

  it('报告里不出现密钥内容', () => {
    const bundle = createProvider({
      P3D_PROVIDER: 'hunyuan',
      TENCENTCLOUD_SECRET_ID: 'AKID_SUPER_SECRET',
      TENCENTCLOUD_SECRET_KEY: 'KEY_SUPER_SECRET',
    });
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain('SUPER_SECRET');
  });
});
