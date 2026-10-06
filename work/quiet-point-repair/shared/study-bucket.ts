/**
 * 桶聚合记账层（阶段3 契约 → 阶段4/增强A 的公共前置）。
 *
 * 为什么要有它：服务端 `bucketSchema` 有若干**强校验不变量**（实探逐字得到）：
 *   1) `categoryMs 各项和必须等于 classifiedMs`
 *   2) `categoryUnknownMs 必须等于桶宽−classifiedMs`
 *   3) `quietMs + noisyMs + unknownMs` 必须等于桶宽（5000ms）
 *   4) `classifiedMs ≤ validInferenceMs ≤ 桶宽`
 * 这些约束一旦违反，服务端直接 400（整批回滚）。把它们**前置到本地**并在构造时就抛错，
 * 可以避免"真机上跑了 5 分钟才发现整批被拒"。
 *
 * 本模块是**纯函数式记账**：不做平滑、不做阈值、不猜类别 —— 判定（categoryId/score）由调用方
 * （增强 A 的推理+平滑管线）给出；这里只负责把"时间账"算对并产出合法 BucketDTO。
 * 任何字段都来自入参实测值，不生成占位数据；没有判定就是 `null`（→ categoryUnknownMs）。
 */

import {
  BUCKET_WIDTH_MS,
  CATEGORY_IDS,
  type CategoryId,
} from './study-model.js';

/** 单次推理判定覆盖的时间片。 */
export interface BucketTick {
  /** 该片覆盖时长（毫秒）；通常等于一次 patch 的有效推理时长。 */
  durationMs: number;
  /** 判定类别；`null` 表示本次没有可用判定（模型不可用/未分类）→ 计入 categoryUnknownMs。 */
  categoryId: CategoryId | null;
  /** 该次判定的置信度（模型原始分数，0..1）；categoryId 为 null 时忽略。 */
  score: number;
}

export interface BucketAccounting {
  /** 采样层给出的"静"时长（来自既有 dBFS 判定）。 */
  quietMs: number;
  /** 采样层给出的"吵"时长。 */
  noisyMs: number;
}

export interface BucketCounters {
  inferenceCount: number;
  expectedWindowCount: number;
  droppedWindowCount: number;
  clippedMs: number;
  resampleClampCount: number;
}

export interface BucketVersions {
  modelHash: string;
  runtimeVersion: string;
  preprocessVersion: string;
  mapVersion: string;
  decisionVersion: string;
}

export interface BuildBucketArgs {
  id: string;
  sessionId: string;
  bucketIndex: number;
  ticks: BucketTick[];
  accounting: BucketAccounting;
  counters: BucketCounters;
  versions: BucketVersions;
  aiStatus: 'ready' | 'reduced' | 'unavailable';
  reason: string | null;
  /** 桶宽；默认 5000ms（阶段3 契约）。 */
  bucketWidthMs?: number;
  /** 生成 episode id 的注入点（默认 `crypto.randomUUID`；测试可注入确定性实现）。 */
  newEpisodeId?: () => string;
  /** 连续多少片同一类别才记为一个 episode；默认 2（≈2 秒）。 */
  minEpisodeTicks?: number;
  /**
   * episode 生产者来源（Sol §R8 冲突②裁定）。**默认 `'bucket'` ⇒ 既有调用方行为逐字不变**：
   * - `'bucket'`（legacy）：沿用下面的逐桶 tick 扫描生成 episode —— 旧路径兼容与旧测试专用；
   * - `'session'`：**在扫描前就跳过**逐桶生成逻辑（`episodes` 恒为 `[]`），由正式适配器
   *   `buildBucketWithSessionEpisodes()` 用会话状态机的已确认记录按规定求交集填充。
   *   正式增强 A 路径必须传 `'session'`，桶内算法不得分配 episode 身份/计数。
   */
  episodeSource?: 'bucket' | 'session';
}

