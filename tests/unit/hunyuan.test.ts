import { describe, expect, it } from 'vitest';
import {
  HunyuanProvider,
  mapUpstreamError,
  planFor,
  tc3Headers,
} from '../../server/providers/hunyuan.ts';

/**
 * 真实 provider 的单测。
 *
 * 全部用假 fetch，不联网、不花钱。重点验证三件事：
 * 参数映射对不对（决定花多少钱）、错误分类对不对（决定给不给重试按钮）、
 * 签名格式对不对（错了就是一个 401，而且很难查）。
 */

const FIXED_TIME = Date.parse('2026-11-01T04:00:00Z');

interface Call {
  action: string;
  body: Record<string, unknown>;
  auth: string;
}

/**
 * 假的上游：提交类接口回 JobId，查询类接口回给定的响应体。
 * 这样"提交"和"查询"能各答各的，测试写起来不用绕。
 */
function makeProvider(
  queryResponse: Record<string, unknown> = {},
  submitResponse: Record<string, unknown> = { JobId: 'job-1' },
) {
  const calls: Call[] = [];

  const provider = new HunyuanProvider({
    secretId: 'AKIDTEST',
    secretKey: 'SECRETTEST',
    fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers as HeadersInit);
      const action = headers.get('x-tc-action') ?? '';
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ action, body, auth: headers.get('authorization') ?? '' });

      const payload = action.startsWith('Submit') ? submitResponse : queryResponse;
      return new Response(JSON.stringify({ Response: payload }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch,
    now: () => FIXED_TIME,
  });

  return { provider, calls };
}

const SUBMIT_INPUT = {
  imageBase64: 'AAAABBBB',
  imageHash: 'abc12345',
  options: { quality: 'standard' as const, pbr: false },
};

describe('档位映射', () => {
  it('draft 走极速版，不带 GenerateType', () => {
    const plan = planFor({ quality: 'draft', pbr: false });
    expect(plan.edition.kind).toBe('rapid');
    expect(plan.generateType).toBeNull();
    expect(plan.points).toBe(15);
  });

  it('standard 走专业版 Normal，20 积分', () => {
    const plan = planFor({ quality: 'standard', pbr: false });
    expect(plan.edition.kind).toBe('pro');
    expect(plan.generateType).toBe('Normal');
    expect(plan.points).toBe(20);
  });

  it('high = Normal + PBR，30 积分（不用 LowPoly：那是减面，更糙）', () => {
    const plan = planFor({ quality: 'high', pbr: false });
    expect(plan.generateType).toBe('Normal');
    expect(plan.points).toBe(30);
  });

  it('standard 手动勾 PBR 与 high 同价', () => {
    expect(planFor({ quality: 'standard', pbr: true }).points).toBe(
      planFor({ quality: 'high', pbr: false }).points,
    );
  });

  it('自定义面数再加 10 积分，且只有专业版支持', () => {
    expect(planFor({ quality: 'standard', pbr: false, faceCount: 50_000 }).points).toBe(30);
    expect(planFor({ quality: 'draft', pbr: false, faceCount: 50_000 }).points).toBe(15);
  });

  it('成本 = 积分 × 单价，默认 0.10 元/积分', () => {
    const { provider } = makeProvider();
    expect(provider.estimateCostYuan({ quality: 'standard', pbr: false })).toBe(2);
    expect(provider.estimateCostYuan({ quality: 'draft', pbr: false })).toBe(1.5);
    expect(provider.estimateCostYuan({ quality: 'high', pbr: false })).toBe(3);
  });
});

