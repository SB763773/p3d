import { HttpProvider } from '@/lib/providers/http';
import { MockProvider } from '@/lib/providers/mock';
import type {
  ImageTo3DProvider,
  ProviderCapabilities,
  ProviderStatus,
  SubmitInput,
} from '@/lib/providers/types';
import { ERROR_CODES, ProviderError } from '@/lib/providers/types';

/**
 * Provider 工厂（方案 §4.4）。
 *
 * 加一家真实后端 = 服务端新增一个实现，前端一行不改。
 * 前端这边只有两种：走 BFF（默认），或者本地 mock（离线演示 / 纯静态托管）。
 */

export type ProviderId = 'server' | 'mock';

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  server: '服务端 BFF',
  mock: '本地 Mock',
};

class NotConfiguredProvider implements ImageTo3DProvider {
  readonly capabilities: ProviderCapabilities = {
    pbr: false,
    faceCount: false,
    multiView: false,
    estimateCostYuan: () => 0,
  };

  constructor(
    readonly name: string,
    readonly label: string,
  ) {}

  async submit(_input: SubmitInput): Promise<{ providerJobId: string }> {
    throw new ProviderError(ERROR_CODES.NOT_CONFIGURED, `后端 ${this.label} 未配置`, false);
  }

  async query(_providerJobId: string): Promise<ProviderStatus> {
    return {
      state: 'failed',
      code: ERROR_CODES.NOT_CONFIGURED,
      message: '后端未配置',
      retryable: false,
    };
  }
}

let singleton: ImageTo3DProvider | null = null;

function resolveProvider(): ImageTo3DProvider {
  const configured = (import.meta.env.VITE_P3D_PROVIDER ?? 'server') as
    | ProviderId
    | 'hunyuan'
    | 'fal';

  if (configured === 'hunyuan' || configured === 'fal') {
    // 这两家只能走服务端：前端直连等于把密钥打进构建产物
    return new NotConfiguredProvider(
      configured,
      `${configured}（请通过服务端 BFF 接入，前端不允许直连）`,
    );
  }
  if (configured === 'mock') return new MockProvider();
  return new HttpProvider();
}

export function getProvider(): ImageTo3DProvider {
  singleton ??= resolveProvider();
  return singleton;
}

/** 仅测试用：重置单例 */
export function __resetProvider() {
  singleton = null;
}

export type { ImageTo3DProvider };
