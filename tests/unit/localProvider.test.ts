import { describe, expect, it, vi } from 'vitest';
import { LocalEngineError, LocalProvider } from '../../server/providers/local.ts';

/**
 * 本地引擎 provider 的测试。
 *
 * 守两条：
 * 1. 引擎离线时必须说人话（"先跑 npm run engine"），且标成可重试 ——
 *    用户把引擎拉起来点重试就能成，不该被判定成永久失败。
 * 2. 上游（localhost:8188）的地址不能漏给前端，仍然走 assetUrl 让 handler 转发。
 */

const OPTIONS = { quality: 'standard' as const, pbr: true };
const INPUT = { imageBase64: 'AAAA', imageHash: 'a'.repeat(64), options: OPTIONS };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('local provider', () => {
  it('成本恒为 0 —— 自己家显卡不该被日预算拦', () => {
    expect(new LocalProvider().estimateCostYuan(OPTIONS)).toBe(0);
  });

  it('提交成功后返回引擎给的任务 id', async () => {
    const fetchImpl = vi.fn(async () => json({ id: 'abc123', status: 'queued' }));
    const provider = new LocalProvider({ fetchImpl });

    const result = await provider.submit(INPUT);
    expect(result.providerJobId).toBe('abc123');
  });

  it('提交时引擎没起 → 明确告诉用户去跑 npm run engine，且可重试', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const provider = new LocalProvider({ fetchImpl });

    await expect(provider.submit(INPUT)).rejects.toBeInstanceOf(LocalEngineError);
    await expect(provider.submit(INPUT)).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
      retryable: true,
    });
    await expect(provider.submit(INPUT)).rejects.toThrow(/npm run engine/);
  });

  it('引擎返回 5xx → 标记可重试', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const provider = new LocalProvider({ fetchImpl });

    await expect(provider.submit(INPUT)).rejects.toMatchObject({ retryable: true });
  });

  it('引擎返回 4xx → 不重试（请求本身有问题，重来也一样）', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad image', { status: 400 }));
    const provider = new LocalProvider({ fetchImpl });

    await expect(provider.submit(INPUT)).rejects.toMatchObject({ retryable: false });
  });

  it('查询成功 → assetUrl 拼成引擎上的 GLB 地址，不直接漏给前端', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ status: 'succeeded', url: '/v1/glb/job1', sizeBytes: 2048, faceCount: 900 }),
    );
    const provider = new LocalProvider({ fetchImpl, baseUrl: 'http://127.0.0.1:8188/' });

    const status = await provider.query('job1');
    expect(status).toMatchObject({
      state: 'succeeded',
      assetUrl: 'http://127.0.0.1:8188/v1/glb/job1',
      sizeBytes: 2048,
      faceCount: 900,
      costYuan: 0,
    });
    // 尾斜杠要被规范化掉，否则会拼出 //v1/glb
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8188/v1/jobs/job1', expect.anything());
  });

  it('任务在引擎侧已过期（404）→ 提示重新生成，而不是"服务坏了"', async () => {
    const fetchImpl = vi.fn(async () => json({ detail: 'not found' }, 404));
    const provider = new LocalProvider({ fetchImpl });

    const status = await provider.query('gone');
    expect(status.state).toBe('failed');
    if (status.state === 'failed') {
      expect(status.message).toContain('重新生成');
      expect(status.retryable).toBe(true);
    }
  });

  it('查询时引擎掉线 → 可重试', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const provider = new LocalProvider({ fetchImpl });

    const status = await provider.query('job1');
    expect(status.state).toBe('failed');
    if (status.state === 'failed') expect(status.retryable).toBe(true);
  });

  it('引擎报失败 → 透传错误码与可重试性', async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        status: 'failed',
        error: { code: 'OUT_OF_MEMORY', message: '显存不够了', retryable: true },
      }),
    );
    const provider = new LocalProvider({ fetchImpl });

    const status = await provider.query('job1');
    expect(status).toMatchObject({
      state: 'failed',
      code: 'OUT_OF_MEMORY',
      message: '显存不够了',
      retryable: true,
    });
  });

  it('引擎阶段映射到项目统一的四个阶段', async () => {
    const stages: Array<[string, string]> = [
      ['queued', 'queued'],
      ['preparing', 'queued'],
      ['encoding', 'geometry'],
      ['meshing', 'texture'],
      ['done', 'download'],
    ];

    for (const [raw, expected] of stages) {
      const fetchImpl = vi.fn(async () => json({ status: 'queued', stage: raw, progress: 0.4 }));
      const provider = new LocalProvider({ fetchImpl });
      const status = await provider.query('job1');
      expect(status.state === 'pending' && status.stage).toBe(expected);
    }
  });

  it('进度缺失时不编造，退到 0.1', async () => {
    const fetchImpl = vi.fn(async () => json({ status: 'queued' }));
    const provider = new LocalProvider({ fetchImpl });

    const status = await provider.query('job1');
    expect(status.state === 'pending' && status.progress).toBe(0.1);
  });
});
