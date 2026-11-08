import { describe, expect, it } from 'vitest';
import type { JobRepository } from '../../server/handler.ts';
import { createHandler } from '../../server/handler.ts';
import type { GenOptions, ServerJob, ServerProvider } from '../../server/types.ts';

/**
 * BFF 的契约测试。
 *
 * 直接构造 Web Request 调用 handler，不需要起端口、不需要网络 ——
 * 但走的是和生产完全一样的那条代码路径（含校验、闸门、落库、轮询）。
 */

class MemoryRepo implements JobRepository {
  jobs = new Map<string, ServerJob>();
  list() {
    return [...this.jobs.values()];
  }
  get(id: string) {
    return this.jobs.get(id);
  }
  async put(job: ServerJob) {
    this.jobs.set(job.id, job);
  }
  async remove(id: string) {
    return this.jobs.delete(id);
  }
}

/** 可控的假上游：默认一直 pending，测试里随时改成成功/失败 */
function createFakeProvider() {
  const state: {
    mode: 'pending' | 'succeeded' | 'failed';
    submitCalls: number;
  } = { mode: 'pending', submitCalls: 0 };

  const provider: ServerProvider = {
    name: 'mock',
    estimateCostYuan: (options: GenOptions) =>
      options.quality === 'draft' ? 1.5 : options.quality === 'high' ? 4 : 2.5,
    async submit() {
      state.submitCalls += 1;
      return { providerJobId: `p_${state.submitCalls}` };
    },
    async query() {
      if (state.mode === 'succeeded') {
        return {
          state: 'succeeded',
          progress: 1,
          stage: 'download',
          glbUrl: '/mock/sample-vase.glb',
          sizeBytes: 131704,
        };
      }
      if (state.mode === 'failed') {
        return {
          state: 'failed',
          code: 'UPSTREAM_ERROR',
          message: '上游炸了',
          retryable: true,
        };
      }
      return { state: 'pending', progress: 0.42, stage: 'geometry' };
    },
  };

  return { provider, state };
}

const IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

function createBody(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    image: IMAGE,
    imageHash: 'a1b2c3d4e5f60718',
    options: { quality: 'standard', pbr: true },
    ...over,
  });
}

