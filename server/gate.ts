/**
 * 成本与配额闸门（方案 §8.3 的三道闸门 + 熔断开关）。
 *
 * 全部写成纯函数，因为这类"差一位就白烧钱"的逻辑最难靠肉眼验证：
 * 阈值判断、跨天边界、计数口径，都得有单测盯着。
 */

export interface GateLimits {
  /** 熔断开关：为 true 时全站停止生成 */
  killSwitch: boolean;
  /** 单 IP 每日次数上限 */
  ipDailyQuota: number;
  /** 全局每日预算（元） */
  dailyBudgetYuan: number;
  /** 单次任务成本上限（元） */
  maxCostPerJobYuan: number;
}

export interface GateInput {
  /** 这个 IP 今天已经提交过多少任务 */
  jobCountIpToday: number;
  /** 全局今天已经花掉多少钱 */
  spentTodayYuan: number;
  /** 本次任务的预估成本 */
  estimateYuan: number;
  limits: GateLimits;
  now: number;
}

export type GateDecision =
  | { allow: true }
  | {
      allow: false;
      status: number;
      code: string;
      message: string;
      /** 配额重置时间（毫秒时间戳），便于前端显示"几点恢复" */
      resetAt?: number;
    };

/** 按中国时区切天。用固定 +8 而不是跟随运行环境，保证行为和部署地无关 */
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function dayKeyOf(timestamp: number): string {
  return new Date(timestamp + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

/** 下一个自然日零点（北京时间）的时间戳 */
export function nextResetAt(timestamp: number): number {
  const shifted = timestamp + TZ_OFFSET_MS;
  return Math.floor(shifted / DAY_MS) * DAY_MS + DAY_MS - TZ_OFFSET_MS;
}

export function evaluateGate(input: GateInput): GateDecision {
  const { jobCountIpToday, spentTodayYuan, estimateYuan, limits, now } = input;

  if (limits.killSwitch) {
    return {
      allow: false,
      status: 503,
      code: 'KILL_SWITCH',
      message: '生成服务正在维护，稍后再试。',
    };
  }

  // 单次成本上限：先拦最贵的，避免一次误操作吃掉整天预算
  if (estimateYuan > limits.maxCostPerJobYuan) {
    return {
      allow: false,
      status: 402,
      code: 'QUOTA_EXCEEDED',
      message: `这次任务预估 ¥${estimateYuan.toFixed(2)}，超过单次上限 ¥${limits.maxCostPerJobYuan}，请降低质量档位。`,
    };
  }

  if (jobCountIpToday >= limits.ipDailyQuota) {
    return {
      allow: false,
      status: 429,
      code: 'RATE_LIMITED',
      message: `今日生成次数已用完（每天 ${limits.ipDailyQuota} 次），明天再来。`,
      resetAt: nextResetAt(now),
    };
  }

  if (spentTodayYuan + estimateYuan > limits.dailyBudgetYuan) {
    return {
      allow: false,
      status: 402,
      code: 'QUOTA_EXCEEDED',
      message: `今日总额度已用完（预算 ¥${limits.dailyBudgetYuan}），明天再来。`,
      resetAt: nextResetAt(now),
    };
  }

  return { allow: true };
}

export interface QuotaSnapshot {
  jobCountIpToday: number;
  spentTodayYuan: number;
  dayKey: string;
}

interface CountableJob {
  createdAt: number;
  costYuan: number;
  clientIpHash: string;
}

/** 统计"今天"这个 IP 的次数与全局花费 */
export function summarizeToday(
  jobs: readonly CountableJob[],
  now: number,
  clientIpHash: string,
): QuotaSnapshot {
  const dayKey = dayKeyOf(now);
  let jobCountIpToday = 0;
  let spentTodayYuan = 0;

  for (const job of jobs) {
    if (dayKeyOf(job.createdAt) !== dayKey) continue;
    spentTodayYuan += job.costYuan;
    if (job.clientIpHash === clientIpHash) jobCountIpToday += 1;
  }

  return {
    jobCountIpToday,
    spentTodayYuan: Number(spentTodayYuan.toFixed(4)),
    dayKey,
  };
}

export function limitsFromEnv(env: Record<string, string | undefined>): GateLimits {
  const num = (key: string, fallback: number) => {
    const raw = env[key];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };

  return {
    killSwitch: env.P3D_KILL_SWITCH === '1',
    ipDailyQuota: num('P3D_IP_DAILY_QUOTA', 10),
    dailyBudgetYuan: num('P3D_DAILY_BUDGET_YUAN', 30),
    maxCostPerJobYuan: num('P3D_MAX_JOB_YUAN', 5),
  };
}
