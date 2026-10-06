// 阶段三：学习会话数据模型 + 迁移 + 聚合（CODEX_DECISION_AI.md §5）
// 设计约束：
//  · 学习表与既有 sessions/samples/actions 同库（QUIET_DATA_DIR/quiet.sqlite），
//    但**不改动 server/store.ts**（该文件属修复轨道冻结面），因此本模块自持一条
//    DatabaseSync 连接，只读既有三表、只写自己新增的两表。
//  · 迁移可重跑、保历史、失败即抛：账本表 schema_migrations + 结构核验，
//    第二次启动不新增行、不重建旧表。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  ACCEPTED_VERSIONS,
  BUCKET_WIDTH_MS,
  CATEGORY_IDS,
  ELIGIBILITY,
  STUDY_MIGRATION_NAME,
  STUDY_MIGRATION_VERSION,
  StudyError,
  type BucketDTO,
  type EndDTO,
  type ScoresDTO,
  type StudyAggregate,
  type StudySessionCreate,
  type StudySessionView,
} from '../shared/study-model.js';
import {
  allocateIntersection,
  assertFiniteNumbers,
  buildAnalysis,
  buildTodayBlock,
  buildWeekBlock,
  resolveZone,
  zoneDayStart,
  zoneWeekStart,
  type AnalysisRow,
  type InsightsPayload,
  type StudyPoint,
} from './insights.js';

type Row = Record<string, any>;

const dataDirectory = process.env.QUIET_DATA_DIR ?? 'data';
mkdirSync(dataDirectory, { recursive: true });
/** 实际落盘绝对路径（§9：启动日志/报告必须记录 resolve 后路径）。 */
export const DATA_DIRECTORY = resolve(dataDirectory);
export const DB_PATH = join(DATA_DIRECTORY, 'quiet.sqlite');

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode=WAL;');
db.exec('PRAGMA foreign_keys=ON;');
db.exec('PRAGMA busy_timeout=5000;');

// ---------------------------------------------------------------------------
// 迁移（§5.3/5.4）：账本 + 结构核验，可重跑、保历史、失败即抛
// ---------------------------------------------------------------------------

const DDL_LEDGER = `CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,appliedAt INTEGER NOT NULL);`;

const DDL_TABLES = `CREATE TABLE IF NOT EXISTS study_sessions(
 sessionId TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id),
 ownerHash TEXT NOT NULL,
 roomId TEXT NOT NULL,
 startTime INTEGER NOT NULL,
 endTime INTEGER,
 durationMs INTEGER,
 timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
 status TEXT NOT NULL CHECK(status IN ('open','ended','partial')),
 endReason TEXT CHECK(endReason IS NULL OR endReason IN ('user','background','error')),
 expectedBucketCount INTEGER,
 aggregateRevision INTEGER NOT NULL DEFAULT 0,
 scoreRevision INTEGER NOT NULL DEFAULT 0,
 endRequestId TEXT,
 endIntentHash TEXT,
 scoreRequestId TEXT,
 scoreRequestHash TEXT,
 averageDb REAL,
 maxDb REAL,
 dominantNoiseEvent TEXT,
 acousticEventDistribution TEXT,
 interruptionCount INTEGER,
 quietDuration REAL,
 noisyDuration REAL,
 userFocusScore INTEGER CHECK(userFocusScore IS NULL OR (userFocusScore BETWEEN 1 AND 5)),
 userEfficiencyScore INTEGER CHECK(userEfficiencyScore IS NULL OR (userEfficiencyScore BETWEEN 1 AND 5)),
 optionalNote TEXT CHECK(optionalNote IS NULL OR length(optionalNote)<=500),
 createdAt INTEGER NOT NULL,
 updatedAt INTEGER NOT NULL,
 sampleCount INTEGER,
 sampleClippedCount INTEGER,
 validInferenceMs INTEGER,
 classifiedMs INTEGER,
 unknownMs INTEGER,
 categoryUnknownMs INTEGER,
 coverageRatio REAL,
 qualityFlags TEXT,
 modelHash TEXT NOT NULL,
 runtimeVersion TEXT NOT NULL,
 preprocessVersion TEXT NOT NULL,
 mapVersion TEXT NOT NULL,
 decisionVersion TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS acoustic_summaries(
 id TEXT PRIMARY KEY NOT NULL,
 sessionId TEXT NOT NULL REFERENCES study_sessions(sessionId),
 bucketIndex INTEGER NOT NULL CHECK(bucketIndex>=0),
 startOffsetMs INTEGER NOT NULL,
 endOffsetMs INTEGER NOT NULL,
 quietMs INTEGER NOT NULL,
 noisyMs INTEGER NOT NULL,
 unknownMs INTEGER NOT NULL,
 validInferenceMs INTEGER NOT NULL,
 classifiedMs INTEGER NOT NULL,
 categoryMs TEXT NOT NULL,
 categoryUnknownMs INTEGER NOT NULL,
 top3 TEXT NOT NULL,
 episodes TEXT NOT NULL,
 inferenceCount INTEGER NOT NULL,
 expectedWindowCount INTEGER NOT NULL,
 droppedWindowCount INTEGER NOT NULL,
 clippedMs INTEGER NOT NULL,
 resampleClampCount INTEGER NOT NULL,
 aiStatus TEXT NOT NULL CHECK(aiStatus IN ('ready','reduced','unavailable')),
 reason TEXT,
 modelHash TEXT NOT NULL,
 runtimeVersion TEXT NOT NULL,
 preprocessVersion TEXT NOT NULL,
 mapVersion TEXT NOT NULL,
 decisionVersion TEXT NOT NULL,
 receivedAt INTEGER NOT NULL,
 payloadHash TEXT NOT NULL,
 UNIQUE(sessionId,bucketIndex)
);
CREATE INDEX IF NOT EXISTS study_sessions_owner_time ON study_sessions(ownerHash,startTime DESC,sessionId DESC);
CREATE INDEX IF NOT EXISTS acoustic_summaries_session_bucket ON acoustic_summaries(sessionId,bucketIndex);`;

const DDL_CHECKSUM = createHash('sha256').update(DDL_TABLES).digest('hex');

