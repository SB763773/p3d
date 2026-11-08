import { describe, expect, it } from 'vitest';
import { MockProvider } from '@/lib/providers/mock';
import type { SubmitInput } from '@/lib/providers/types';

function makeInput(over: Partial<SubmitInput> = {}): SubmitInput {
  return {
    imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    mimeType: 'image/png',
    options: { quality: 'standard', pbr: true, faceCount: 30000 },
    imageHash: 'deadbeef',
    ...over,
  };
}

/** 注入假时钟，把 3.8 秒的"生成"压成一次函数调用，测试不需要真等 */
function setup() {
  let now = 1_000_000;
  const provider = new MockProvider({ now: () => now });
  return {
    provider,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('MockProvider', () => {
  it('提交后按时间推进阶段性进度，最后交出 GLB', async () => {
    const { provider, advance } = setup();
    const { providerJobId } = await provider.submit(makeInput());

    const first = await provider.query(providerJobId);
    expect(first.state).toBe('pending');

    advance(400); // 3.8s 总时长里约 10%，还在排队段
    const early = await provider.query(providerJobId);
    expect(early.state).toBe('pending');
    if (early.state === 'pending') expect(early.stage).toBe('queued');

    advance(1_000); // 约 37%，进入几何段
    const middle = await provider.query(providerJobId);
    expect(middle.state).toBe('pending');
    if (middle.state === 'pending') expect(middle.stage).toBe('geometry');

    advance(10_000);
    const done = await provider.query(providerJobId);
    expect(done.state).toBe('succeeded');
    if (done.state === 'succeeded') {
      expect(done.glbUrl).toMatch(/^\/mock\/sample-.+\.glb$/);
      expect(done.meta?.pbr).toBe(true);
    }
  });

  it('同一张图永远给同一个模型，便于比对', async () => {
    const { provider, advance } = setup();
    const a = await provider.submit(makeInput({ imageHash: 'same-hash' }));
    advance(20_000);
    const first = await provider.query(a.providerJobId);

    const b = await provider.submit(makeInput({ imageHash: 'same-hash' }));
    advance(20_000);
    const second = await provider.query(b.providerJobId);

    expect(first.state).toBe('succeeded');
    expect(second.state).toBe('succeeded');
    if (first.state === 'succeeded' && second.state === 'succeeded') {
      expect(first.glbUrl).toBe(second.glbUrl);
    }
  });

  it('未知任务 id 返回可重试的失败，而不是抛异常', async () => {
    const { provider } = setup();
    const status = await provider.query('nope');
    expect(status.state).toBe('failed');
    if (status.state === 'failed') {
      expect(status.retryable).toBe(true);
    }
  });

  it('setFailNext 只影响下一次，用来验证错误 UI', async () => {
    const { provider, advance } = setup();
    provider.setFailNext(true);

    const failing = await provider.submit(makeInput());
    advance(5_000);
    const failed = await provider.query(failing.providerJobId);
    expect(failed.state).toBe('failed');
    if (failed.state === 'failed') expect(failed.retryable).toBe(true);

    const ok = await provider.submit(makeInput());
    advance(5_000);
    expect((await provider.query(ok.providerJobId)).state).toBe('succeeded');
  });

  it('畸形图片在提交阶段就被拒，不进入任务队列', async () => {
    const { provider } = setup();
    await expect(provider.submit(makeInput({ imageDataUrl: '' }))).rejects.toThrow();
  });

  it('成本预估随档位变化，且不超过单次上限', () => {
    const { provider } = setup();
    const estimate = provider.capabilities.estimateCostYuan;
    expect(estimate({ quality: 'draft', pbr: false })).toBeLessThan(
      estimate({ quality: 'standard', pbr: true }),
    );
    expect(estimate({ quality: 'high', pbr: true })).toBeLessThanOrEqual(5);
  });
});
