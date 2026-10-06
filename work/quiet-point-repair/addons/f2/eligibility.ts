/**
 * F2 资格 + 分组 + 统计（纯逻辑，无 IO；可被隔离 fixture 直接验算）。
 *
 * 口径（Sol §1A ①②③）：
 *  · 只有**真实提交且服务端已 ACK** 的最新 `scoreRevision` 才触发；fixture/demo/回放/unknown 来源**排除**；
 *  · processing 空/unknown ⇒ `blocked_unknown_processing`（不能用 preproc-v2 或 flags=[] 替代）；
 *  · 一条 session 一个样本；分母 `validInferenceMs`；暴露 = ΣcategoryMs[c] / ΣvalidInferenceMs；
 *  · 按 configKey（四项版本）+ modelHash + processingKey 分组，**禁止跨组池化**凑 N；
 *  · 每 pair 有效 N ≥ 10，不足/零方差 ⇒ `r=null` 且给出封闭枚举 reason（绝不 0/NaN/Inf）。
 */

import { CATEGORY_IDS, ELIGIBILITY, type CategoryId, type StudySessionView } from '../../shared/study-model.js';
import { configurationKeyOf, parseProcessingProfile, sessionEligibility } from '../../server/insights.js';
import { pearsonPair, MIN_PAIRS, type PairReason, type ScoreDimension } from './pearson.js';

export const ASSOCIATION_SCHEMA_VERSION = 'category-pearson-v1';

/** 客户端白名单 passport（**没有**备注 / 原始特征 / 明文 key）。 */
export interface Passport {
  sessionId: string;
  scoreRevision: number;
  provenance: string;
  scoreAckObserved: boolean;
}

export interface PairResult {
  category: CategoryId;
  score: ScoreDimension;
  method: 'pearson';
  unit: 'session';
  n: number;
  r: number | null;
  reason: PairReason;
}

export interface AssociationGroup {
  configKey: string;
  modelKey: string;
  processingKey: string;
  sessionN: number;
  pairs: PairResult[];
}

export interface AssociationReply {
  schemaVersion: typeof ASSOCIATION_SCHEMA_VERSION;
  computedAt: number;
  range: { from: number; to: number };
  acceptedSessionN: number;
  blockedProcessingN: number;
  groups: AssociationGroup[];
  exclusions: Record<string, number>;
}

/** 被接受的「一 session 一个样本」中间量。 */
export interface SessionPair {
  sessionId: string;
  configKey: string;
  modelKey: string;
  processingKey: string;
  exposure: Record<string, number>;
  focus: number | null;
  efficiency: number | null;
}

export interface SessionShape {
  sessionId: string;
  startTime: number;
  durationMs: number | null;
  status: string;
  scoreRevision: number;
  aggregateRevision: number;
  userFocusScore: number | null;
  userEfficiencyScore: number | null;
  quietDuration: number | null;
  noisyDuration: number | null;
  interruptionCount: number | null;
  coverageRatio: number | null;
  sampleCount: number | null;
  sampleClippedCount: number | null;
  qualityFlags: string;
  expectedBucketCount: number | null;
  modelHash: string;
  runtimeVersion: string;
  preprocessVersion: string;
  mapVersion: string;
  decisionVersion: string;
  processing: string;
}

export interface BucketShape {
  bucketIndex: number;
  startOffsetMs: number;
  endOffsetMs: number;
  quietMs: number;
  noisyMs: number;
  unknownMs: number;
  validInferenceMs: number;
  classifiedMs: number;
  categoryUnknownMs: number;
  categoryMs: string;
  modelHash: string;
  runtimeVersion: string;
  preprocessVersion: string;
  mapVersion: string;
  decisionVersion: string;
}

function parseFlags(raw: string): string[] {
  if (raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === 'string') : [];
  } catch {
    // 损坏的 flags 不是「无 flags」：给一个不会被 ANOMALY_FLAGS 命中的显式标记，避免静默放行。
    return ['flags_unparsable'];
  }
}

/** 白名单解析 `categoryMs`：只接受 12 个固定键的非负有限数，未知键一律拒绝（不静默丢弃）。 */
export function parseCategoryMs(raw: string): Record<string, number> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const out: Record<string, number> = {};
  for (const key of Object.keys(parsed as Record<string, unknown>)) {
    if (!(CATEGORY_IDS as readonly string[]).includes(key)) return null;
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    out[key] = value;
  }
  for (const id of CATEGORY_IDS) out[id] = out[id] ?? 0;
  return out;
}