describe('提交', () => {
  it('high 档强制开 PBR，即使用户没勾', async () => {
    const { provider, calls } = makeProvider();
    await provider.submit({ ...SUBMIT_INPUT, options: { quality: 'high', pbr: false } });
    expect(calls[0]?.body.EnablePBR).toBe(true);
  });

  it('图片以 base64 传给专业版，并带上生成类型', async () => {
    const { provider, calls } = makeProvider({}, { JobId: 'job-1' });
    const result = await provider.submit({
      ...SUBMIT_INPUT,
      options: { quality: 'standard', pbr: true },
    });

    expect(result.providerJobId).toBe('pro:job-1');
    expect(calls[0]?.action).toBe('SubmitHunyuanTo3DProJob');
    expect(calls[0]?.body.ImageBase64).toBe('AAAABBBB');
    expect(calls[0]?.body.GenerateType).toBe('Normal');
    expect(calls[0]?.body.EnablePBR).toBe(true);
  });

  it('把版本编码进 jobId：查询时才知道该调哪个接口', async () => {
    const { provider } = makeProvider({}, { JobId: 'job-2' });
    const result = await provider.submit({
      ...SUBMIT_INPUT,
      options: { quality: 'draft', pbr: false },
    });
    expect(result.providerJobId).toBe('rapid:job-2');
  });

  it('极速版不传 GenerateType —— 传了会被上游当无效参数拒掉', async () => {
    const { provider, calls } = makeProvider({}, { JobId: 'job-3' });
    await provider.submit({ ...SUBMIT_INPUT, options: { quality: 'draft', pbr: false } });
    expect(calls[0]?.action).toBe('SubmitHunyuanTo3DRapidJob');
    expect(calls[0]?.body.GenerateType).toBeUndefined();
  });

  it('面数被夹到官方允许的 10000–1500000', async () => {
    const { provider, calls } = makeProvider({}, { JobId: 'job-4' });
    await provider.submit({
      ...SUBMIT_INPUT,
      options: { quality: 'standard', pbr: false, faceCount: 99_999_999 },
    });
    expect(calls[0]?.body.FaceCount).toBe(1_500_000);
  });

  it('上游没给 JobId 就报错，不自己编一个', async () => {
    const { provider } = makeProvider({}, {});
    await expect(provider.submit(SUBMIT_INPUT)).rejects.toThrow(/JobId/);
  });
});

describe('查询', () => {
  it('WAIT / RUN 都算进行中', async () => {
    for (const status of ['WAIT', 'RUN']) {
      const { provider } = makeProvider({ Status: status });
      const submitted = await provider.submit(SUBMIT_INPUT);
      const result = await provider.query(submitted.providerJobId);
      expect(result.state).toBe('pending');
    }
  });

  it('DONE 时返回 GLB，上游地址放进 assetUrl 而不是 glbUrl', async () => {
    const { provider, calls } = makeProvider({
      Status: 'DONE',
      ResultFile3Ds: [
        { Type: 'OBJ', Url: 'https://upstream/a.zip' },
        { Type: 'GLB', Url: 'https://upstream/a.glb' },
      ],
      ResultCreditConsumed: 20,
    });

    const submitted = await provider.submit(SUBMIT_INPUT);
    const result = await provider.query(submitted.providerJobId);

    expect(result.state).toBe('succeeded');
    expect(result.assetUrl).toBe('https://upstream/a.glb');
    expect(result.glbUrl).toBeUndefined(); // 前端不该直接拿到上游地址
    expect(calls.at(-1)?.action).toBe('QueryHunyuanTo3DProJob');
  });

  it('成本按上游实际消耗的积分算，不是事前估算', async () => {
    const { provider } = makeProvider({
      Status: 'DONE',
      ResultFile3Ds: [{ Type: 'GLB', Url: 'https://upstream/a.glb' }],
      ResultCreditConsumed: 30, // 实际比估算贵
    });
    const submitted = await provider.submit(SUBMIT_INPUT);
    const result = await provider.query(submitted.providerJobId);
    expect(result.costYuan).toBe(3);
  });

  it('没有 GLB 时如实失败，不伪造地址', async () => {
    const { provider } = makeProvider({
      Status: 'DONE',
      ResultFile3Ds: [{ Type: 'OBJ', Url: 'https://upstream/a.zip' }],
    });
    const submitted = await provider.submit(SUBMIT_INPUT);
    const result = await provider.query(submitted.providerJobId);
    expect(result.state).toBe('failed');
    expect(result.message).toContain('GLB');
    expect(result.retryable).toBe(false);
  });

  it('FAIL 时把上游错误码翻译成我们的错误码', async () => {
    const { provider } = makeProvider({
      Status: 'FAIL',
      ErrorCode: 'FailedOperation.ImageIllegal',
      ErrorMessage: '图片违规',
    });
    const submitted = await provider.submit(SUBMIT_INPUT);
    const result = await provider.query(submitted.providerJobId);
    expect(result.state).toBe('failed');
    expect(result.code).toBe('CONTENT_BLOCKED');
    expect(result.retryable).toBe(false);
  });

  it('查询极速版任务时调的是极速版的查询接口', async () => {
    const { provider, calls } = makeProvider({ Status: 'RUN' });
    await provider.query('rapid:job-9');
    expect(calls.at(-1)?.action).toBe('QueryHunyuanTo3DRapidJob');
  });
});

