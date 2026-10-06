/**
 * F2 唯一统计出口：`category-pearson-v1`（**独立**于旧 Spearman / `/api/study-insights` 的 rho 字段）。
 *
 * 口径（Sol §1A ②③）：
 *  · 指标名 `r`、方法 `pearson`、单位 `session`（一 session 最多一对样本，绝不把桶当样本）；
 *  · 每 pair 有效 N ≥ 10（`MIN_PAIRS`）才允许产出数值；
 *  · 任一维零方差（含"全等值"精确拦截）⇒ `r=null` 且 `reason='zero_variance'`；
 *  · 绝不返回 NaN / Infinity / 越界 r；数学实现在 `addons/vendor/simple-statistics/`（原样复用）。
 */

import { sampleCorrelation, sampleVariance } from '../vendor/simple-statistics/index.js';

export type PairReason =
  | 'ok'
  | 'insufficient_n'
  | 'zero_variance'
  | 'blocked_unknown_processing'
  | 'no_valid_inference';

export type ScoreDimension = 'focus' | 'efficiency';

/** 最少配对数（Sol §1A ①：每 pair 有效 N ≥ 10）。 */
export const MIN_PAIRS = 10;

export interface PairNumbers {
  n: number;
  r: number | null;
  reason: PairReason;
}

/** 合法 r 的容差（只容浮点末位误差，不做业务级宽容）。 */
const R_EPS = 1e-12;

/**
 * 纯函数：两个等长数组的样本 Pearson r。
 *
 * 非法输入（长度不等 / 非有限数）是**契约错误**，直接抛（与"正常样本不足"分开，不得混成 null）。
 */
export function pearsonPair(xs: readonly number[], ys: readonly number[]): PairNumbers {
  if (xs.length !== ys.length || xs.some((x) => !Number.isFinite(x)) || ys.some((y) => !Number.isFinite(y))) {
    throw new Error('PAIR_CONTRACT');
  }
  const n = xs.length;
  if (n < MIN_PAIRS) return { n, r: null, reason: 'insufficient_n' };
  // 两数组全等值先精确拦截（含 n≥2 的常数序列）；库方差复核，防除零。
  if (xs.every((x) => x === xs[0]) || ys.every((y) => y === ys[0])) {
    return { n, r: null, reason: 'zero_variance' };
  }
  if (sampleVariance(xs) === 0 || sampleVariance(ys) === 0) {
    return { n, r: null, reason: 'zero_variance' };
  }
  const r = sampleCorrelation(xs, ys);
  if (!Number.isFinite(r) || Math.abs(r) > 1 + R_EPS) throw new Error('STAT_NUMERIC');
  return { n, r: Math.max(-1, Math.min(1, r)), reason: 'ok' };
}