export interface GeometryResult {
  ok: boolean;
  reason: string | null;
  missingBucketCount: number;
  validInferenceMs: number;
  categoryTotals: Record<string, number> | null;
}

/**
 * 逐桶几何 + 版本一致性校验，然后按 session 聚合 `V=ΣvalidInferenceMs`、`C[c]=ΣcategoryMs[c]`。
 * 明确**不**用 `acousticEventDistribution` 的百分比（其分母是已分类时长），也不把 categoryUnknown 当 quiet。
 */
export function geometryAndTotals(
  session: SessionShape,
  buckets: readonly BucketShape[],
): GeometryResult {
  const fail = (reason: string): GeometryResult => ({ ok: false, reason, missingBucketCount: 0, validInferenceMs: 0, categoryTotals: null });
  if (buckets.length === 0) return fail('no_buckets');
  const expected = session.expectedBucketCount ?? 0;
  if (expected <= 0) return fail('no_expected_count');
  if (session.durationMs === null || session.durationMs <= 0) return fail('no_duration');
  const indices: number[] = [];
  const totals: Record<string, number> = Object.fromEntries(CATEGORY_IDS.map((id) => [id, 0]));
  let validInferenceMs = 0;
  let prevEnd: number | null = null;
  for (const b of buckets) {
    if (
      b.modelHash !== session.modelHash
      || b.runtimeVersion !== session.runtimeVersion
      || b.preprocessVersion !== session.preprocessVersion
      || b.mapVersion !== session.mapVersion
      || b.decisionVersion !== session.decisionVersion
    ) {
      return fail('bucket_version_mismatch');
    }
    if (!Number.isFinite(b.startOffsetMs) || !Number.isFinite(b.endOffsetMs) || b.endOffsetMs <= b.startOffsetMs) {
      return fail('bucket_geometry');
    }
    if (prevEnd !== null && b.startOffsetMs !== prevEnd) return fail('bucket_not_contiguous');
    prevEnd = b.endOffsetMs;
    if (b.startOffsetMs !== b.bucketIndex * 5000) return fail('bucket_offset_grid');
    indices.push(b.bucketIndex);
    validInferenceMs += b.validInferenceMs;
    const cats = parseCategoryMs(b.categoryMs);
    if (cats === null) return fail('category_ms_contract');
    for (const id of CATEGORY_IDS) totals[id] += cats[id];
  }
  const unique = new Set(indices);
  if (unique.size !== indices.length) return fail('bucket_duplicate');
  if (indices[0] !== 0) return fail('bucket_not_from_zero');
  for (let i = 0; i < indices.length; i++) if (indices[i] !== i) return fail('bucket_hole');
  // 末桶必须是真实余数（严格小于整桶宽），否则说明桶被补足成 5 秒。
  const last = buckets[buckets.length - 1];
  const lastWidth = last.endOffsetMs - last.startOffsetMs;
  if (lastWidth <= 0 || lastWidth > 5000) return fail('tail_width');
  const covered = last.endOffsetMs;
  if (covered > session.durationMs) return fail('bucket_overrun');
  const missingBucketCount = Math.max(0, expected - unique.size);
  return { ok: true, reason: null, missingBucketCount, validInferenceMs, categoryTotals: totals };
}

/** 把只读 DB 行 + 逐桶聚合成「一 session 一个样本」；不合格时给出封闭枚举 reason。 */
export type AcceptOutcome =
  | { ok: true; pair: SessionPair }
  | { ok: false; reason: string };

