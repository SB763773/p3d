import { describe, expect, it } from 'vitest';
import {
  dayKeyOf,
  evaluateGate,
  limitsFromEnv,
  nextResetAt,
  summarizeToday,
} from '../../server/gate.ts';

const BASE_LIMITS = {
  killSwitch: false,
  ipDailyQuota: 10,
  dailyBudgetYuan: 30,
  maxCostPerJobYuan: 5,
};

/** 2026-10-25 12:00 北京时间 */
const NOON = Date.UTC(2026, 9, 25, 4, 0, 0);

const gate = (over: Partial<Parameters<typeof evaluateGate>[0]> = {}) =>
  evaluateGate({
    jobCountIpToday: 0,
    spentTodayYuan: 0,
    estimateYuan: 2.5,
    limits: BASE_LIMITS,
    now: NOON,
    ...over,
  });

describe('按中国时区切天', () => {
  it('北京时间 23:59 与次日 00:01 属于不同的一天', () => {
    const beforeMidnight = Date.UTC(2026, 9, 25, 15, 59, 0); // 北京 23:59
    const afterMidnight = Date.UTC(2026, 9, 25, 16, 1, 0); // 北京次日 00:01
    expect(dayKeyOf(beforeMidnight)).toBe('2026-10-25');
    expect(dayKeyOf(afterMidnight)).toBe('2026-10-26');
  });

  it('重置时间落在北京时间零点', () => {
    const reset = nextResetAt(NOON);
    expect(dayKeyOf(reset)).toBe('2026-10-26');
    expect(new Date(reset).toISOString()).toBe('2026-10-25T16:00:00.000Z');
    expect(reset).toBeGreaterThan(NOON);
  });
});

describe('evaluateGate', () => {
  it('正常情况放行', () => {
    expect(gate()).toEqual({ allow: true });
  });

  it('熔断开关优先于一切', () => {
    const decision = gate({
      limits: { ...BASE_LIMITS, killSwitch: true },
      jobCountIpToday: 999,
      spentTodayYuan: 999,
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.status).toBe(503);
      expect(decision.code).toBe('KILL_SWITCH');
    }
  });

  it('单次成本超上限 → 402，先于限流判断', () => {
    const decision = gate({
      estimateYuan: 6,
      jobCountIpToday: 999,
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.status).toBe(402);
      expect(decision.message).toContain('单次上限');
    }
  });

  it('单 IP 配额用尽 → 429，并给出重置时间', () => {
    const decision = gate({ jobCountIpToday: 10 });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.status).toBe(429);
      expect(decision.code).toBe('RATE_LIMITED');
      expect(decision.resetAt).toBeDefined();
    }
  });

  it('第 10 次仍然放行，第 11 次才拦', () => {
    expect(gate({ jobCountIpToday: 9 }).allow).toBe(true);
    expect(gate({ jobCountIpToday: 10 }).allow).toBe(false);
  });

  it('全局预算撑不住这一单 → 402', () => {
    const decision = gate({ spentTodayYuan: 28, estimateYuan: 2.5 });
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.status).toBe(402);
  });

  it('预算刚好等于上限时放行（不因为浮点抖动误伤）', () => {
    expect(gate({ spentTodayYuan: 27.5, estimateYuan: 2.5 }).allow).toBe(true);
  });
});

describe('summarizeToday', () => {
  const jobs = [
    { createdAt: NOON, costYuan: 2.5, clientIpHash: 'ipA' },
    { createdAt: NOON, costYuan: 2.5, clientIpHash: 'ipB' },
    { createdAt: NOON, costYuan: 1.5, clientIpHash: 'ipA' },
    // 昨天的不计入
    { createdAt: NOON - 24 * 3600 * 1000, costYuan: 9, clientIpHash: 'ipA' },
  ];

  it('只统计当天，并按 IP 分桶', () => {
    const snapshot = summarizeToday(jobs, NOON, 'ipA');
    expect(snapshot.jobCountIpToday).toBe(2);
    expect(snapshot.spentTodayYuan).toBeCloseTo(6.5);
    expect(snapshot.dayKey).toBe('2026-10-25');
  });

  it('没跑过任务时全为 0', () => {
    const snapshot = summarizeToday([], NOON, 'ipA');
    expect(snapshot.jobCountIpToday).toBe(0);
    expect(snapshot.spentTodayYuan).toBe(0);
  });
});

describe('limitsFromEnv', () => {
  it('缺省时用安全默认值', () => {
    const limits = limitsFromEnv({});
    expect(limits.killSwitch).toBe(false);
    expect(limits.ipDailyQuota).toBe(10);
    expect(limits.dailyBudgetYuan).toBe(30);
    expect(limits.maxCostPerJobYuan).toBe(5);
  });

  it('读得到就按环境变量走，非法值退回默认', () => {
    const limits = limitsFromEnv({
      P3D_KILL_SWITCH: '1',
      P3D_IP_DAILY_QUOTA: '3',
      P3D_DAILY_BUDGET_YUAN: '0',
      P3D_MAX_JOB_YUAN: 'abc',
    });
    expect(limits.killSwitch).toBe(true);
    expect(limits.ipDailyQuota).toBe(3);
    // 预算 0 是合法的"当天不许再花钱"，不能被默认值覆盖
    expect(limits.dailyBudgetYuan).toBe(0);
    expect(limits.maxCostPerJobYuan).toBe(5);
  });
});
