/**
 * F2 的**只读**事实源：对旧库开一个独立只读连接（`readOnly:true` + `PRAGMA query_only=ON`），
 * 在**一个只读事务**内取「学习会话 + 原始 processing + 逐桶摘要」，保证 revision 与桶快照不错位。
 *
 * 红线：不 import 旧 `study-store.ts`（会在导入期跑 DDL/迁移），不执行任何 DDL/DML，
 *      不加表、不加列、不迁移；旧库只读。
 */

import { DatabaseSync } from 'node:sqlite';

export interface StudySessionRow {
  sessionId: string;
  roomId: string;
  startTime: number;
  endTime: number | null;
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
  /** 既有 `sessions.processing`（缺失/空串一律给空串，绝不 undefined）。 */
  processing: string;
}

export interface BucketRow {
  sessionId: string;
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

export interface SnapshotResult {
  available: boolean;
  reason: string | null;
  sessions: StudySessionRow[];
  buckets: BucketRow[];
}

const UNAVAILABLE = (reason: string): SnapshotResult => ({ available: false, reason, sessions: [], buckets: [] });

const SESSION_SQL = `SELECT s.sessionId,s.roomId,s.startTime,s.endTime,s.durationMs,s.status,
       s.scoreRevision,s.aggregateRevision,s.userFocusScore,s.userEfficiencyScore,
       s.quietDuration,s.noisyDuration,s.interruptionCount,
       s.coverageRatio,s.sampleCount,s.sampleClippedCount,s.qualityFlags,
       s.expectedBucketCount,s.modelHash,s.runtimeVersion,s.preprocessVersion,
       s.mapVersion,s.decisionVersion
 FROM study_sessions s
 WHERE s.ownerHash=? AND s.startTime>=? AND s.startTime<?
 ORDER BY s.sessionId`;

const PROCESSING_SQL = 'SELECT processing FROM sessions WHERE id=?';

const BUCKET_SQL = `SELECT a.sessionId,a.bucketIndex,a.startOffsetMs,a.endOffsetMs,
       a.quietMs,a.noisyMs,a.unknownMs,a.validInferenceMs,a.classifiedMs,a.categoryMs,a.categoryUnknownMs,
       a.modelHash,a.runtimeVersion,a.preprocessVersion,a.mapVersion,a.decisionVersion
 FROM acoustic_summaries a JOIN study_sessions s ON s.sessionId=a.sessionId
 WHERE s.ownerHash=? AND s.startTime>=? AND s.startTime<?
 ORDER BY a.sessionId,a.bucketIndex`;

/**
 * 只读快照。任何不可读/锁/缺表都返回 `available:false`（调用方据此回 `STORE_UNAVAILABLE`），
 * **绝不**吞异常后返回空快照冒充"没有数据"。
 */
export function readOnlySnapshot(dbPath: string, ownerHash: string, from: number, to: number): SnapshotResult {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    return UNAVAILABLE(`open:${err instanceof Error ? err.name : 'UNKNOWN'}`);
  }
  try {
    db.exec('PRAGMA query_only=ON');
    db.exec('BEGIN');
    const raw = db.prepare(SESSION_SQL).all(ownerHash, from, to) as Record<string, unknown>[];
    const processingOf = db.prepare(PROCESSING_SQL);
    const sessions: StudySessionRow[] = raw.map((r) => {
      const base = processingOf.get(String(r.sessionId)) as Record<string, unknown> | undefined;
      const processing = base === undefined || base.processing === null ? '' : String(base.processing);
      return {
        sessionId: String(r.sessionId),
        roomId: String(r.roomId),
        startTime: Number(r.startTime),
        endTime: r.endTime === null || r.endTime === undefined ? null : Number(r.endTime),
        durationMs: r.durationMs === null || r.durationMs === undefined ? null : Number(r.durationMs),
        status: String(r.status),
        scoreRevision: Number(r.scoreRevision),
        aggregateRevision: Number(r.aggregateRevision),
        userFocusScore: r.userFocusScore === null || r.userFocusScore === undefined ? null : Number(r.userFocusScore),
        userEfficiencyScore: r.userEfficiencyScore === null || r.userEfficiencyScore === undefined ? null : Number(r.userEfficiencyScore),
        quietDuration: r.quietDuration === null || r.quietDuration === undefined ? null : Number(r.quietDuration),
        noisyDuration: r.noisyDuration === null || r.noisyDuration === undefined ? null : Number(r.noisyDuration),
        interruptionCount: r.interruptionCount === null || r.interruptionCount === undefined ? null : Number(r.interruptionCount),
        coverageRatio: r.coverageRatio === null || r.coverageRatio === undefined ? null : Number(r.coverageRatio),
        sampleCount: r.sampleCount === null || r.sampleCount === undefined ? null : Number(r.sampleCount),
        sampleClippedCount: r.sampleClippedCount === null || r.sampleClippedCount === undefined ? null : Number(r.sampleClippedCount),
        qualityFlags: r.qualityFlags === null || r.qualityFlags === undefined ? '' : String(r.qualityFlags),
        expectedBucketCount: r.expectedBucketCount === null || r.expectedBucketCount === undefined ? null : Number(r.expectedBucketCount),
        modelHash: String(r.modelHash),
        runtimeVersion: String(r.runtimeVersion),
        preprocessVersion: String(r.preprocessVersion),
        mapVersion: String(r.mapVersion),
        decisionVersion: String(r.decisionVersion),
        processing,
      };
    });
    const buckets = (db.prepare(BUCKET_SQL).all(ownerHash, from, to) as Record<string, unknown>[]).map((r) => ({
      sessionId: String(r.sessionId),
      bucketIndex: Number(r.bucketIndex),
      startOffsetMs: Number(r.startOffsetMs),
      endOffsetMs: Number(r.endOffsetMs),
      quietMs: Number(r.quietMs),
      noisyMs: Number(r.noisyMs),
      unknownMs: Number(r.unknownMs),
      validInferenceMs: Number(r.validInferenceMs),
      classifiedMs: Number(r.classifiedMs),
      categoryUnknownMs: Number(r.categoryUnknownMs),
      categoryMs: String(r.categoryMs),
      modelHash: String(r.modelHash),
      runtimeVersion: String(r.runtimeVersion),
      preprocessVersion: String(r.preprocessVersion),
      mapVersion: String(r.mapVersion),
      decisionVersion: String(r.decisionVersion),
    }));
    db.exec('COMMIT');
    return { available: true, reason: null, sessions, buckets };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 事务可能已因错误自动回滚；回滚失败不影响只读结论 */
    }
    const code = err instanceof Error ? err.message : 'UNKNOWN';
    if (/SQLITE_BUSY|database is locked/i.test(code)) return UNAVAILABLE('busy');
    return UNAVAILABLE(`read:${err instanceof Error ? err.name : 'UNKNOWN'}`);
  } finally {
    try {
      db.close();
    } catch {
      /* 关闭失败不影响已取出的只读快照 */
    }
  }
}

