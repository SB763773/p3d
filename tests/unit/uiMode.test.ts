import { describe, expect, it } from 'vitest';
import { parseUiMode, resolveSceneAction, serializeUiMode } from '@/lib/uiMode';

describe('parseUiMode', () => {
  it('没存过 → 简单模式（默认给最少的选择）', () => {
    expect(parseUiMode(null)).toBe('simple');
    expect(parseUiMode(undefined)).toBe('simple');
  });

  it('能读回完整模式', () => {
    expect(parseUiMode(serializeUiMode('pro'))).toBe('pro');
    expect(parseUiMode(serializeUiMode('simple'))).toBe('simple');
  });

  it('内容坏了不会崩，回落到简单模式', () => {
    expect(parseUiMode('{oops')).toBe('simple');
    expect(parseUiMode('{"mode":"别人塞的值"}')).toBe('simple');
    expect(parseUiMode('{"version":1}')).toBe('simple');
  });

  it('兼容早期直接存 simple / pro 的写法', () => {
    expect(parseUiMode('pro')).toBe('pro');
    expect(parseUiMode('simple')).toBe('simple');
  });
});

describe('serializeUiMode', () => {
  it('带上版本号，以后改结构好分辨', () => {
    expect(JSON.parse(serializeUiMode('pro'))).toEqual({ version: 1, mode: 'pro' });
  });
});

describe('resolveSceneAction', () => {
  it('完整模式：每个新模型并排放一个', () => {
    expect(resolveSceneAction({ mode: 'pro', assetKey: 'a.glb', existing: [] })).toBe('add');
    expect(resolveSceneAction({ mode: 'pro', assetKey: 'b.glb', existing: ['a.glb'] })).toBe('add');
  });

  it('简单模式：新模型替换旧的，场景里始终只有一个', () => {
    expect(resolveSceneAction({ mode: 'simple', assetKey: 'b.glb', existing: ['a.glb'] })).toBe(
      'replace',
    );
  });

  it('同一个模型已经在场景里：简单模式保持不动，完整模式再摆一个', () => {
    expect(resolveSceneAction({ mode: 'simple', assetKey: 'a.glb', existing: ['a.glb'] })).toBe(
      'skip',
    );
    expect(resolveSceneAction({ mode: 'pro', assetKey: 'a.glb', existing: ['a.glb'] })).toBe('add');
  });
});
