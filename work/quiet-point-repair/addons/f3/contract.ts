/**
 * F3（简化版房间安静指数列表）契约与**纯**计算。
 *
 * 冻结口径（Sol §1 D ②③）：
 *  · `quiet-known-v1 = 100 × quietMs / (quietMs + noisyMs)`，只在「状态已知覆盖 ≥80%、
 *    AI 有效覆盖 ≥80%、至少 30 s 真实连续聚合」时才有值；unknown **不进入**分子/分母，但必须随覆盖展示；
 *  · 当前正式桶 `unknownMs = 桶宽` ⇒ 所有当前报告都返回 null（这**正是可信缺测结果**）；
 *    不得用 `1−noisy`、负 dBFS 或低 conversation 给它补 100 分；
 *  · `fresh = age ≤ 45 s`，`45–300 s = stale`，`>300 s 或缺证 = unknown`（值置 null）；
 *    未来时刻/时钟回拨**不钳成 0 装 fresh**，返回 `unknown/clock_anomaly`。
 */

import { z } from 'zod';
import { rooms, type RoomId } from '../../shared/model.js';

export const ROOM_REPORT_SCHEMA_VERSION = 'room-index-report-v1';
export const QUIET_INDEX_VERSION = 'quiet-known-v1';
export const ROOM_VIEW_SCHEMA_VERSION = 'room-view-v1';

export const FRESH_MAX_AGE_S = 45;
export const STALE_MAX_AGE_S = 300;
export const MIN_SPAN_MS = 30_000;
export const MIN_KNOWN_COVERAGE = 0.8;
export const MIN_AI_COVERAGE = 0.8;
/** 窗口 = 同一真实 session 内最近 6 个已封存且旧服务 ACK 的 5 s 桶。 */
export const WINDOW_BUCKETS = 6;
/** body ≤8KiB（3002 独立设定，不改旧 64kb）。 */
export const ROOM_REPORT_MAX_BYTES = 8 * 1024;

export const roomIdSchema = z.enum(['study-201', 'discussion-302', 'reading-101']);

const nonNegInt = z.number().int().finite().min(0);
const versionText = z.string().min(1).max(64);

export const roomAggregateSchema = z
  .object({
    spanMs: nonNegInt,
    quietMs: nonNegInt,
    noisyMs: nonNegInt,
    unknownMs: nonNegInt,
    validInferenceMs: nonNegInt,
  })
  .strict();
export type RoomAggregate = z.infer<typeof roomAggregateSchema>;

export const roomReportSchema = z
  .object({
    schemaVersion: z.literal(ROOM_REPORT_SCHEMA_VERSION),
    reportId: z.string().uuid(),
    roomId: roomIdSchema,
    terminalId: z.string().uuid(),
    terminalSeq: z.number().int().finite().min(0),
    sessionId: z.string().uuid(),
    generation: z.number().int().finite().min(0),
    firstBucket: z.number().int().finite().min(0),
    lastBucket: z.number().int().finite().min(0),
    indexVersion: z.literal(QUIET_INDEX_VERSION),
    configKey: versionText,
    processingKey: versionText.nullable(),
    provenance: z.enum(['real', 'measurement', 'fixture', 'unknown']),
    passport: z
      .object({
        sessionId: z.string().uuid(),
        kind: z.literal('real'),
        explicitCaptureObserved: z.boolean(),
      })
      .strict(),
    aggregate: roomAggregateSchema,
  })
  .strict();
export type RoomReport = z.infer<typeof roomReportSchema>;

export type RoomStatus = 'fresh' | 'stale' | 'unknown';

export interface RoomViewV1 {
  roomId: RoomId;
  indexVersion: typeof QUIET_INDEX_VERSION;
  quietIndex: number | null;
  status: RoomStatus;
  reason: string | null;
  serverReceivedAt: number | null;
  evidenceReceivedAt: number | null;
  evidenceEndAt: number | null;
  serverSeq: number | null;
  ageSeconds: number | null;
  terminalCount: number;
  configKey: string | null;
  processingKey: string | null;
}

