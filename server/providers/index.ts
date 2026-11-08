import type { ServerProvider } from '../types.ts';
import { HunyuanProvider } from './hunyuan.ts';
import { LocalProvider } from './local.ts';
import { ServerMockProvider } from './mock.ts';

/**
 * Provider 工厂：按环境变量选实现。
 *
 * 为什么放在服务端而不是前端：密钥必须留在服务端。前端只认 `/api` 这套契约，
 * 换 provider 对它完全透明 —— 这也是这个工厂存在的全部意义。
 *
 * 没配密钥时**不报错、不假装有**，而是退回 mock 并把原因写进 report，
 * 这样开发环境永远能跑起来，但 `/api/health` 会如实说明"当前不是真后端"。
 */

export interface ProviderBundle {
  provider: ServerProvider;
  /** 想要的后端（环境变量指定的） */
  wanted: string;
  /** 实际生效的是不是它 */
  active: string;
  /** 不是的话，原因是什么（不泄露密钥内容） */
  reason: string | null;
}

export function createProvider(env: Record<string, string | undefined>): ProviderBundle {
  const wanted = (env.P3D_PROVIDER ?? 'mock').toLowerCase();

  if (wanted === 'local') {
    // 本地推理不需要密钥：模型跑在自己显卡上，不经过任何第三方。
    // 引擎是独立进程（local-engine/engine.py），这里只记地址，不在这里探活 ——
    // 工厂是同步的，而"引擎没起来"应该在用户提交任务时如实报错，不能假装能用。
    return {
      provider: new LocalProvider({ baseUrl: env.P3D_ENGINE_URL }),
      wanted,
      active: 'local',
      reason: null,
    };
  }

  if (wanted === 'hunyuan') {
    const secretId = env.TENCENTCLOUD_SECRET_ID ?? env.P3D_SECRET_ID ?? '';
    const secretKey = env.TENCENTCLOUD_SECRET_KEY ?? env.P3D_SECRET_KEY ?? '';

    if (!secretId || !secretKey) {
      return {
        provider: new ServerMockProvider(),
        wanted,
        active: 'mock',
        reason: '缺少 TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY，退回 mock',
      };
    }

    const pointYuan = Number(env.P3D_POINT_YUAN ?? 0.1);
    return {
      provider: new HunyuanProvider({
        secretId,
        secretKey,
        region: env.P3D_REGION,
        endpoint: env.P3D_ENDPOINT,
        pointYuan: Number.isFinite(pointYuan) && pointYuan > 0 ? pointYuan : 0.1,
      }),
      wanted,
      active: 'hunyuan',
      reason: null,
    };
  }

  return { provider: new ServerMockProvider(), wanted, active: 'mock', reason: null };
}