const EXPECTED_COLUMNS = {
  schema_migrations: ['version', 'name', 'checksum', 'appliedAt'],
  study_sessions: [
    'sessionId', 'ownerHash', 'roomId', 'startTime', 'endTime', 'durationMs', 'timezone', 'status', 'endReason',
    'expectedBucketCount', 'aggregateRevision', 'scoreRevision', 'endRequestId', 'endIntentHash', 'scoreRequestId',
    'scoreRequestHash', 'averageDb', 'maxDb', 'dominantNoiseEvent', 'acousticEventDistribution', 'interruptionCount',
    'quietDuration', 'noisyDuration', 'userFocusScore', 'userEfficiencyScore', 'optionalNote', 'createdAt', 'updatedAt',
    'sampleCount', 'sampleClippedCount', 'validInferenceMs', 'classifiedMs', 'unknownMs', 'categoryUnknownMs',
    'coverageRatio', 'qualityFlags', 'modelHash', 'runtimeVersion', 'preprocessVersion', 'mapVersion', 'decisionVersion',
  ],
  acoustic_summaries: [
    'id', 'sessionId', 'bucketIndex', 'startOffsetMs', 'endOffsetMs', 'quietMs', 'noisyMs', 'unknownMs',
    'validInferenceMs', 'classifiedMs', 'categoryMs', 'categoryUnknownMs', 'top3', 'episodes', 'inferenceCount',
    'expectedWindowCount', 'droppedWindowCount', 'clippedMs', 'resampleClampCount', 'aiStatus', 'reason', 'modelHash',
    'runtimeVersion', 'preprocessVersion', 'mapVersion', 'decisionVersion', 'receivedAt', 'payloadHash',
  ],
} as const;

function tableColumns(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((r) => String(r.name));
}

function hasIndex(table: string, columns: string[], unique: boolean): boolean {
  for (const idx of db.prepare(`PRAGMA index_list(${table})`).all() as Row[]) {
    if (Boolean(Number(idx.unique)) !== unique) continue;
    const cols = (db.prepare(`PRAGMA index_info(${String(idx.name)})`).all() as Row[])
      .map((r) => String(r.name));
    if (cols.length === columns.length && cols.every((c, i) => c === columns[i])) return true;
  }
  return false;
}

function assertTable(table: string): void {
  const actual = tableColumns(table);
  const expected = EXPECTED_COLUMNS[table as keyof typeof EXPECTED_COLUMNS] as readonly string[];
  if (actual.length !== expected.length || !expected.every((c, i) => actual[i] === c)) {
    throw new Error(`学习表结构不一致：${table} 实际列 [${actual.join(',')}]，预期 [${expected.join(',')}]`);
  }
}

/** §5.4：IF NOT EXISTS 不能掩盖半成品——逐项核验列/索引/外键。 */
export function verifyStudyStructure(): { tables: string[]; indexes: string[]; foreignKeys: string[] } {
  assertTable('schema_migrations');
  assertTable('study_sessions');
  assertTable('acoustic_summaries');
  if (!hasIndex('acoustic_summaries', ['sessionId', 'bucketIndex'], true)) {
    throw new Error('学习表结构不一致：acoustic_summaries 缺少 UNIQUE(sessionId,bucketIndex)');
  }
  if (!hasIndex('study_sessions', ['ownerHash', 'startTime', 'sessionId'], false)) {
    throw new Error('学习表结构不一致：study_sessions 缺少 (ownerHash,startTime,sessionId) 索引');
  }
  const fks = (db.prepare('PRAGMA foreign_key_list(study_sessions)').all() as Row[])
    .map((r) => `${String(r.table)}.${String(r.to)}`);
  if (!fks.includes('sessions.id')) throw new Error('学习表结构不一致：study_sessions.sessionId 缺少 FK→sessions.id');
  const bucketFks = (db.prepare('PRAGMA foreign_key_list(acoustic_summaries)').all() as Row[])
    .map((r) => `${String(r.table)}.${String(r.to)}`);
  if (!bucketFks.includes('study_sessions.sessionId')) {
    throw new Error('学习表结构不一致：acoustic_summaries.sessionId 缺少 FK→study_sessions.sessionId');
  }
  return {
    tables: ['schema_migrations', 'study_sessions', 'acoustic_summaries'],
    indexes: ['study_sessions_owner_time', 'acoustic_summaries_session_bucket', 'sqlite_autoindex_acoustic_summaries_1'],
    foreignKeys: [...fks.map((f) => `study_sessions→${f}`), ...bucketFks.map((f) => `acoustic_summaries→${f}`)],
  };
}

export interface MigrationReport {
  applied: boolean;
  version: number;
  name: string;
  checksum: string;
  checksumMatches: boolean;
  baseUserVersion: number;
  structure: { tables: string[]; indexes: string[]; foreignKeys: string[] };
}