/**
 * 只读校验 + **服务端复算**：某个 owner 的某个 session 的某个桶区间是否逐桶存在且几何连续，
 * 并给出权威聚合与可信时间锚。F3 的 POST 用它核对 session/room 归属并复算指数
 * （**不采信**客户端自报的 quietIndex / 时间）。
 */
export interface AckedAggregate {
  found: boolean;
  roomId: string | null;
  serverSessionStart: number;
  lastBucketIndex: number | null;
  lastBucketEndOffsetMs: number | null;
  lastBucketReceivedAt: number | null;
  bucketCount: number;
  aggregate: { spanMs: number; quietMs: number; noisyMs: number; unknownMs: number; validInferenceMs: number } | null;
  /**
   * C6（Sol §2.5 F3）：**服务端权威**的分组维度读回 —— 四项版本 + modelHash + `sessions.processing`。
   *
   * 存在这一项的理由：F3 的分组键必须由服务器读回的数据决定，**不能**采信客户端自报的
   * `configKey`/`processingKey`；否则一个谎报键的客户端就能把本不可比的报告并进同一组。
   */
  canonical: {
    modelHash: string;
    runtimeVersion: string;
    preprocessVersion: string;
    mapVersion: string;
    decisionVersion: string;
    /** 既有 `sessions.processing` 原文（缺失/不可读一律空串，绝不 undefined）。 */
    processing: string;
  } | null;
}

