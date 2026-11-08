import { describe, expect, it } from 'vitest';
import { cacheKey, findCacheHit, optionsKeyOf, sha256Hex } from '@/lib/hash';

interface FakeJob {
  id: string;
  status: string;
  glbUrl: string | null;
  imageHash: string;
  options: { quality: string; pbr: boolean; faceCount?: number };
}

const job = (over: Partial<FakeJob> = {}): FakeJob => ({
  id: 'job_1',
  status: 'succeeded',
  glbUrl: '/mock/sample-vase.glb',
  imageHash: 'aaa',
  options: { quality: 'standard', pbr: true, faceCount: 30000 },
  ...over,
});

describe('sha256Hex', () => {
  it('对同样内容给出同样摘要，对差一个字节就完全不同', async () => {
    const a = await sha256Hex(new Uint8Array([1, 2, 3]).buffer);
    const b = await sha256Hex(new Uint8Array([1, 2, 3]).buffer);
    const c = await sha256Hex(new Uint8Array([1, 2, 4]).buffer);

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('去重键', () => {
  it('参数键对每个字段都敏感', () => {
    const base = { quality: 'standard', pbr: true, faceCount: 30000 };
    expect(optionsKeyOf(base)).toBe(optionsKeyOf({ ...base }));
    expect(optionsKeyOf(base)).not.toBe(optionsKeyOf({ ...base, quality: 'high' }));
    expect(optionsKeyOf(base)).not.toBe(optionsKeyOf({ ...base, pbr: false }));
    expect(optionsKeyOf(base)).not.toBe(optionsKeyOf({ ...base, faceCount: 20000 }));
    // faceCount 缺省等价于 0
    expect(optionsKeyOf({ quality: 'draft', pbr: false })).toBe(
      optionsKeyOf({ quality: 'draft', pbr: false, faceCount: 0 }),
    );
  });

  it('cacheKey 把图片摘要和参数拼起来', () => {
    expect(cacheKey('abc', 'standard|pbr:1')).toBe('abc::standard|pbr:1');
  });
});

describe('findCacheHit', () => {
  it('图片哈希与参数都相同 → 命中，零成本复用', () => {
    const hit = findCacheHit([job()], 'aaa', { quality: 'standard', pbr: true, faceCount: 30000 });
    expect(hit?.glbUrl).toBe('/mock/sample-vase.glb');
  });

  it('参数不同 → 不命中', () => {
    expect(
      findCacheHit([job()], 'aaa', { quality: 'high', pbr: true, faceCount: 30000 }),
    ).toBeUndefined();
  });

  it('失败任务和没有 GLB 的任务不算缓存', () => {
    expect(findCacheHit([job({ status: 'failed' })], 'aaa', job().options)).toBeUndefined();
    expect(findCacheHit([job({ glbUrl: null })], 'aaa', job().options)).toBeUndefined();
  });

  it('空历史不报错', () => {
    expect(findCacheHit([], 'aaa', job().options)).toBeUndefined();
  });
});
