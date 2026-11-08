/**
 * 界面模式：简单 / 完整。
 *
 * 完整模式里塞了太多"只有摆场景才用得上"的东西 —— 场景对象列表、
 * 移动/旋转/缩放 gizmo、网格线框、PBR 与面数。第一次用的人面对这些
 * 只会卡住：他只是想把一张图变成模型然后拿走。
 *
 * 所以加一层模式开关：简单模式只留"选图 → 选档位 → 生成 → 下载"，
 * 其余折叠掉但**不删**，一键就能切回来。
 */

export type UiMode = 'simple' | 'pro';

export const UI_MODE_LABEL: Record<UiMode, string> = {
  simple: '简单',
  pro: '完整',
};

export const UI_MODE_HINT: Record<UiMode, string> = {
  simple: '只保留选图、生成、下载',
  pro: '多模型摆放、变换 gizmo、网格线框等全部显示',
};

/** 没存过 / 存坏了，一律回落到简单模式 —— 默认给最少的选择 */
export function parseUiMode(raw: string | null | undefined): UiMode {
  if (!raw) return 'simple';
  try {
    const parsed = JSON.parse(raw) as { mode?: unknown };
    return parsed.mode === 'pro' ? 'pro' : 'simple';
  } catch {
    // 兼容早期可能直接存 'simple' / 'pro' 的写法
    return raw === 'pro' ? 'pro' : 'simple';
  }
}

export function serializeUiMode(mode: UiMode): string {
  return JSON.stringify({ version: 1, mode });
}

export type SceneAction = 'add' | 'replace' | 'skip';

/**
 * 生成成功后这个模型该怎么进场景。
 *
 * 简单模式下永远只留一个模型：新生成的直接替换掉旧的。
 * 否则"再生成一次"会在场景里堆三个一样的模型，用户还得手动删 —— 那一点都不简单。
 */
export function resolveSceneAction(input: {
  mode: UiMode;
  assetKey: string;
  existing: readonly string[];
}): SceneAction {
  const already = input.existing.includes(input.assetKey);
  if (already) return input.mode === 'simple' ? 'skip' : 'add';
  return input.mode === 'simple' ? 'replace' : 'add';
}