const NOT_FOUND: AckedAggregate = {
  found: false,
  roomId: null,
  serverSessionStart: 0,
  lastBucketIndex: null,
  lastBucketEndOffsetMs: null,
  lastBucketReceivedAt: null,
  bucketCount: 0,
  aggregate: null,
  canonical: null,
};

export function readAckedAggregate(
  dbPath: string,
  ownerHash: string,
  sessionId: string,
  firstBucket: number,
  lastBucket: number,
): AckedAggregate {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return NOT_FOUND;
  }
  try {
    db.exec('PRAGMA query_only=ON');
    db.exec('BEGIN');
    const head = db
      .prepare(
        'SELECT roomId,startTime,modelHash,runtimeVersion,preprocessVersion,mapVersion,decisionVersion' +
          ' FROM study_sessions WHERE sessionId=? AND ownerHash=?',
      )
      .get(sessionId, ownerHash) as Record<string, unknown> | undefined;
    if (head === undefined) {
      db.exec('COMMIT');
      return NOT_FOUND;
    }
    // `sessions.processing` 是既有只读列（主库 schema 未动）；读不到就当空串，不编造。
    let processing = '';
    try {
      const row = db.prepare(PROCESSING_SQL).get(sessionId) as Record<string, unknown> | undefined;
      if (row !== undefined && row.processing !== null && row.processing !== undefined) processing = String(row.processing);
    } catch {
      processing = '';
    }
    const canonical = {
      modelHash: head.modelHash === null || head.modelHash === undefined ? '' : String(head.modelHash),
      runtimeVersion: head.runtimeVersion === null || head.runtimeVersion === undefined ? '' : String(head.runtimeVersion),
      preprocessVersion: head.preprocessVersion === null || head.preprocessVersion === undefined ? '' : String(head.preprocessVersion),
      mapVersion: head.mapVersion === null || head.mapVersion === undefined ? '' : String(head.mapVersion),
      decisionVersion: head.decisionVersion === null || head.decisionVersion === undefined ? '' : String(head.decisionVersion),
      processing,
    };
    const rows = db
      .prepare(
        'SELECT bucketIndex,startOffsetMs,endOffsetMs,quietMs,noisyMs,unknownMs,validInferenceMs,receivedAt' +
          ' FROM acoustic_summaries WHERE sessionId=? AND bucketIndex>=? AND bucketIndex<=? ORDER BY bucketIndex',
      )
      .all(sessionId, firstBucket, lastBucket) as Record<string, unknown>[];
    const total = db
      .prepare('SELECT COUNT(*) AS n FROM acoustic_summaries WHERE sessionId=?')
      .get(sessionId) as Record<string, unknown>;
    db.exec('COMMIT');
    const expect = lastBucket - firstBucket + 1;
    if (expect <= 0 || rows.length !== expect) return NOT_FOUND;
    let quietMs = 0;
    let noisyMs = 0;
    let unknownMs = 0;
    let validInferenceMs = 0;
    let prevEnd: number | null = null;
    for (const r of rows) {
      const index = Number(r.bucketIndex);
      const start = Number(r.startOffsetMs);
      const end = Number(r.endOffsetMs);
      if (start !== index * 5000 || end <= start) return NOT_FOUND;
      if (prevEnd !== null && start !== prevEnd) return NOT_FOUND;
      prevEnd = end;
      quietMs += Number(r.quietMs);
      noisyMs += Number(r.noisyMs);
      unknownMs += Number(r.unknownMs);
      validInferenceMs += Number(r.validInferenceMs);
    }
    const first = rows[0];
    const tail = rows[rows.length - 1];
    const spanMs = Number(tail.endOffsetMs) - Number(first.startOffsetMs);
    return {
      found: true,
      roomId: String(head.roomId),
      serverSessionStart: Number(head.startTime),
      lastBucketIndex: lastBucket,
      lastBucketEndOffsetMs: Number(tail.endOffsetMs),
      lastBucketReceivedAt: Number(tail.receivedAt),
      bucketCount: total.n === null || total.n === undefined ? 0 : Number(total.n),
      aggregate: { spanMs, quietMs, noisyMs, unknownMs, validInferenceMs },
      canonical,
    };
  } catch {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 只读结论不因回滚失败改变 */
    }
    return NOT_FOUND;
  } finally {
    try {
      db.close();
    } catch {
      /* 同上 */
    }
  }
}