/** 严格记账：三段必须精确等于 span（服务端复算出来的值必然满足；不满足即契约错误）。 */
export function strictAccountingPass(a: RoomAggregate): boolean {
  const values = [a.spanMs, a.quietMs, a.noisyMs, a.unknownMs, a.validInferenceMs];
  if (values.some((v) => !Number.isFinite(v) || v < 0)) return false;
  return a.spanMs === a.quietMs + a.noisyMs + a.unknownMs;
}

/** 冻结公式；缺证一律 null + 封闭枚举 reason，**绝不**补 0 / 补 100。 */
export function quietIndex(a: RoomAggregate): { value: number | null; reason: string | null } {
  if (!strictAccountingPass(a)) throw new Error('AGGREGATE_CONTRACT');
  const known = a.quietMs + a.noisyMs;
  if (a.spanMs < MIN_SPAN_MS) return { value: null, reason: 'short_window' };
  if (known <= 0 || known / a.spanMs < MIN_KNOWN_COVERAGE) return { value: null, reason: 'unknown_state_coverage' };
  if (a.validInferenceMs / a.spanMs < MIN_AI_COVERAGE) return { value: null, reason: 'low_ai_coverage' };
  return { value: (100 * a.quietMs) / known, reason: null };
}

/** 已接受并落盘的报告（服务端生成的时间/序号是权威）。 */
export interface StoredReport {
  reportId: string;
  roomId: RoomId;
  terminalId: string;
  terminalSeq: number;
  sessionId: string;
  generation: number;
  firstBucket: number;
  lastBucket: number;
  indexVersion: string;
  configKey: string;
  processingKey: string | null;
  aggregate: RoomAggregate;
  quietIndex: number | null;
  quietReason: string | null;
  serverSeq: number;
  serverReceivedAt: number;
  evidenceReceivedAt: number | null;
  evidenceEndAt: number | null;
  bodyHash: string;
}

export interface RoomAggregateInput {
  roomId: RoomId;
  reports: StoredReport[];
  terminalCount: number;
  now: number;
}

function ageStatus(evidenceEndAt: number | null, now: number): { status: RoomStatus; reason: string | null; ageSeconds: number | null } {
  if (evidenceEndAt === null) return { status: 'unknown', reason: 'no_evidence_time', ageSeconds: null };
  const age = (now - evidenceEndAt) / 1000;
  if (!Number.isFinite(age)) return { status: 'unknown', reason: 'clock_anomaly', ageSeconds: null };
  // 未来时刻/时钟回拨：不钳成 0 装 fresh。
  if (age < 0) return { status: 'unknown', reason: 'clock_anomaly', ageSeconds: age };
  if (age <= FRESH_MAX_AGE_S) return { status: 'fresh', reason: null, ageSeconds: age };
  if (age <= STALE_MAX_AGE_S) return { status: 'stale', reason: 'aging', ageSeconds: age };
  return { status: 'unknown', reason: 'expired', ageSeconds: age };
}

/**
 * 房间视图：只把**fresh 且同一完整 configKey/processingKey** 的报告放在一起，按 knownMs 加权。
 * 出现多个可比组 ⇒ 不生成单一房间指数（`unknown/mixed_config`），终端数仍照实报告。
 */
