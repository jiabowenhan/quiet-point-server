// 阶段三契约（CODEX_DECISION_AI.md §5 数据模型与接口 / §6 关联分析）
// 本文件是学习会话与声学摘要 DTO 的唯一来源：所有写接口一律 strict，
// 未知字段（audio/pcm/base64/embedding/spectrogram…）直接 400。
import { z } from 'zod';
/**
 * 12 个固定类别与映射版本：**唯一权威在 `shared/acoustic-categories.ts`**（无 IO、无 CSV 依赖）。
 *
 * 历史背景：本文件曾因 `shared/acoustic-map.ts` 在 `tsc + node` 路径上于加载期抛
 * `ACOUSTIC_MAP_BAD_HEADER: ["__ACOUSTIC_MAP_CSV__"]` 而自带一份本地副本。现在 CSV 由
 * `scripts/generate-acoustic-map.mjs` 在构建前注入（Sol 裁决 §2），且类别常量已抽出到
 * 不依赖 CSV 的模块，因此这里改为 import + re-export：对外 API 不变，两处不再可能静默漂移。
 */
import { CATEGORY_IDS, MAP_VERSION, type CategoryGate, type CategoryId } from './acoustic-categories.js';

export { CATEGORY_IDS, MAP_VERSION, type CategoryGate, type CategoryId };

// ---------------------------------------------------------------------------
// 契约常量
// ---------------------------------------------------------------------------

/** §5.3：迁移账本版本号（在既有 PRAGMA user_version=2 之上递增，绝不回退）。 */
export const STUDY_MIGRATION_VERSION = 2026100301 as const;
export const STUDY_MIGRATION_NAME = 'study_sessions+acoustic_summaries' as const;
/** 现有 store.ts 的 PRAGMA user_version；学习迁移必须严格晚于它。 */
export const BASE_USER_VERSION = 2 as const;

/** §5：一个桶固定 5 秒；尾桶由 end 裁剪。 */
export const BUCKET_WIDTH_MS = 5_000 as const;
/** §5：单批 1–12 条。 */
export const BATCH_MIN = 1 as const;
export const BATCH_MAX = 12 as const;
/** §5：单批总字节 ≤64kb（与既有 express.json 限制一致）。 */
export const BATCH_MAX_BYTES = 64 * 1024;
/** §5：durationMs 0..43200000（12h）。 */
export const MAX_DURATION_MS = 43_200_000 as const;
/** §5：可选备注最长 500 字符。 */
export const NOTE_MAX = 500 as const;
/** §5：学习会话列表范围 ≤366 天。 */
export const MAX_RANGE_DAYS = 366 as const;
export const LIST_LIMIT_DEFAULT = 20 as const;
export const LIST_LIMIT_MAX = 50 as const;
/** §5：episodes ≤12、top3 ≤3。 */
export const EPISODES_MAX = 12 as const;
export const TOP3_MAX = 3 as const;
/** §6.161：入选门槛。 */
export const ELIGIBILITY = {
  minDurationMs: 300_000,
  minCoverageRatio: 0.8,
  /** samples 有效数 ≥ floor(duration/5)×0.80 */
  samplePerBucket: 1,
  minSampleFraction: 0.8,
  maxClippedRatio: 0.01,
} as const;
/** §6.163：样本量三档阈值。 */
export const TIER_PRELIMINARY_MIN = 5 as const;
export const TIER_STATISTICAL_MIN = 11 as const;
/** §6.169：分组阈值（预注册）。 */
export const GROUP_THRESHOLDS = {
  quietHigh: 0.7,
  quietLow: 0.4,
  noisyHigh: 0.3,
  noisyLow: 0.1,
} as const;
/** §6.169：建议触发门槛。 */
export const SUGGESTION_GATES = {
  minPerGroup: 3,
  minDistinctDays: 3,
  minTotalN: TIER_STATISTICAL_MIN,
  minAbsRho: 0.4,
  minMedianDelta: 1,
} as const;

export const STATUS_VALUES = ['open', 'ended', 'partial'] as const;
export const END_REASON_VALUES = ['user', 'background', 'error'] as const;
export const AI_STATUS_VALUES = ['ready', 'reduced', 'unavailable'] as const;
export const EPISODE_KIND_VALUES = ['confirmed', 'leftCensored'] as const;

/**
 * 本轮白名单版本。§5：创建接口「只接收本轮白名单版本」。
 * mapVersion 已与 shared/acoustic-map.ts 对齐；其余三项待阶段一/二常量落地时对齐（报告已记为未核实项）。
 */