function post(body: string, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

function get(path: string) {
  return new Request(`http://localhost${path}`, { method: 'GET' });
}

function setup(env: Record<string, string | undefined> = {}, fetchUpstream?: typeof fetch) {
  const repo = new MemoryRepo();
  const fake = createFakeProvider();
  let clock = Date.UTC(2026, 9, 25, 4, 0, 0);
  const handler = createHandler({
    store: repo,
    provider: fake.provider,
    env,
    now: () => clock,
    hashIp: async (ip) => `hash:${ip}`,
    fetchUpstream,
  });
  return {
    repo,
    fake,
    handler,
    tick: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

describe('GET /api/health', () => {
  it('返回后端与闸门状态', async () => {
    const { handler } = setup({ P3D_IP_DAILY_QUOTA: '3' });
    const response = await handler(get('/api/health'));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.provider).toBe('mock');
    expect((body.limits as Record<string, unknown>).ipDailyQuota).toBe(3);
  });
});

describe('POST /api/jobs', () => {
  it('创建任务 → 轮询 → 成功，并记上成本', async () => {
    const { handler, fake } = setup();

    const created = await handler(post(createBody()));
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect(id).toMatch(/^job_/);

    const pending = await handler(get(`/api/jobs/${id}`));
    const pendingBody = (await pending.json()) as Record<string, unknown>;
    expect(pendingBody.status).toBe('running');
    expect(pendingBody.stage).toBe('geometry');
    expect(pendingBody.progress).toBeCloseTo(0.42);

    fake.state.mode = 'succeeded';
    const done = await handler(get(`/api/jobs/${id}`));
    const doneBody = (await done.json()) as {
      status: string;
      result: { glbUrl: string };
      cost: { charged: boolean; chargedYuan: number };
    };
    expect(doneBody.status).toBe('succeeded');
    expect(doneBody.result.glbUrl).toBe('/mock/sample-vase.glb');
    expect(doneBody.cost.charged).toBe(true);
    expect(doneBody.cost.chargedYuan).toBe(2.5);
  });

  it('同图同参数第二次提交直接复用，不再打上游', async () => {
    const { handler, fake } = setup();

    const first = await handler(post(createBody()));
    const { id } = (await first.json()) as { id: string };
    fake.state.mode = 'succeeded';
    await handler(get(`/api/jobs/${id}`));

    const second = await handler(post(createBody()));
    const secondBody = (await second.json()) as { cached?: boolean; id: string };

    expect(second.status).toBe(200);
    expect(secondBody.cached).toBe(true);
    expect(secondBody.id).toBe(id);
    expect(fake.state.submitCalls).toBe(1);
  });

  it('参数不同则不复用', async () => {
    const { handler, fake } = setup();
    const first = await handler(post(createBody()));
    const { id } = (await first.json()) as { id: string };
    fake.state.mode = 'succeeded';
    await handler(get(`/api/jobs/${id}`));

    const second = await handler(post(createBody({ options: { quality: 'high', pbr: true } })));
    expect(second.status).toBe(201);
    expect(fake.state.submitCalls).toBe(2);
  });

  it('单 IP 超过日配额 → 429，且带 retry-after', async () => {
    const { handler } = setup({ P3D_IP_DAILY_QUOTA: '1' });

    expect((await handler(post(createBody()))).status).toBe(201);

    const blocked = await handler(post(createBody({ imageHash: 'bbbb1111cccc2222' })));
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { error: string; resetAt: number };
    expect(body.error).toBe('RATE_LIMITED');
    expect(body.resetAt).toBeGreaterThan(Date.UTC(2026, 9, 25, 4, 0, 0));
    expect(blocked.headers.get('retry-after')).toBeTruthy();
  });

  it('全局预算不够 → 402', async () => {
    const { handler } = setup({ P3D_DAILY_BUDGET_YUAN: '1' });
    const response = await handler(post(createBody()));
    expect(response.status).toBe(402);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('QUOTA_EXCEEDED');
  });

  it('熔断开关打开 → 503', async () => {
    const { handler, fake } = setup({ P3D_KILL_SWITCH: '1' });
    const response = await handler(post(createBody()));
    expect(response.status).toBe(503);
    expect(fake.state.submitCalls).toBe(0);
  });

  it('非法图片 / 非法哈希 / 非法参数都被拒', async () => {
    const { handler, fake } = setup();

    const noImage = await handler(post(createBody({ image: 'hello' })));
    expect(noImage.status).toBe(400);
    expect(((await noImage.json()) as { error: string }).error).toBe('INVALID_IMAGE');

    const badHash = await handler(post(createBody({ imageHash: 'zzz' })));
    expect(badHash.status).toBe(400);

    const badQuality = await handler(
      post(createBody({ imageHash: 'ffff000011112222', options: { quality: 'ultra', pbr: true } })),
    );
    expect(badQuality.status).toBe(400);

    const badFaces = await handler(
      post(
        createBody({
          imageHash: 'ffff000011112223',
          options: { quality: 'draft', pbr: false, faceCount: -5 },
        }),
      ),
    );
    expect(badFaces.status).toBe(400);

    expect(fake.state.submitCalls).toBe(0);
  });

  it('上游提交失败时任务标记为可重试的失败，而不是 500', async () => {
    const { handler, fake } = setup();
    fake.provider.submit = async () => {
      throw new Error('上游连接超时');
    };
    const response = await handler(post(createBody()));
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };

    const view = await handler(get(`/api/jobs/${id}`));
    const body = (await view.json()) as {
      status: string;
      error: { message: string; retryable: boolean };
    };
    expect(body.status).toBe('failed');
    expect(body.error.retryable).toBe(true);
    expect(body.error.message).toContain('超时');
  });
});

describe('GET /api/jobs/:id', () => {
  it('跑太久标记 timeout，但保留 providerJobId 以便续捞', async () => {
    const { handler, repo, tick } = setup();
    const created = await handler(post(createBody()));
    const { id } = (await created.json()) as { id: string };

    tick(121_000);
    const response = await handler(get(`/api/jobs/${id}`));
    const body = (await response.json()) as { status: string; error: { code: string } };

    expect(body.status).toBe('timeout');
    expect(body.error.code).toBe('TIMEOUT');
    expect(repo.get(id)?.providerJobId).toBe('p_1');
  });

  it('不存在的任务 → 404', async () => {
    const { handler } = setup();
    const response = await handler(get('/api/jobs/job_nope'));
    expect(response.status).toBe(404);
  });
});

describe('DELETE /api/jobs/:id', () => {
  it('删掉之后查不到', async () => {
    const { handler } = setup();
    const created = await handler(post(createBody()));
    const { id } = (await created.json()) as { id: string };

    const removed = await handler(
      new Request(`http://localhost/api/jobs/${id}`, { method: 'DELETE' }),
    );
    expect(removed.status).toBe(200);

    const after = await handler(get(`/api/jobs/${id}`));
    expect(after.status).toBe(404);
  });
});

describe('GET /api/jobs/:id/model', () => {
  /**
   * 造一个"上游已成功"的任务：provider 只给 assetUrl，不给 glbUrl。
   * 这正是真实 provider（混元）的行为，mock 因为用仓库静态资源不走这条路。
   */
  async function succeededWithAsset(assetUrl: string, fetchUpstream?: typeof fetch) {
    const repo = new MemoryRepo();
    const fake = createFakeProvider();
    fake.provider.query = async () => ({
      state: 'succeeded',
      progress: 1,
      stage: 'download',
      assetUrl,
      costYuan: 2.4,
    });

    const handler = createHandler({
      store: repo,
      provider: fake.provider,
      env: {},
      hashIp: async () => 'hash:x',
      fetchUpstream,
    });

    const created = await handler(post(createBody()));
    const { id } = (await created.json()) as { id: string };
    await handler(get(`/api/jobs/${id}`));
    return { handler, repo, id };
  }

  const okFetch = (async () =>
    new Response('glTF-binary', { status: 200 })) as unknown as typeof fetch;

  it('成功时把上游地址换成自家转发路径，不外泄', async () => {
    const { repo, id } = await succeededWithAsset('https://upstream.example/a.glb', okFetch);
    const job = repo.get(id);

    expect(job?.assetUrl).toBe('https://upstream.example/a.glb');
    // 前端拿到的必须是自家路径，而不是带签名的上游地址
    expect(job?.glbUrl).toBe(`/api/jobs/${id}/model`);
  });

  it('成本用上游结算值，不是事前估算', async () => {
    const { repo, id } = await succeededWithAsset('https://upstream.example/a.glb', okFetch);
    expect(repo.get(id)?.costYuan).toBe(2.4);
  });

  it('转发上游文件，并标成 gltf-binary', async () => {
    const { handler, id } = await succeededWithAsset('https://upstream.example/a.glb', okFetch);
    const response = await handler(get(`/api/jobs/${id}/model`));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('model/gltf-binary');
    expect(await response.text()).toBe('glTF-binary');
  });

  it('上游文件过期（404）时如实报错，不假装成功', async () => {
    const deadFetch = (async () =>
      new Response('gone', { status: 404 })) as unknown as typeof fetch;
    const { handler, id } = await succeededWithAsset('https://upstream.example/a.glb', deadFetch);

    const response = await handler(get(`/api/jobs/${id}/model`));
    expect(response.status).toBe(502);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('过期');
  });

  it('非法协议（file://）不转发 —— 否则可能读到服务器本地文件', async () => {
    const { handler, id } = await succeededWithAsset('file:///etc/passwd', okFetch);
    const response = await handler(get(`/api/jobs/${id}/model`));
    expect(response.status).toBe(500);
  });

  it('任务不存在时返回 404', async () => {
    const { handler } = setup();
    const response = await handler(get('/api/jobs/job_nope/model'));
    expect(response.status).toBe(404);
  });
});

describe('未知路由', () => {
  it('返回 404 而不是崩掉', async () => {
    const { handler } = setup();
    const response = await handler(get('/api/nope'));
    expect(response.status).toBe(404);
  });
});