export function acceptSession(
  session: SessionShape,
  buckets: readonly BucketShape[],
  passport: Passport | undefined,
): AcceptOutcome {
  if (passport === undefined) return { ok: false, reason: 'no_passport' };
  if (passport.provenance !== 'real' || passport.scoreAckObserved !== true) {
    return { ok: false, reason: 'provenance_or_ack' };
  }
  if (!Number.isInteger(passport.scoreRevision) || passport.scoreRevision !== session.scoreRevision) {
    return { ok: false, reason: 'revision_stale' };
  }
  const processing = parseProcessingProfile(session.processing);
  if (processing.evidence !== 'verified' || processing.profileKey === null) {
    return { ok: false, reason: 'blocked_unknown_processing' };
  }
  const geometry = geometryAndTotals(session, buckets);
  if (!geometry.ok || geometry.categoryTotals === null) return { ok: false, reason: 'geometry' };
  // 既有资格函数要求 `StudySessionView.duration` 是**秒**；这里显式换算，不把 DB 行强转成 View。
  const view: StudySessionView = {
    sessionId: session.sessionId,
    roomId: '',
    startTime: session.startTime,
    endTime: null,
    duration: session.durationMs === null ? null : session.durationMs / 1000,
    status: session.status as StudySessionView['status'],
    endReason: null,
    timezone: 'Asia/Shanghai',
    averageDb: null,
    maxDb: null,
    dominantNoiseEvent: null,
    acousticEventDistribution: null,
    interruptionCount: session.interruptionCount,
    quietDuration: session.quietDuration,
    noisyDuration: session.noisyDuration,
    userFocusScore: session.userFocusScore,
    userEfficiencyScore: session.userEfficiencyScore,
    optionalNote: null,
    expectedBucketCount: session.expectedBucketCount,
    aggregateRevision: session.aggregateRevision,
    scoreRevision: session.scoreRevision,
    createdAt: session.startTime,
    updatedAt: session.startTime,
    validInferenceMs: geometry.validInferenceMs,
    classifiedMs: null,
    unknownMs: null,
    categoryUnknownMs: null,
    coverageRatio: session.coverageRatio,
    sampleCount: session.sampleCount,
    sampleClippedCount: session.sampleClippedCount,
    qualityFlags: parseFlags(session.qualityFlags),
    modelHash: session.modelHash,
    runtimeVersion: session.runtimeVersion,
    preprocessVersion: session.preprocessVersion,
    mapVersion: session.mapVersion,
    decisionVersion: session.decisionVersion,
    missingBucketCount: geometry.missingBucketCount,
  };
  const eligibility = sessionEligibility(view);
  if (!eligibility.eligible) return { ok: false, reason: `quality:${eligibility.reason ?? 'unknown'}` };
  if (geometry.validInferenceMs <= 0) return { ok: false, reason: 'no_valid_inference' };
  const exposure: Record<string, number> = {};
  for (const id of CATEGORY_IDS) exposure[id] = geometry.categoryTotals[id] / geometry.validInferenceMs;
  return {
    ok: true,
    pair: {
      sessionId: session.sessionId,
      configKey: configurationKeyOf(view),
      modelKey: session.modelHash,
      processingKey: processing.profileKey,
      exposure,
      focus: session.userFocusScore,
      efficiency: session.userEfficiencyScore,
    },
  };
}

/**
 * 组内分隔符**必须**与 `configurationKeyOf` 的 `|` 不同：`configKey` 本身含 `|`，
 * 若用 `|` 拼接再 `split('|')`，解构会错位（本项目实测过这个真 bug）。
 */
const GROUP_SEPARATOR = '\u0000';

/** 同一个 (configKey|modelKey|processingKey) 才允许一起算；不同组各自成组，绝不池化。 */
export function groupKeyOf(pair: SessionPair): string {
  return [pair.configKey, pair.modelKey, pair.processingKey].join(GROUP_SEPARATOR);
}

/** 一 session 多桶仍然只产生**一对**；这里只做分组与逐 (category × score) 的 Pearson。 */
export function groupedCategoryPearson(pairs: readonly SessionPair[]): AssociationGroup[] {
  const byGroup = new Map<string, SessionPair[]>();
  for (const pair of pairs) {
    const key = groupKeyOf(pair);
    const list = byGroup.get(key);
    if (list === undefined) byGroup.set(key, [pair]);
    else list.push(pair);
  }
  const groups: AssociationGroup[] = [];
  for (const [key, list] of [...byGroup.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const [configKey, modelKey, processingKey] = key.split(GROUP_SEPARATOR);
    const resultPairs: PairResult[] = [];
    for (const category of CATEGORY_IDS) {
      for (const score of ['focus', 'efficiency'] as const) {
        const xs: number[] = [];
        const ys: number[] = [];
        for (const p of list) {
          const y = score === 'focus' ? p.focus : p.efficiency;
          if (y === null) continue;
          xs.push(p.exposure[category] ?? 0);
          ys.push(y);
        }
        const numbers = pearsonPair(xs, ys);
        resultPairs.push({
          category: category as CategoryId,
          score,
          method: 'pearson',
          unit: 'session',
          n: numbers.n,
          r: numbers.r,
          reason: numbers.reason,
        });
      }
    }
    groups.push({ configKey, modelKey, processingKey, sessionN: list.length, pairs: resultPairs });
  }
  return groups;
}

export { MIN_PAIRS, ELIGIBILITY };