/**
 * 版本白名单（唯一权威）。
 *
 * runtimeVersion 依据 **真机实读**（2026-10-03；测试设备 serial 已按 Sol §4 脱敏，
 * 见 `shared/acoustic-build-info.ts` 的 `TEST_DEVICE_SERIAL_REDACTED`，Sol §5.1 要求实读后再锁定）：
 *   `TensorFlowLite.runtimeVersion()` → `2.16.1`（记为 `tflite-2.16.1`）
 *   `TensorFlowLite.version()`       → `3`（schema 版本，**不得**当 runtime 上报）
 * 旧值 `tflite-2.16` 保留以兼容既有测试与历史重试记录，新会话不得冒填。
 *
 * preprocessVersion：`preproc-v1`（历史兼容）、`preproc-diag-linear-v1`（当前诊断线性路径）、
 * `preproc-v2`（Sol §5.2 裁定的正式抗混叠 FIR 生产路径）。
 * mapVersion 与 `shared/acoustic-map.ts` 对齐；decisionVersion 未变保持 decision-v1。
 */
export const ACCEPTED_VERSIONS = {
  mapVersion: [MAP_VERSION],
  preprocessVersion: ['preproc-v1', 'preproc-diag-linear-v1', 'preproc-v2'],
  runtimeVersion: ['tflite-2.16', 'tflite-2.16.1'],
  decisionVersion: ['decision-v1'],
} as const;
export const MODEL_HASH_PATTERN = /^[0-9a-f]{64}$/;
export const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const TIMEZONE_MAX = 64;

// ---------------------------------------------------------------------------
// 错误类型（§5 统一错误 {error:{code,message,retryable}}）
// ---------------------------------------------------------------------------

export type StudyErrorCode =
  | 'VALIDATION_FAILED'
  | 'STUDY_KEY_REQUIRED'
  | 'STUDY_KEY_INVALID'
  | 'STUDY_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'REVISION_CONFLICT'
  | 'SESSION_ALREADY_BOUND'
  | 'SESSION_ENDED'
  | 'SOURCE_NOT_MICROPHONE'
  | 'PAYLOAD_TOO_LARGE'
  | 'DB_BUSY';

const RETRYABLE: Partial<Record<StudyErrorCode, boolean>> = { DB_BUSY: true };

export class StudyError extends Error {
  readonly code: StudyErrorCode;
  readonly retryable: boolean;
  constructor(code: StudyErrorCode, message: string) {
    super(message);
    this.name = 'StudyError';
    this.code = code;
    this.retryable = RETRYABLE[code] ?? false;
  }
}

export const STATUS_BY_CODE: Record<StudyErrorCode, number> = {
  VALIDATION_FAILED: 400,
  STUDY_KEY_REQUIRED: 401,
  STUDY_KEY_INVALID: 401,
  STUDY_NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  REVISION_CONFLICT: 409,
  SESSION_ALREADY_BOUND: 409,
  SESSION_ENDED: 409,
  SOURCE_NOT_MICROPHONE: 409,
  PAYLOAD_TOO_LARGE: 413,
  DB_BUSY: 503,
};

// ---------------------------------------------------------------------------
// 基础片段
// ---------------------------------------------------------------------------

const intMs = z.number().int().finite();
const nonNegInt = z.number().int().finite().min(0);
/** 12 类固定键、非负整数；各项和 = classifiedMs（和值在 store 层校验）。 */
const categoryMsSchema = z
  .object(Object.fromEntries(CATEGORY_IDS.map((id) => [id, nonNegInt])) as Record<CategoryId, z.ZodNumber>)
  .strict();
const categoryIdSchema = z.enum(CATEGORY_IDS as unknown as [string, ...string[]]);
const versionSchema = z.string().regex(VERSION_PATTERN);

const score15 = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);

// ---------------------------------------------------------------------------
// §5 七个接口的输入 DTO
// ---------------------------------------------------------------------------

export const studySessionCreateSchema = z
  .object({
    sessionId: z.string().uuid(),
    timezone: z.string().min(1).max(TIMEZONE_MAX),
    modelHash: z.string().regex(MODEL_HASH_PATTERN),
    runtimeVersion: versionSchema,
    preprocessVersion: versionSchema,
    mapVersion: versionSchema,
    decisionVersion: versionSchema,
  })
  .strict();
export type StudySessionCreate = z.infer<typeof studySessionCreateSchema>;

