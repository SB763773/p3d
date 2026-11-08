import { describe, expect, it } from 'vitest';
import { canTransition, isTerminal, projectProgress } from '@/lib/jobMachine';

describe('任务状态机', () => {
  it('合法路径：queued → running → succeeded', () => {
    expect(canTransition('queued', 'running')).toBe(true);
    expect(canTransition('running', 'succeeded')).toBe(true);
  });

  it('非法路径：succeeded 不能退回 running', () => {
    expect(canTransition('succeeded', 'running')).toBe(false);
    expect(canTransition('succeeded', 'failed')).toBe(false);
    expect(isTerminal('succeeded')).toBe(true);
  });

  it('失败是终态：重试会新建任务，而不是改回 queued', () => {
    expect(canTransition('failed', 'queued')).toBe(false);
    expect(canTransition('failed', 'running')).toBe(false);
    expect(isTerminal('failed')).toBe(true);
  });

  it('超时不是失败，还能被后台捞回成 succeeded', () => {
    expect(canTransition('timeout', 'succeeded')).toBe(true);
    expect(isTerminal('timeout')).toBe(false);
  });
});

describe('进度映射', () => {
  it('各阶段落在各自区间内，不越界', () => {
    expect(projectProgress({ status: 'running', stage: 'queued', raw: 1 })).toBeCloseTo(0.2);
    expect(projectProgress({ status: 'running', stage: 'geometry', raw: 0 })).toBeCloseTo(0.2);
    expect(projectProgress({ status: 'running', stage: 'geometry', raw: 1 })).toBeCloseTo(0.6);
    expect(projectProgress({ status: 'running', stage: 'texture', raw: 1 })).toBeCloseTo(0.95);
  });

  it('未完成时永远不给 100%，避免"卡在 100% 却没结果"', () => {
    expect(projectProgress({ status: 'running', stage: 'download', raw: 1 })).toBeLessThanOrEqual(
      0.99,
    );
    expect(projectProgress({ status: 'succeeded', stage: 'download', raw: 0.4 })).toBe(1);
  });

  it('排队中进度为 0，导出后进度按阶段单调不减', () => {
    expect(projectProgress({ status: 'queued', stage: 'queued', raw: 0.5 })).toBe(0);
    const stages = ['queued', 'geometry', 'texture', 'download'] as const;
    let previous = -1;
    for (const stage of stages) {
      const value = projectProgress({ status: 'running', stage, raw: 0.5 });
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });
});