/** 与服务端 `bucketSchema` 同形的输出（此处以宽类型表达，避免与 zod 推断互相牵制）。 */
export interface BuiltBucket {
  id: string;
  sessionId: string;
  bucketIndex: number;
  startOffsetMs: number;
  endOffsetMs: number;
  quietMs: number;
  noisyMs: number;
  unknownMs: number;
  validInferenceMs: number;
  classifiedMs: number;
  categoryMs: Record<string, number>;
  categoryUnknownMs: number;
  top3: { categoryId: CategoryId; score: number }[];
  episodes: { episodeId: string; startOffsetMs: number; kind: 'confirmed' | 'leftCensored' }[];
  inferenceCount: number;
  expectedWindowCount: number;
  droppedWindowCount: number;
  clippedMs: number;
  resampleClampCount: number;
  aiStatus: 'ready' | 'reduced' | 'unavailable';
  reason: string | null;
  modelHash: string;
  runtimeVersion: string;
  preprocessVersion: string;
  mapVersion: string;
  decisionVersion: string;
}

const isCategory = (value: string): value is CategoryId => (CATEGORY_IDS as readonly string[]).includes(value);

/**
 * 构造一个满足服务端全部不变量的桶。
 * 违反不变量时**抛错**（本地 fail-fast），绝不产出"看起来能过"的数据。
 */
export function buildBucket(args: BuildBucketArgs): BuiltBucket {
  const width = args.bucketWidthMs ?? BUCKET_WIDTH_MS;
  const { quietMs, noisyMs } = args.accounting;
  const fail = (message: string): never => {
    throw new Error(`桶记账不合法（bucketIndex=${args.bucketIndex}）：${message}`);
  };

  if (!Number.isInteger(width) || width <= 0) fail(`桶宽非法：${String(width)}`);
  for (const [name, value] of Object.entries({ quietMs, noisyMs })) {
    if (!Number.isInteger(value) || value < 0) fail(`${name} 非法：${String(value)}`);
  }
  if (quietMs + noisyMs > width) fail(`quietMs+noisyMs=${quietMs + noisyMs} 超过桶宽 ${width}`);

  let validInferenceMs = 0;
  const categoryMs = new Map<string, number>();
  const categoryScoreSum = new Map<string, number>();
  const categoryTickCount = new Map<string, number>();

  for (const tick of args.ticks) {
    if (!Number.isFinite(tick.durationMs) || tick.durationMs <= 0) {
      fail(`tick.durationMs 非法：${String(tick.durationMs)}`);
    }
    validInferenceMs += tick.durationMs;
    if (tick.categoryId === null) continue;
    if (!isCategory(tick.categoryId)) fail(`未知类别：${String(tick.categoryId)}`);
    if (!Number.isFinite(tick.score) || tick.score < 0 || tick.score > 1) {
      fail(`tick.score 越界：${String(tick.score)}`);
    }
    categoryMs.set(tick.categoryId, (categoryMs.get(tick.categoryId) ?? 0) + tick.durationMs);
    categoryScoreSum.set(tick.categoryId, (categoryScoreSum.get(tick.categoryId) ?? 0) + tick.score);
    categoryTickCount.set(tick.categoryId, (categoryTickCount.get(tick.categoryId) ?? 0) + 1);
  }
  if (validInferenceMs > width) fail(`validInferenceMs=${validInferenceMs} 超过桶宽 ${width}`);

  let classifiedMs = 0;
  for (const ms of categoryMs.values()) classifiedMs += ms;
  if (classifiedMs > validInferenceMs) fail(`classifiedMs=${classifiedMs} 超过 validInferenceMs=${validInferenceMs}`);

  const categoryUnknownMs = width - classifiedMs;
  const unknownMs = width - quietMs - noisyMs;

  // 全类别补齐（缺项补 0）：服务端要求 categoryMs 覆盖 12 类且和 == classifiedMs。
  const categoryRecord: Record<string, number> = {};
  for (const id of CATEGORY_IDS) categoryRecord[id] = categoryMs.get(id) ?? 0;

  const top3 = [...categoryMs.entries()]
    .map(([categoryId, ms]) => ({
      categoryId: categoryId as CategoryId,
      ms,
      // 分数取该类别各 tick 的**平均值**（模型自身分数的聚合，不放大、不编造）
      score: (categoryScoreSum.get(categoryId) as number) / (categoryTickCount.get(categoryId) as number),
    }))
    .sort((a, b) => (b.ms !== a.ms ? b.ms - a.ms : a.categoryId.localeCompare(b.categoryId)))
    .slice(0, 3)
    .map(({ categoryId, score }) => ({ categoryId, score }));

  // episodes：同一类别连续 ≥ minEpisodeTicks 片记为一个 episode；与桶起点相接的记 leftCensored。
  // Sol §R8：下面的逐桶生成逻辑**在扫描前**按 episodeSource 分支 —— 正式增强 A 传 `'session'`
  // 时循环条件直接为假，扫描一次都不执行（episodes 恒为 []），身份/计数全部由会话状态机生产。
  // 旧 `'bucket'` 分支逐字未改，既有调用方与旧断言行为不变。
  const episodeSource = args.episodeSource ?? 'bucket';
  const minEpisodeTicks = args.minEpisodeTicks ?? 2;
  const newId = args.newEpisodeId ?? (() => globalThis.crypto.randomUUID());
  const tickOffsets: number[] = [];
  {
    let acc = 0;
    for (const tick of args.ticks) {
      tickOffsets.push(acc);
      acc += tick.durationMs;
    }
  }
  const episodes: BuiltBucket['episodes'] = [];
  let runStart = 0;
  while (episodeSource === 'bucket' && runStart < args.ticks.length) {
    const categoryId = (args.ticks[runStart] as BucketTick).categoryId;
    let runEnd = runStart;
    while (
      runEnd + 1 < args.ticks.length &&
      (args.ticks[runEnd + 1] as BucketTick).categoryId === categoryId
    ) {
      runEnd += 1;
    }
    const runLength = runEnd - runStart + 1;
    if (categoryId !== null && runLength >= minEpisodeTicks) {
      episodes.push({
        episodeId: newId(),
        startOffsetMs: tickOffsets[runStart] as number,
        kind: runStart === 0 ? 'leftCensored' : 'confirmed',
      });
    }
    runStart = runEnd + 1;
  }

  return {
    id: args.id,
    sessionId: args.sessionId,
    bucketIndex: args.bucketIndex,
    startOffsetMs: args.bucketIndex * width,
    endOffsetMs: args.bucketIndex * width + width,
    quietMs,
    noisyMs,
    unknownMs,
    validInferenceMs,
    classifiedMs,
    categoryMs: categoryRecord,
    categoryUnknownMs,
    top3,
    episodes,
    inferenceCount: args.counters.inferenceCount,
    expectedWindowCount: args.counters.expectedWindowCount,
    droppedWindowCount: args.counters.droppedWindowCount,
    clippedMs: args.counters.clippedMs,
    resampleClampCount: args.counters.resampleClampCount,
    aiStatus: args.aiStatus,
    reason: args.reason,
    ...args.versions,
  };
}