export const bucketSchema = z
  .object({
    id: z.string().uuid(),
    sessionId: z.string().uuid(),
    bucketIndex: nonNegInt,
    startOffsetMs: nonNegInt,
    endOffsetMs: nonNegInt,
    quietMs: nonNegInt,
    noisyMs: nonNegInt,
    unknownMs: nonNegInt,
    validInferenceMs: nonNegInt,
    classifiedMs: nonNegInt,
    categoryMs: categoryMsSchema,
    categoryUnknownMs: nonNegInt,
    top3: z
      .array(z.object({ categoryId: categoryIdSchema, score: z.number().finite().min(0).max(1) }).strict())
      .max(TOP3_MAX),
    episodes: z
      .array(
        z
          .object({
            episodeId: z.string().uuid(),
            startOffsetMs: nonNegInt,
            kind: z.enum(EPISODE_KIND_VALUES),
          })
          .strict(),
      )
      .max(EPISODES_MAX),
    inferenceCount: nonNegInt,
    expectedWindowCount: nonNegInt,
    droppedWindowCount: nonNegInt,
    clippedMs: nonNegInt,
    resampleClampCount: nonNegInt,
    aiStatus: z.enum(AI_STATUS_VALUES),
    reason: z.string().max(60).nullable(),
    modelHash: z.string().regex(MODEL_HASH_PATTERN),
    runtimeVersion: versionSchema,
    preprocessVersion: versionSchema,
    mapVersion: versionSchema,
    decisionVersion: versionSchema,
  })
  .strict();
export type BucketDTO = z.infer<typeof bucketSchema>;

export const batchSchema = z
  .object({ summaries: z.array(bucketSchema).min(BATCH_MIN).max(BATCH_MAX) })
  .strict();
export type BatchDTO = z.infer<typeof batchSchema>;

export const endSchema = z
  .object({
    requestId: z.string().uuid(),
    durationMs: z.number().int().finite().min(0).max(MAX_DURATION_MS),
    endReason: z.enum(END_REASON_VALUES),
    expectedBucketCount: nonNegInt,
  })
  .strict();
export type EndDTO = z.infer<typeof endSchema>;

export const scoresSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedRevision: nonNegInt,
    userFocusScore: score15.nullable(),
    userEfficiencyScore: score15.nullable(),
    optionalNote: z.string().max(NOTE_MAX).nullable(),
  })
  .strict();
export type ScoresDTO = z.infer<typeof scoresSchema>;

export const listQuerySchema = z
  .object({
    from: z.coerce.number().int().finite().positive().optional(),
    to: z.coerce.number().int().finite().positive().optional(),
    limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).optional(),
    cursor: z.string().max(200).optional(),
  })
  .strict();
export type ListQuery = z.infer<typeof listQuerySchema>;

export const insightsQuerySchema = z
  .object({
    timezone: z.string().min(1).max(TIMEZONE_MAX).optional(),
    nowDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    range: z.enum(['today', 'week']).optional(),
  })
  .strict();
export type InsightsQuery = z.infer<typeof insightsQuerySchema>;

// ---------------------------------------------------------------------------
// 服务端输出类型
// ---------------------------------------------------------------------------

export interface StudyAggregate {
  interruptionCount: number | null;
  quietDuration: number | null;
  noisyDuration: number | null;
  validInferenceMs: number | null;
  classifiedMs: number | null;
  unknownMs: number | null;
  categoryUnknownMs: number | null;
  coverageRatio: number | null;
  averageDb: number | null;
  maxDb: number | null;
  dominantNoiseEvent: string | null;
  acousticEventDistribution: Record<string, number> | null;
  sampleCount: number | null;
  sampleClippedCount: number | null;
  missingBucketMs: number | null;
  qualityFlags: string[];
}

export interface StudySessionView {
  sessionId: string;
  roomId: string;
  startTime: number;
  endTime: number | null;
  duration: number | null;
  status: (typeof STATUS_VALUES)[number];
  endReason: (typeof END_REASON_VALUES)[number] | null;
  timezone: string;
  averageDb: number | null;
  maxDb: number | null;
  dominantNoiseEvent: string | null;
  acousticEventDistribution: Record<string, number> | null;
  interruptionCount: number | null;
  quietDuration: number | null;
  noisyDuration: number | null;
  userFocusScore: number | null;
  userEfficiencyScore: number | null;
  optionalNote: string | null;
  expectedBucketCount: number | null;
  aggregateRevision: number;
  scoreRevision: number;
  createdAt: number;
  updatedAt: number;
  validInferenceMs: number | null;
  classifiedMs: number | null;
  unknownMs: number | null;
  categoryUnknownMs: number | null;
  coverageRatio: number | null;
  sampleCount: number | null;
  sampleClippedCount: number | null;
  qualityFlags: string[];
  modelHash: string;
  runtimeVersion: string;
  preprocessVersion: string;
  mapVersion: string;
  decisionVersion: string;
  /** GET 单会话附加：质量与缺测。 */
  missingBucketCount?: number;
  summaryCount?: number;
}

/** 统一的响应外壳类型（供路由与测试共用）。 */
export interface ApiErrorBody {
  error: { code: StudyErrorCode; message: string; retryable: boolean };
}