describe('错误分类', () => {
  it('内容违规不可重试 —— 否则用户会连点然后被风控', () => {
    const mapped = mapUpstreamError('FailedOperation.ImageIllegal', '违规');
    expect(mapped.code).toBe('CONTENT_BLOCKED');
    expect(mapped.retryable).toBe(false);
  });

  it('限流可重试', () => {
    expect(mapUpstreamError('RequestLimitExceeded', '太快').retryable).toBe(true);
  });

  it('余额不足不可重试 —— 重试只会再失败一次', () => {
    const mapped = mapUpstreamError('FailedOperation.BalanceInsufficient', '没钱');
    expect(mapped.code).toBe('QUOTA_EXCEEDED');
    expect(mapped.retryable).toBe(false);
  });

  it('密钥问题不可重试', () => {
    expect(mapUpstreamError('AuthFailure.SignatureExpire', '签名错').retryable).toBe(false);
  });

  it('认不出的错误保守地判为可重试', () => {
    expect(mapUpstreamError('SomeNewError', '未知').retryable).toBe(true);
  });

  it('不把可能含敏感信息的上游文案原样透给用户', () => {
    const mapped = mapUpstreamError('FailedOperation.ImageIllegal', 'key=AKIDxxx 泄露');
    expect(mapped.message).not.toContain('AKID');
  });
});

describe('TC3 签名', () => {
  const base = {
    secretId: 'AKIDTEST',
    secretKey: 'SECRETTEST',
    service: 'ai3d',
    host: 'ai3d.tencentcloudapi.com',
    action: 'SubmitHunyuanTo3DProJob',
    version: '2025-05-13',
    region: 'ap-guangzhou',
    payload: '{"Prompt":"cat"}',
    timestamp: 1_762_000_000,
  };

  it('产出完整的 API 3.0 请求头', async () => {
    const headers = await tc3Headers(base);

    expect(headers['x-tc-action']).toBe('SubmitHunyuanTo3DProJob');
    expect(headers['x-tc-version']).toBe('2025-05-13');
    expect(headers['x-tc-timestamp']).toBe('1762000000');
    expect(headers['content-type']).toBe('application/json');
    expect(headers.authorization).toMatch(
      /^TC3-HMAC-SHA256 Credential=AKIDTEST\/\d{4}-\d{2}-\d{2}\/ai3d\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$/,
    );
  });

  it('同样的输入产出同样的签名（可复现）', async () => {
    const a = await tc3Headers(base);
    const b = await tc3Headers(base);
    expect(a.authorization).toBe(b.authorization);
  });

  it('密钥不同则签名不同', async () => {
    const a = await tc3Headers({ ...base, secretKey: 'key-A' });
    const b = await tc3Headers({ ...base, secretKey: 'key-B' });
    expect(a.authorization).not.toBe(b.authorization);
  });

  it('时间戳参与签名（防重放的关键）', async () => {
    const a = await tc3Headers({ ...base, timestamp: 1_762_000_000 });
    const b = await tc3Headers({ ...base, timestamp: 1_762_000_001 });
    expect(a.authorization).not.toBe(b.authorization);
  });

  it('请求体参与签名（改一个字节签名就变）', async () => {
    const a = await tc3Headers({ ...base, payload: '{"Prompt":"cat"}' });
    const b = await tc3Headers({ ...base, payload: '{"Prompt":"dog"}' });
    expect(a.authorization).not.toBe(b.authorization);
  });
});