export function viewForRoom(input: RoomAggregateInput): RoomViewV1 {
  const { roomId, reports, terminalCount, now } = input;
  const base: RoomViewV1 = {
    roomId,
    indexVersion: QUIET_INDEX_VERSION,
    quietIndex: null,
    status: 'unknown',
    reason: null,
    serverReceivedAt: null,
    evidenceReceivedAt: null,
    evidenceEndAt: null,
    serverSeq: null,
    ageSeconds: null,
    terminalCount,
    configKey: null,
    processingKey: null,
  };
  if (reports.length === 0) return { ...base, reason: 'no_report' };

  // 每个终端的「最新」报告（serverSeq 最大者）；乱序不覆盖新窗口由 store 保证，这里只挑权威记录。
  const newestByTerminal = new Map<string, StoredReport>();
  for (const r of reports) {
    const prev = newestByTerminal.get(r.terminalId);
    if (prev === undefined || r.serverSeq > prev.serverSeq) newestByTerminal.set(r.terminalId, r);
  }
  const terminals = [...newestByTerminal.values()];
  const labelled = terminals.map((r) => ({ report: r, ...ageStatus(r.evidenceEndAt, now) }));
  const fresh = labelled.filter((l) => l.status === 'fresh');

  // 展示用的时间戳/序号取最新证据（含 stale：保留旧时点用于解释）。
  const newest = [...terminals].sort((a, b) => b.serverSeq - a.serverSeq)[0];
  const shown = ageStatus(newest.evidenceEndAt, now);
  const common = {
    ...base,
    serverReceivedAt: newest.serverReceivedAt,
    evidenceReceivedAt: newest.evidenceReceivedAt,
    evidenceEndAt: newest.evidenceEndAt,
    serverSeq: newest.serverSeq,
    ageSeconds: shown.ageSeconds,
    configKey: newest.configKey,
    processingKey: newest.processingKey,
    terminalCount,
  };

  if (fresh.length === 0) {
    if (labelled.some((l) => l.status === 'stale')) {
      return { ...common, status: 'stale', reason: 'aging', quietIndex: newest.quietIndex, configKey: newest.configKey, processingKey: newest.processingKey };
    }
    const why = labelled.find((l) => l.reason !== null)?.reason ?? 'no_report';
    return { ...common, status: 'unknown', reason: why };
  }

  const groups = new Map<string, { reports: StoredReport[] }>();
  for (const l of fresh) {
    // 分隔符与 configKey 内部的 `|` 不同：避免 (config, processing) 的不同切分拼出同一个键。
    const key = `${l.report.configKey}\u0000${l.report.processingKey ?? ''}`;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, { reports: [l.report] });
    else bucket.reports.push(l.report);
  }
  if (groups.size > 1) {
    return { ...common, status: 'unknown', reason: 'mixed_config', terminalCount };
  }
  const only = [...groups.values()][0];
  // 只有**报告级已经取得有效指数**的记录才参与房间加权（"有可比有效指数才排序"）；
  // 那条 null 报告的静态原因照实回显，绝不补 0 分。
  const usable = only.reports.filter((r) => r.quietIndex !== null);
  const first = only.reports[0];
  const head: RoomViewV1 = {
    ...common,
    status: 'fresh',
    reason: null,
    configKey: first.configKey,
    processingKey: first.processingKey,
  };
  if (usable.length === 0) {
    const why = only.reports.find((r) => r.quietReason !== null)?.quietReason ?? 'unknown_state_coverage';
    return { ...head, quietIndex: null, reason: why };
  }
  let quietMs = 0;
  let knownMs = 0;
  for (const r of usable) {
    quietMs += r.aggregate.quietMs;
    knownMs += r.aggregate.quietMs + r.aggregate.noisyMs;
  }
  if (knownMs <= 0) return { ...head, quietIndex: null, reason: 'unknown_state_coverage' };
  return { ...head, quietIndex: (100 * quietMs) / knownMs };
}

/** 排序：可比 fresh（按指数降序）→ stale → unknown → 稳定 roomId。 */
export function compareFreshSameConfigThenValueThenStableRoomId(a: RoomViewV1, b: RoomViewV1): number {
  const rank = (v: RoomViewV1): number => (v.status === 'fresh' && v.quietIndex !== null ? 0 : v.status === 'stale' ? 1 : 2);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0 && a.quietIndex !== b.quietIndex) return (b.quietIndex ?? 0) - (a.quietIndex ?? 0);
  return a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0;
}

export function listRoomIds(): readonly RoomId[] {
  return rooms.map((r) => r.id);
}