/** 幂等迁移：已应用同 checksum 则跳过；checksum 不符或结构不符立即抛。 */
export function migrateStudy(now = Date.now()): MigrationReport {
  const base = db.prepare('PRAGMA user_version').get() as Row;
  const baseUserVersion = Number(base.user_version ?? 0);
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get()) {
    throw new Error('基础库未初始化：缺少 sessions 表（请先由 server/store.ts 建库）');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(DDL_LEDGER);
    const existing = db.prepare('SELECT version,name,checksum,appliedAt FROM schema_migrations WHERE version=?')
      .get(STUDY_MIGRATION_VERSION) as Row | undefined;
    if (existing && String(existing.checksum) !== DDL_CHECKSUM) {
      throw new Error(`迁移 checksum 不一致：${STUDY_MIGRATION_VERSION} 已应用 ${String(existing.checksum).slice(0, 12)}…，本次 ${DDL_CHECKSUM.slice(0, 12)}…`);
    }
    if (!existing) {
      db.exec(DDL_TABLES);
      db.prepare('INSERT INTO schema_migrations(version,name,checksum,appliedAt) VALUES(?,?,?,?)')
        .run(STUDY_MIGRATION_VERSION, STUDY_MIGRATION_NAME, DDL_CHECKSUM, now);
    }
    const structure = verifyStudyStructure();
    db.exec('COMMIT');
    return {
      applied: !existing,
      version: STUDY_MIGRATION_VERSION,
      name: STUDY_MIGRATION_NAME,
      checksum: DDL_CHECKSUM,
      checksumMatches: true,
      baseUserVersion,
      structure,
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const migration = migrateStudy();

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 规范化 JSON（键排序、无空白）：payloadHash 的输入，禁止客户端定义幂等内容。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const entries = Object.entries(value as Row)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function parseJson<T>(text: unknown): T | null {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(String(text)) as T;
  } catch {
    return null;
  }
}

function toView(row: Row): StudySessionView {
  const distribution = parseJson<Record<string, number>>(row.acousticEventDistribution);
  const flags = parseJson<string[]>(row.qualityFlags) ?? [];
  return {
    sessionId: String(row.sessionId),
    roomId: String(row.roomId),
    startTime: Number(row.startTime),
    endTime: row.endTime === null ? null : Number(row.endTime),
    duration: row.durationMs === null ? null : Number(row.durationMs) / 1000,
    status: String(row.status) as StudySessionView['status'],
    endReason: row.endReason === null ? null : (String(row.endReason) as StudySessionView['endReason']),
    timezone: String(row.timezone),
    averageDb: row.averageDb === null ? null : Number(row.averageDb),
    maxDb: row.maxDb === null ? null : Number(row.maxDb),
    dominantNoiseEvent: row.dominantNoiseEvent === null ? null : String(row.dominantNoiseEvent),
    acousticEventDistribution: distribution,
    interruptionCount: row.interruptionCount === null ? null : Number(row.interruptionCount),
    quietDuration: row.quietDuration === null ? null : Number(row.quietDuration),
    noisyDuration: row.noisyDuration === null ? null : Number(row.noisyDuration),
    userFocusScore: row.userFocusScore === null ? null : Number(row.userFocusScore),
    userEfficiencyScore: row.userEfficiencyScore === null ? null : Number(row.userEfficiencyScore),
    optionalNote: row.optionalNote === null ? null : String(row.optionalNote),
    expectedBucketCount: row.expectedBucketCount === null ? null : Number(row.expectedBucketCount),
    aggregateRevision: Number(row.aggregateRevision),
    scoreRevision: Number(row.scoreRevision),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    validInferenceMs: row.validInferenceMs === null ? null : Number(row.validInferenceMs),
    classifiedMs: row.classifiedMs === null ? null : Number(row.classifiedMs),
    unknownMs: row.unknownMs === null ? null : Number(row.unknownMs),
    categoryUnknownMs: row.categoryUnknownMs === null ? null : Number(row.categoryUnknownMs),
    coverageRatio: row.coverageRatio === null ? null : Number(row.coverageRatio),
    sampleCount: row.sampleCount === null ? null : Number(row.sampleCount),
    sampleClippedCount: row.sampleClippedCount === null ? null : Number(row.sampleClippedCount),
    qualityFlags: flags,
    modelHash: String(row.modelHash),
    runtimeVersion: String(row.runtimeVersion),
    preprocessVersion: String(row.preprocessVersion),
    mapVersion: String(row.mapVersion),
    decisionVersion: String(row.decisionVersion),
  };
}

function sessionRow(sessionId: string, ownerHash?: string): Row | undefined {
  return ownerHash === undefined
    ? (db.prepare('SELECT * FROM study_sessions WHERE sessionId=?').get(sessionId) as Row | undefined)
    : (db.prepare('SELECT * FROM study_sessions WHERE sessionId=? AND ownerHash=?').get(sessionId, ownerHash) as Row | undefined);
}

function mustSession(sessionId: string, ownerHash: string, row?: Row): Row {
  const found = row ?? sessionRow(sessionId, ownerHash);
  // §5：他人记录一律 404，避免泄露存在性。
  if (!found) throw new StudyError('STUDY_NOT_FOUND', '学习会话不存在');
  return found;
}

// ---------------------------------------------------------------------------
// 1. 创建学习会话（POST /api/study-sessions）
// ---------------------------------------------------------------------------

export interface CreateResult {
  created: boolean;
  view: StudySessionView;
  startTime: number;
  serverNow: number;
}

export function createStudySession(input: StudySessionCreate, ownerHash: string, now = Date.now()): CreateResult {
  // §5：只接收本轮白名单版本（拒绝另起模型/映射版本，避免历史不可比）。
  for (const key of ['mapVersion', 'preprocessVersion', 'runtimeVersion', 'decisionVersion'] as const) {
    if (!(ACCEPTED_VERSIONS[key] as readonly string[]).includes(input[key])) {
      throw new StudyError('VALIDATION_FAILED', `${key}=${input[key]} 不在本轮白名单内`);
    }
  }
  const base = db.prepare('SELECT id,roomId,source,createdAt,closedAt FROM sessions WHERE id=?')
    .get(input.sessionId) as Row | undefined;
  if (!base) throw new StudyError('STUDY_NOT_FOUND', '采样会话不存在');
  if (String(base.source) !== 'microphone') throw new StudyError('SOURCE_NOT_MICROPHONE', '该采样会话不是麦克风来源');
  const existing = sessionRow(input.sessionId);
  if (existing) {
    if (String(existing.ownerHash) !== ownerHash) throw new StudyError('STUDY_NOT_FOUND', '学习会话不存在');
    const same =
      String(existing.timezone) === input.timezone &&
      String(existing.modelHash) === input.modelHash &&
      String(existing.runtimeVersion) === input.runtimeVersion &&
      String(existing.preprocessVersion) === input.preprocessVersion &&
      String(existing.mapVersion) === input.mapVersion &&
      String(existing.decisionVersion) === input.decisionVersion;
    if (!same) throw new StudyError('SESSION_ALREADY_BOUND', '该采样会话已绑定学习会话');
    return { created: false, view: toView(existing), startTime: Number(existing.startTime), serverNow: now };
  }
  if (base.closedAt !== null) throw new StudyError('SESSION_ENDED', '采样会话已关闭，无法开始学习段');
  // §5：绑定时 Date.now()，且 ≥ sessions.createdAt（时钟回拨时取会话创建时刻）。
  const startTime = Math.max(now, Number(base.createdAt));
  db.prepare(
    `INSERT INTO study_sessions(sessionId,ownerHash,roomId,startTime,endTime,durationMs,timezone,status,createdAt,updatedAt,
       aggregateRevision,scoreRevision,modelHash,runtimeVersion,preprocessVersion,mapVersion,decisionVersion,qualityFlags)
     VALUES(?,?,?,?,NULL,NULL,?,'open',?,?,0,0,?,?,?,?,?,'[]')`,
  ).run(
    input.sessionId, ownerHash, String(base.roomId), startTime, input.timezone, startTime, now,
    input.modelHash, input.runtimeVersion, input.preprocessVersion, input.mapVersion, input.decisionVersion,
  );
  return { created: true, view: toView(sessionRow(input.sessionId)!), startTime, serverNow: now };
}

// ---------------------------------------------------------------------------
// 聚合重算（§5 聚合段）
// ---------------------------------------------------------------------------

function sampleStats(sessionId: string, start: number, end: number): { count: number; clipped: number; average: number | null; max: number | null } {
  const rows = db.prepare('SELECT dbfs,clipped FROM samples WHERE sessionId=? AND capturedAt>=? AND capturedAt<=?')
    .all(sessionId, start, end) as Row[];
  if (!rows.length) return { count: 0, clipped: 0, average: null, max: null };
  let sum = 0;
  let max = Number.NEGATIVE_INFINITY;
  let clipped = 0;
  for (const r of rows) {
    const v = Number(r.dbfs);
    sum += v;
    if (v > max) max = v;
    if (Number(r.clipped) === 1) clipped += 1;
  }
  return { count: rows.length, clipped, average: round2(sum / rows.length), max };
}

const NOISE_EXCLUDED = new Set(['quiet', 'background', 'other']);

export function computeAggregate(row: Row, now: number): StudyAggregate {
  const sessionId = String(row.sessionId);
  const startTime = Number(row.startTime);
  const durationMs = row.durationMs === null ? null : Number(row.durationMs);
  const observedMs = durationMs ?? Math.max(0, (row.endTime === null ? now : Number(row.endTime)) - startTime);
  const buckets = db.prepare('SELECT * FROM acoustic_summaries WHERE sessionId=? ORDER BY bucketIndex').all(sessionId) as Row[];

  let quietMs = 0;
  let noisyMs = 0;
  let unknownMs = 0;
  let validInferenceMs = 0;
  let classifiedMs = 0;
  let categoryUnknownMs = 0;
  let sumWidth = 0;
  const perCategory = new Map<string, number>();
  for (const id of CATEGORY_IDS) perCategory.set(id, 0);
  const confirmedEpisodes = new Set<string>();
  for (const b of buckets) {
    quietMs += Number(b.quietMs);
    noisyMs += Number(b.noisyMs);
    unknownMs += Number(b.unknownMs);
    validInferenceMs += Number(b.validInferenceMs);
    classifiedMs += Number(b.classifiedMs);
    categoryUnknownMs += Number(b.categoryUnknownMs);
    sumWidth += Number(b.endOffsetMs) - Number(b.startOffsetMs);
    const cats = parseJson<Record<string, number>>(b.categoryMs) ?? {};
    for (const id of CATEGORY_IDS) perCategory.set(id, (perCategory.get(id) ?? 0) + Number(cats[id] ?? 0));
    const eps = parseJson<{ episodeId: string; kind: string }[]>(b.episodes) ?? [];
    for (const e of eps) if (e.kind === 'confirmed') confirmedEpisodes.add(String(e.episodeId));
  }
  const missingBucketMs = durationMs === null ? null : Math.max(0, durationMs - sumWidth);
  if (missingBucketMs !== null && missingBucketMs > 0) {
    // §5：durationMs−sum桶宽补进 unknownMs 与 categoryUnknownMs。
    unknownMs += missingBucketMs;
    categoryUnknownMs += missingBucketMs;
    if (durationMs !== null) classifiedMs = Math.min(classifiedMs, durationMs);
  }
  const hasValidAi = validInferenceMs > 0;
  const stats = sampleStats(sessionId, startTime, row.endTime === null ? now : Number(row.endTime));

  let dominant: string | null = null;
  let dominantMs = 0;
  for (const id of CATEGORY_IDS) {
    if (NOISE_EXCLUDED.has(id)) continue;
    const v = perCategory.get(id) ?? 0;
    if (v > dominantMs || (v === dominantMs && v > 0 && dominant !== null && id < dominant)) {
      dominant = id;
      dominantMs = v;
    }
  }
  if (dominantMs === 0) dominant = null;

  let distribution: Record<string, number> | null = null;
  if (classifiedMs > 0) {
    distribution = {};
    for (const id of CATEGORY_IDS) {
      distribution[id] = round2(((perCategory.get(id) ?? 0) / classifiedMs) * 100);
    }
  }
  const flags: string[] = [];
  if (missingBucketMs !== null && missingBucketMs > 0) flags.push('missing_bucket');
  if (buckets.some((b) => String(b.aiStatus) === 'unavailable')) flags.push('ai_unavailable');
  if (!hasValidAi) flags.push('no_valid_inference');
  if (stats.count > 0 && stats.clipped / stats.count > ELIGIBILITY.maxClippedRatio) flags.push('clipped');
  if (hasValidAi && observedMs > 0 && validInferenceMs / observedMs < ELIGIBILITY.minCoverageRatio) flags.push('low_coverage');

  return {
    interruptionCount: hasValidAi ? confirmedEpisodes.size : null,
    quietDuration: hasValidAi ? round2(quietMs / 1000) : null,
    noisyDuration: hasValidAi ? round2(noisyMs / 1000) : null,
    validInferenceMs: hasValidAi ? validInferenceMs : null,
    classifiedMs: classifiedMs > 0 ? classifiedMs : null,
    unknownMs: hasValidAi ? unknownMs : null,
    categoryUnknownMs: hasValidAi ? categoryUnknownMs : null,
    coverageRatio: hasValidAi && observedMs > 0 ? round2(validInferenceMs / observedMs * 1000) / 1000 : null,
    averageDb: stats.average,
    maxDb: stats.max,
    dominantNoiseEvent: dominant,
    acousticEventDistribution: distribution,
    sampleCount: stats.count,
    sampleClippedCount: stats.count ? stats.clipped : null,
    missingBucketMs,
    qualityFlags: flags,
  };
}

const AGG_COLUMNS: readonly (keyof StudyAggregate)[] = [
  'interruptionCount', 'quietDuration', 'noisyDuration', 'validInferenceMs', 'classifiedMs', 'unknownMs',
  'categoryUnknownMs', 'coverageRatio', 'averageDb', 'maxDb', 'dominantNoiseEvent', 'acousticEventDistribution',
  'sampleCount', 'sampleClippedCount', 'missingBucketMs', 'qualityFlags',
];

function aggregateChanged(row: Row, agg: StudyAggregate): boolean {
  for (const key of AGG_COLUMNS) {
    const stored = row[key] as unknown;
    const next = agg[key];
    if (key === 'acousticEventDistribution' || key === 'qualityFlags') {
      const a = key === 'qualityFlags' ? (parseJson<string[]>(stored) ?? []) : parseJson<unknown>(stored);
      const b = key === 'qualityFlags' ? next : next;
      if (canonicalJson(a) !== canonicalJson(b)) return true;
      continue;
    }
    const left = stored === null || stored === undefined ? null : stored;
    if (left !== next) return true;
  }
  return false;
}

/**
 * 重算并落盘一个会话的聚合缓存。
 * 只有聚合内容真的变化才递增 aggregateRevision（重复读/重复写不涨版本）。
 */
export function recomputeSession(sessionId: string, now = Date.now()): number {
  const row = sessionRow(sessionId);
  if (!row) throw new StudyError('STUDY_NOT_FOUND', '学习会话不存在');
  const agg = computeAggregate(row, now);
  // 状态收敛：有 end 意图后按缺桶判定 ended/partial；补桶补齐后 partial→ended。
  let status = String(row.status);
  if (row.durationMs !== null) status = agg.missingBucketMs && agg.missingBucketMs > 0 ? 'partial' : 'ended';
  else status = 'open';
  const statusChanged = status !== String(row.status);
  const changed = statusChanged || aggregateChanged(row, agg);
  if (!changed) return Number(row.aggregateRevision);
  const revision = Number(row.aggregateRevision) + 1;
  db.prepare(
    `UPDATE study_sessions SET interruptionCount=?,quietDuration=?,noisyDuration=?,validInferenceMs=?,classifiedMs=?,
       unknownMs=?,categoryUnknownMs=?,coverageRatio=?,averageDb=?,maxDb=?,dominantNoiseEvent=?,acousticEventDistribution=?,
       sampleCount=?,sampleClippedCount=?,qualityFlags=?,status=?,aggregateRevision=?,updatedAt=?
     WHERE sessionId=?`,
  ).run(
    agg.interruptionCount, agg.quietDuration, agg.noisyDuration, agg.validInferenceMs, agg.classifiedMs,
    agg.unknownMs, agg.categoryUnknownMs, agg.coverageRatio, agg.averageDb, agg.maxDb, agg.dominantNoiseEvent,
    agg.acousticEventDistribution ? JSON.stringify(agg.acousticEventDistribution) : null,
    agg.sampleCount, agg.sampleClippedCount, JSON.stringify(agg.qualityFlags), status, revision, now, sessionId,
  );
  return revision;
}

// ---------------------------------------------------------------------------
// 2. 声学摘要批量写入（POST /api/acoustic-summaries/batch）
// ---------------------------------------------------------------------------

function validateBucket(b: BucketDTO, session: Row): void {
  const fail = (message: string): never => {
    throw new StudyError('VALIDATION_FAILED', message);
  };
  if (b.startOffsetMs !== b.bucketIndex * BUCKET_WIDTH_MS) fail('startOffsetMs 必须等于 5000×bucketIndex');
  if (b.endOffsetMs <= b.startOffsetMs) fail('endOffsetMs 必须大于 startOffsetMs');
  const width = b.endOffsetMs - b.startOffsetMs;
  if (width > BUCKET_WIDTH_MS) fail('桶宽不得超过 5000ms');
  const durationMs = session.durationMs === null ? null : Number(session.durationMs);
  if (durationMs === null) {
    if (width !== BUCKET_WIDTH_MS) fail('运行中的桶必须宽 5000ms');
  } else {
    if (b.endOffsetMs > durationMs) fail('桶 offset 越过 session durationMs');
    if (width < BUCKET_WIDTH_MS && b.endOffsetMs !== durationMs) fail('尾桶必须恰好裁到 durationMs');
  }
  if (b.quietMs + b.noisyMs + b.unknownMs !== width) fail('quiet/noisy/unknown 三者和必须等于桶宽');
  if (b.validInferenceMs > width) fail('validInferenceMs 不得超过桶宽');
  if (b.classifiedMs > b.validInferenceMs) fail('classifiedMs 不得超过 validInferenceMs');
  const catSum = CATEGORY_IDS.reduce((acc, id) => acc + Number(b.categoryMs[id] ?? 0), 0);
  if (catSum !== b.classifiedMs) fail('categoryMs 各项和必须等于 classifiedMs');
  if (b.categoryUnknownMs !== width - b.classifiedMs) fail('categoryUnknownMs 必须等于桶宽−classifiedMs');
  for (const e of b.episodes) {
    if (e.startOffsetMs < b.startOffsetMs || e.startOffsetMs >= b.endOffsetMs) fail('episode 起点必须落在本桶内');
  }
  if (b.aiStatus === 'unavailable') {
    if (b.validInferenceMs !== 0 || b.classifiedMs !== 0 || catSum !== 0 || b.top3.length !== 0 || b.episodes.length !== 0) {
      fail('aiStatus=unavailable 的桶必须全 unknown：categoryMs 全 0、validInferenceMs=0、top3=[]');
    }
  }
  for (const [field, value] of [
    ['modelHash', b.modelHash], ['runtimeVersion', b.runtimeVersion], ['preprocessVersion', b.preprocessVersion],
    ['mapVersion', b.mapVersion], ['decisionVersion', b.decisionVersion],
  ] as const) {
    if (String(session[field]) !== value) fail(`桶的 ${field} 必须与该学习会话绑定版本一致`);
  }
}

export interface BatchResult {
  acceptedIds: string[];
  aggregateRevisions: { sessionId: string; aggregateRevision: number }[];
}

export function writeBatch(ownerHash: string, summaries: BucketDTO[], now = Date.now()): BatchResult {
  const accepted: string[] = [];
  const touched = new Set<string>();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const b of summaries) {
      // 先做与库无关的形状足够；会话缺失/他人会话统一 404。
      const session = mustSession(b.sessionId, ownerHash, sessionRow(b.sessionId, ownerHash));
      validateBucket(b, session);
      const payload = canonicalJson({ ...b, receivedAt: undefined, payloadHash: undefined });
      const hash = sha256(payload);
      const byId = db.prepare('SELECT id,sessionId,bucketIndex,payloadHash FROM acoustic_summaries WHERE id=?').get(b.id) as Row | undefined;
      if (byId) {
        if (String(byId.payloadHash) !== hash) throw new StudyError('IDEMPOTENCY_CONFLICT', '相同 id 的摘要内容不一致');
        accepted.push(b.id);
        touched.add(b.sessionId);
        continue;
      }
      const byBucket = db.prepare('SELECT id,payloadHash FROM acoustic_summaries WHERE sessionId=? AND bucketIndex=?')
        .get(b.sessionId, b.bucketIndex) as Row | undefined;
      if (byBucket) {
        if (String(byBucket.payloadHash) !== hash || String(byBucket.id) !== b.id) {
          throw new StudyError('IDEMPOTENCY_CONFLICT', '相同会话桶位置已存在内容不同的摘要');
        }
        accepted.push(b.id);
        touched.add(b.sessionId);
        continue;
      }
      db.prepare(
        `INSERT INTO acoustic_summaries(id,sessionId,bucketIndex,startOffsetMs,endOffsetMs,quietMs,noisyMs,unknownMs,
           validInferenceMs,classifiedMs,categoryMs,categoryUnknownMs,top3,episodes,inferenceCount,expectedWindowCount,
           droppedWindowCount,clippedMs,resampleClampCount,aiStatus,reason,modelHash,runtimeVersion,preprocessVersion,
           mapVersion,decisionVersion,receivedAt,payloadHash)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        b.id, b.sessionId, b.bucketIndex, b.startOffsetMs, b.endOffsetMs, b.quietMs, b.noisyMs, b.unknownMs,
        b.validInferenceMs, b.classifiedMs, JSON.stringify(b.categoryMs), b.categoryUnknownMs,
        JSON.stringify(b.top3), JSON.stringify(b.episodes), b.inferenceCount, b.expectedWindowCount,
        b.droppedWindowCount, b.clippedMs, b.resampleClampCount, b.aiStatus, b.reason, b.modelHash, b.runtimeVersion,
        b.preprocessVersion, b.mapVersion, b.decisionVersion, now, hash,
      );
      accepted.push(b.id);
      touched.add(b.sessionId);
    }
    const revisions = [...touched].sort().map((sessionId) => ({
      sessionId,
      aggregateRevision: recomputeSession(sessionId, now),
    }));
    db.exec('COMMIT');
    return { acceptedIds: accepted, aggregateRevisions: revisions };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 3. 结束学习会话（POST /api/study-sessions/:id/end）
// ---------------------------------------------------------------------------

export interface EndResult {
  sessionId: string;
  endTime: number;
  duration: number;
  status: string;
  missingBucketCount: number;
  aggregateRevision: number;
  idempotent: boolean;
}

function endIntentHash(d: EndDTO): string {
  return sha256(canonicalJson({ requestId: d.requestId, durationMs: d.durationMs, endReason: d.endReason, expectedBucketCount: d.expectedBucketCount }));
}

export function endStudySession(sessionId: string, ownerHash: string, dto: EndDTO, now = Date.now()): EndResult {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = mustSession(sessionId, ownerHash, sessionRow(sessionId, ownerHash));
    const expected = Math.ceil(dto.durationMs / BUCKET_WIDTH_MS);
    if (dto.expectedBucketCount !== expected) {
      throw new StudyError('VALIDATION_FAILED', `expectedBucketCount 必须等于 ceil(durationMs/5000)=${expected}`);
    }
    const hash = endIntentHash(dto);
    if (row.endRequestId !== null && String(row.endRequestId) === dto.requestId) {
      if (String(row.endIntentHash) !== hash) throw new StudyError('IDEMPOTENCY_CONFLICT', '相同 end requestId 的结束意图不一致');
      const bucketCount = Number((db.prepare('SELECT COUNT(*) AS n FROM acoustic_summaries WHERE sessionId=?').get(sessionId) as Row).n);
      db.exec('COMMIT');
      return {
        sessionId,
        endTime: Number(row.endTime),
        duration: Number(row.durationMs) / 1000,
        status: String(row.status),
        missingBucketCount: Math.max(0, Number(row.expectedBucketCount) - bucketCount),
        aggregateRevision: Number(row.aggregateRevision),
        idempotent: true,
      };
    }
    if (row.endRequestId !== null) throw new StudyError('SESSION_ENDED', '学习会话已结束');
    // §5：endTime = startTime + durationMs，绝不用网络到达时刻。
    const endTime = Number(row.startTime) + dto.durationMs;
    db.prepare('UPDATE study_sessions SET endTime=?,durationMs=?,endReason=?,expectedBucketCount=?,endRequestId=?,endIntentHash=?,updatedAt=? WHERE sessionId=?')
      .run(endTime, dto.durationMs, dto.endReason, dto.expectedBucketCount, dto.requestId, hash, now, sessionId);
    const revision = recomputeSession(sessionId, now);
    const updated = sessionRow(sessionId)!;
    const bucketCount = Number((db.prepare('SELECT COUNT(*) AS n FROM acoustic_summaries WHERE sessionId=?').get(sessionId) as Row).n);
    db.exec('COMMIT');
    return {
      sessionId,
      endTime,
      duration: dto.durationMs / 1000,
      status: String(updated.status),
      missingBucketCount: Math.max(0, dto.expectedBucketCount - bucketCount),
      aggregateRevision: revision,
      idempotent: false,
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 4. 自评（POST /api/study-sessions/:id/scores）
// ---------------------------------------------------------------------------

export interface ScoresResult {
  sessionId: string;
  scoreRevision: number;
  updatedAt: number;
  idempotent: boolean;
}

export function normalizeNote(note: string | null): string | null {
  if (note === null) return null;
  const trimmed = note.trim();
  return trimmed === '' ? null : trimmed;
}

export function writeScores(sessionId: string, ownerHash: string, dto: ScoresDTO, now = Date.now()): ScoresResult {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = mustSession(sessionId, ownerHash, sessionRow(sessionId, ownerHash));
    const note = normalizeNote(dto.optionalNote);
    const hash = sha256(canonicalJson({ ...dto, optionalNote: note }));
    if (row.scoreRequestId !== null && String(row.scoreRequestId) === dto.requestId) {
      if (String(row.scoreRequestHash) !== hash) throw new StudyError('IDEMPOTENCY_CONFLICT', '相同 score requestId 的自评内容不一致');
      db.exec('COMMIT');
      return { sessionId, scoreRevision: Number(row.scoreRevision), updatedAt: Number(row.updatedAt), idempotent: true };
    }
    if (String(row.status) === 'open') throw new StudyError('REVISION_CONFLICT', '学习会话尚未结束，暂不能写入自评');
    if (Number(row.scoreRevision) !== dto.expectedRevision) {
      throw new StudyError('REVISION_CONFLICT', `自评版本冲突：期望 ${dto.expectedRevision}，当前 ${Number(row.scoreRevision)}`);
    }
    // §5：AI 不能代填；1–5 或 null 由用户显式给出，三个字段必带（schema 保证）。
    db.prepare('UPDATE study_sessions SET userFocusScore=?,userEfficiencyScore=?,optionalNote=?,scoreRevision=?,scoreRequestId=?,scoreRequestHash=?,updatedAt=? WHERE sessionId=?')
      .run(dto.userFocusScore, dto.userEfficiencyScore, note, Number(row.scoreRevision) + 1, dto.requestId, hash, now, sessionId);
    db.exec('COMMIT');
    return { sessionId, scoreRevision: Number(row.scoreRevision) + 1, updatedAt: now, idempotent: false };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 5/6. 读取（GET /api/study-sessions/:id、GET /api/study-sessions）
// ---------------------------------------------------------------------------

export interface SessionDetail {
  study: StudySessionView;
  summaryCount: number;
  missingBucketCount: number;
  aggregateRevision: number;
}

export function getStudySession(sessionId: string, ownerHash: string, now = Date.now()): SessionDetail {
  const row = mustSession(sessionId, ownerHash);
  refreshFromSamples(sessionId, now);
  return detail(sessionId, now);
}

function detail(sessionId: string, now: number): SessionDetail {
  const fresh = sessionRow(sessionId)!;
  const summaryCount = Number((db.prepare('SELECT COUNT(*) AS n FROM acoustic_summaries WHERE sessionId=?').get(sessionId) as Row).n);
  const expected = fresh.expectedBucketCount === null ? null : Number(fresh.expectedBucketCount);
  const view = toView(fresh);
  view.summaryCount = summaryCount;
  view.missingBucketCount = expected === null ? 0 : Math.max(0, expected - summaryCount);
  return {
    study: view,
    summaryCount,
    missingBucketCount: view.missingBucketCount,
    aggregateRevision: Number(fresh.aggregateRevision),
  };
}

/**
 * 声学补传之外的真实 samples 补传：重算样本派生字段（§5「新samples到来时标 dirty 并重算，不改 samples 内容」）。
 * server/store.ts 属冻结面，故不挂钩 saveBatch，改为读路径惰性重算；仅当数值真的变化才递增 revision。
 */
export function refreshFromSamples(sessionId: string, now = Date.now()): number {
  return recomputeSession(sessionId, now);
}

export interface PageCursor { startTime: number; sessionId: string }

export function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(`${cursor.startTime}|${cursor.sessionId}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): PageCursor {
  let text: string;
  try {
    text = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw new StudyError('VALIDATION_FAILED', 'cursor 非法');
  }
  const at = text.lastIndexOf('|');
  const startTime = Number(text.slice(0, at));
  const sessionId = text.slice(at + 1);
  if (at < 0 || !Number.isInteger(startTime) || !sessionId) throw new StudyError('VALIDATION_FAILED', 'cursor 非法');
  return { startTime, sessionId };
}

export interface ListResult {
  items: StudySessionView[];
  nextCursor: string | null;
}

export function listStudySessions(
  ownerHash: string,
  query: { from?: number; to?: number; limit?: number; cursor?: string },
  now = Date.now(),
): ListResult {
  const limit = query.limit ?? 20;
  const from = query.from ?? 0;
  const to = query.to ?? Number.MAX_SAFE_INTEGER;
  if (from >= to) throw new StudyError('VALIDATION_FAILED', 'from 必须小于 to');
  if (to - from > 366 * 86_400_000) throw new StudyError('VALIDATION_FAILED', '查询范围不得超过 366 天');
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const rows = (cursor
    ? db.prepare(`SELECT * FROM study_sessions WHERE ownerHash=? AND startTime>=? AND startTime<=? AND
        (startTime<? OR (startTime=? AND sessionId<?)) ORDER BY startTime DESC,sessionId DESC LIMIT ?`)
      .all(ownerHash, from, to, cursor.startTime, cursor.startTime, cursor.sessionId, limit + 1)
    : db.prepare('SELECT * FROM study_sessions WHERE ownerHash=? AND startTime>=? AND startTime<=? ORDER BY startTime DESC,sessionId DESC LIMIT ?')
      .all(ownerHash, from, to, limit + 1)) as Row[];
  for (const r of rows) refreshFromSamples(String(r.sessionId), now);
  const page = rows.slice(0, limit);
  const items = page.map((r) => detail(String(r.sessionId), now).study);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last
    ? encodeCursor({ startTime: Number(last.startTime), sessionId: String(last.sessionId) })
    : null;
  return { items, nextCursor };
}

// ---------------------------------------------------------------------------
// 7. 洞察（GET /api/study-insights）
// ---------------------------------------------------------------------------

export const INSIGHTS_WINDOW_DAYS = 30;

export function buildInsights(
  ownerHash: string,
  options: { timezone: string; nowDate?: string; range?: 'today' | 'week'; now?: number },
): InsightsPayload {
  const now = options.now ?? Date.now();
  const zone = resolveZone(options.timezone);
  const dayStart = zoneDayStart(now, zone);
  const weekStart = zoneWeekStart(now, zone);
  const windowStart = now - INSIGHTS_WINDOW_DAYS * 86_400_000;
  const rows = db.prepare('SELECT * FROM study_sessions WHERE ownerHash=? AND startTime>=? ORDER BY startTime ASC')
    .all(ownerHash, Math.min(windowStart, weekStart, dayStart)) as Row[];
  for (const r of rows) refreshFromSamples(String(r.sessionId), now);
  const refreshed = rows.map((r) => sessionRow(String(r.sessionId))!);
  // 增强 B（TASK B §3）：处理条件证据取自既有 `sessions.processing`（不改 schema、不加列）。
  // 读取模块把该值作为 `processingProfile` 供响应使用；**缺失/空值一律显式给空串**，
  // 使分析层得到「未报告 ⇒ 未知处理条件」而不是「未提供证据」的旧路径（生产出口不可绕过）。
  const processingOf = db.prepare('SELECT processing FROM sessions WHERE id=?');
  const points: StudyPoint[] = refreshed.map((r) => {
    const base = processingOf.get(String(r.sessionId)) as Row | undefined;
    return {
      view: toView(r),
      processing: base === undefined || base.processing === null ? '' : String(base.processing),
      // §4.1：洞察聚合需要的**全部**桶字段都必须在这里取全。
      // 历史缺陷：本 SELECT 只取到 start/end/quiet/noisy/unknown/categoryMs，
      // 导致 insights.ts 的分配函数读到 validInferenceMs=undefined → Number(undefined)=NaN
      // → JSON 序列化成 null（覆盖率/有效时长出口错误）；classifiedMs/categoryUnknownMs
      // 同类问题会让「类别未知时长」失真。缺列一律视为契约错误（不静默补 0）。
      bucketRows: db.prepare(
        'SELECT startOffsetMs,endOffsetMs,quietMs,noisyMs,unknownMs,validInferenceMs,classifiedMs,categoryUnknownMs,categoryMs' +
        ' FROM acoustic_summaries WHERE sessionId=? ORDER BY bucketIndex',
      ).all(String(r.sessionId)) as Row[],
    };
  });
  const analysis = buildAnalysis(points, { now, zone, windowStart });
  const payload: InsightsPayload = {
    timezone: zone,
    // §4.1：nowDate 当前**只回显**，不参与边界的实际求解（生产 UI 不发送；不把回显当查询生效）。
    nowDate: options.nowDate ?? null,
    range: options.range ?? 'today',
    today: buildTodayBlock(points, { now, zone, allocate: allocateIntersection }),
    week: buildWeekBlock(points, { now, zone, allocate: allocateIntersection }),
    analysis: analysis as unknown as InsightsPayload['analysis'],
    updatedAt: now,
  };
  // §4.1 出口校验：任何非有限数都在这里抛出（保留上次可信缓存的判断权交给客户端），
  // 绝不把 NaN 交给 JSON.stringify 变成 null 伪装「合法缺测」。
  assertFiniteNumbers(payload);
  return payload;
}

/** 供 insights.ts 的纯函数读取：把 DB 行转成分析点。 */
export type { AnalysisRow };

// ---------------------------------------------------------------------------
// 8. 薄封装（阶段三收口）：对齐任务书点名签名，**内部一律委托既有实现**
//    —— 不复制校验、事务、幂等与聚合口径，避免出现第二套语义。
// ---------------------------------------------------------------------------

/**
 * 任务书签名 `saveAcousticSummaries(sessionId, items[])` 的薄封装。
 *
 * 映射关系（逐项，不改内部实现）：
 *   `saveAcousticSummaries(sessionId, items, now)` → `writeBatch(ownerHash, summaries, now)`
 *   · `summaries`：`items` 原样透传（同一数组引用，不做字段改写/补默认值）；
 *   · `ownerHash`：由 `study_sessions` 行按 sessionId 反查（writeBatch 的鉴权口径即 ownerHash+sessionId），
 *     本层不新增鉴权语义；会话不存在 → `STUDY_NOT_FOUND`（与 writeBatch 内部 mustSession 的 404 一致）；
 *   · 本层只补一条**签名级**约束：所有 `item.sessionId` 必须等于传入 `sessionId`
 *     （writeBatch 允许一批跨同 owner 的多个会话，薄封装按签名收窄为单会话，不改 writeBatch 本身）；
 *   · 返回值：writeBatch 的 `BatchResult` 原样返回（acceptedIds / aggregateRevisions），不做二次加工。
 *   ⇒ 因此「幂等 / 409 冲突 / 整批回滚 / 事务」全部沿用 writeBatch 行为，薄封装不另立规则。
 */
export function saveAcousticSummaries(sessionId: string, items: BucketDTO[], now = Date.now()): BatchResult {
  const session = sessionRow(sessionId);
  if (!session) throw new StudyError('STUDY_NOT_FOUND', '学习会话不存在');
  for (const item of items) {
    if (String(item.sessionId) !== sessionId) {
      throw new StudyError('VALIDATION_FAILED', 'summaries 必须全部属于同一学习会话');
    }
  }
  return writeBatch(String(session.ownerHash), items, now);
}

export interface StudyWindowAggregate {
  fromMs: number;
  toMs: number;
  sessionCount: number;
  endedCount: number;
  /** 窗口内 computeAggregate 给出有效 AI 时间（validInferenceMs !== null）的会话数。 */
  sessionsWithValidAi: number;
  quietMs: number;
  noisyMs: number;
  validInferenceMs: number;
  unknownMs: number;
  categoryUnknownMs: number;
  missingBucketMs: number;
}

/**
 * 任务书签名 `aggregateStudyWindow(fromMs, toMs)` 的薄封装。
 *
 * 映射关系（逐项，不改内部实现）：
 *   `aggregateStudyWindow(fromMs, toMs, ownerHash?, now)` → 对窗口内每个会话调用既有 `computeAggregate(row, now)`，再按字段求和
 *   · 窗口口径：`study_sessions.startTime ∈ [fromMs, toMs)`，与既有 `listStudySessions` 的时间过滤同口径；
 *   · 除计数外，各 `*Ms` 字段＝窗口内各会话 `computeAggregate` 对应字段之和；
 *     `quietDuration/noisyDuration` 按 §5 是**秒**，此处 ×1000 归一到毫秒后求和（仅此一处换算，聚合口径不变）；
 *   · `null`（无有效 AI 时间 / 无样本）在求和中记 0，并由 `sessionsWithValidAi` 单独体现，
 *     不把「无观测」伪装成「观测到 0」（§5：不可把 NULL 读成 0）；
 *   · 纯读取：不落盘、不递增 aggregateRevision、不重算原始样本。
 *   · 隐私：`ownerHash` 省略时对窗口内**全部**会话求和（仅供数据层自检/测试）；
 *     HTTP 层必须传 ownerHash，遵守 §5「查询必须按 ownerHash 过滤」。
 */
export function aggregateStudyWindow(fromMs: number, toMs: number, ownerHash?: string, now = Date.now()): StudyWindowAggregate {
  const rows = (ownerHash === undefined
    ? db.prepare('SELECT * FROM study_sessions WHERE startTime>=? AND startTime<? ORDER BY startTime ASC')
      .all(fromMs, toMs)
    : db.prepare('SELECT * FROM study_sessions WHERE ownerHash=? AND startTime>=? AND startTime<? ORDER BY startTime ASC')
      .all(ownerHash, fromMs, toMs)) as Row[];
  const out: StudyWindowAggregate = {
    fromMs, toMs, sessionCount: rows.length, endedCount: 0, sessionsWithValidAi: 0,
    quietMs: 0, noisyMs: 0, validInferenceMs: 0, unknownMs: 0, categoryUnknownMs: 0, missingBucketMs: 0,
  };
  for (const row of rows) {
    if (String(row.status) !== 'open') out.endedCount += 1;
    const agg = computeAggregate(row, now);
    if (agg.validInferenceMs !== null) out.sessionsWithValidAi += 1;
    out.quietMs += (agg.quietDuration ?? 0) * 1000;
    out.noisyMs += (agg.noisyDuration ?? 0) * 1000;
    out.validInferenceMs += agg.validInferenceMs ?? 0;
    out.unknownMs += agg.unknownMs ?? 0;
    out.categoryUnknownMs += agg.categoryUnknownMs ?? 0;
    out.missingBucketMs += agg.missingBucketMs ?? 0;
  }
  return out;
}