/**
 * 本地自检：把服务端会拒的四种情况提前判出来（供调用方在发包前断言）。
 * 返回 null 表示这个桶满足全部不变量。
 */
export function checkBucketInvariants(bucket: BuiltBucket, bucketWidthMs: number = BUCKET_WIDTH_MS): string | null {
  const sumCategory = Object.values(bucket.categoryMs).reduce((a, b) => a + b, 0);
  if (sumCategory !== bucket.classifiedMs) return `categoryMs 和 ${sumCategory} ≠ classifiedMs ${bucket.classifiedMs}`;
  if (bucket.categoryUnknownMs !== bucketWidthMs - bucket.classifiedMs) {
    return `categoryUnknownMs ${bucket.categoryUnknownMs} ≠ 桶宽−classifiedMs ${bucketWidthMs - bucket.classifiedMs}`;
  }
  if (bucket.quietMs + bucket.noisyMs + bucket.unknownMs !== bucketWidthMs) {
    return `quiet+noisy+unknown ${bucket.quietMs + bucket.noisyMs + bucket.unknownMs} ≠ 桶宽 ${bucketWidthMs}`;
  }
  if (bucket.classifiedMs > bucket.validInferenceMs) return `classifiedMs > validInferenceMs`;
  if (bucket.validInferenceMs > bucketWidthMs) return `validInferenceMs > 桶宽`;
  return null;
}
