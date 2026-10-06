/**
 * 附加服务 HTTP 端到端（真实 express + 真实只读 SQLite + 真实 fetch）：
 *  · F2：真实提交且已 ACK 的最新 revision 才被接受；不足 ⇒ `insufficient_n`；processing 未知 ⇒
 *    `blocked_unknown_processing`；零方差 ⇒ `zero_variance`；跨 owner 与不存在同为 404；
 *  · F3：POST 校验 provenance/passport、**服务端复算**聚合并拒绝不一致；同 reportId 幂等；
 *    GET 只输出匿名房间聚合（不含 terminalId/ownerHash/sessionId）。
 *
 * 本文件只读旧库；测试库是临时文件，绝不触碰生产 `quiet.sqlite`。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createAddonApp } from '../main.js';
import { CATEGORY_IDS } from '../../shared/study-model.js';

const OWNER_A_KEY = 'A'.repeat(24);
const OWNER_B_KEY = 'B'.repeat(24);
const hashOf = (key: string): string => createHash('sha256').update(key).digest('hex');

const DDL = `
CREATE TABLE sessions(id TEXT PRIMARY KEY,roomId TEXT NOT NULL,source TEXT NOT NULL,baseline REAL NOT NULL,processing TEXT NOT NULL,createdAt INTEGER NOT NULL,closedAt INTEGER);
CREATE TABLE study_sessions(
 sessionId TEXT PRIMARY KEY NOT NULL,ownerHash TEXT NOT NULL,roomId TEXT NOT NULL,startTime INTEGER NOT NULL,
 endTime INTEGER,durationMs INTEGER,timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',status TEXT NOT NULL,
 endReason TEXT,expectedBucketCount INTEGER,aggregateRevision INTEGER NOT NULL DEFAULT 0,scoreRevision INTEGER NOT NULL DEFAULT 0,
 endRequestId TEXT,endIntentHash TEXT,scoreRequestId TEXT,scoreRequestHash TEXT,averageDb REAL,maxDb REAL,
 dominantNoiseEvent TEXT,acousticEventDistribution TEXT,interruptionCount INTEGER,quietDuration REAL,noisyDuration REAL,
 userFocusScore INTEGER,userEfficiencyScore INTEGER,optionalNote TEXT,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,
 sampleCount INTEGER,sampleClippedCount INTEGER,validInferenceMs INTEGER,classifiedMs INTEGER,unknownMs INTEGER,
 categoryUnknownMs INTEGER,coverageRatio REAL,qualityFlags TEXT,modelHash TEXT NOT NULL,runtimeVersion TEXT NOT NULL,
 preprocessVersion TEXT NOT NULL,mapVersion TEXT NOT NULL,decisionVersion TEXT NOT NULL);
CREATE TABLE acoustic_summaries(
 id TEXT PRIMARY KEY NOT NULL,sessionId TEXT NOT NULL,bucketIndex INTEGER NOT NULL,startOffsetMs INTEGER NOT NULL,
 endOffsetMs INTEGER NOT NULL,quietMs INTEGER NOT NULL,noisyMs INTEGER NOT NULL,unknownMs INTEGER NOT NULL,
 validInferenceMs INTEGER NOT NULL,classifiedMs INTEGER NOT NULL,categoryMs TEXT NOT NULL,categoryUnknownMs INTEGER NOT NULL,
 top3 TEXT NOT NULL,episodes TEXT NOT NULL,inferenceCount INTEGER NOT NULL,expectedWindowCount INTEGER NOT NULL,
 droppedWindowCount INTEGER NOT NULL,clippedMs INTEGER NOT NULL,resampleClampCount INTEGER NOT NULL,aiStatus TEXT NOT NULL,
 reason TEXT,modelHash TEXT NOT NULL,runtimeVersion TEXT NOT NULL,preprocessVersion TEXT NOT NULL,mapVersion TEXT NOT NULL,
 decisionVersion TEXT NOT NULL,receivedAt INTEGER NOT NULL,payloadHash TEXT NOT NULL,UNIQUE(sessionId,bucketIndex));
`;

const MODEL = 'a'.repeat(64);
const T0 = 1_760_000_000_000;
const VERIFIED = 'qp-proc-v1;agc=off;ch=1;ec=off;fs=16000;ns=off';

interface Db {
  path: string;
  close: () => void;
  insert: (input: {
    sessionId: string;
    owner?: string;
    roomId?: string;
    startTime?: number;
    scoreRevision?: number;
    focus?: number | null;
    efficiency?: number | null;
    processing?: string;
    conversationMs?: number;
    quietMs?: number;
    noisyMs?: number;
    unknownMs?: number;
    validInferenceMs?: number;
    bucketCount?: number;
    durationMs?: number;
    qualityFlags?: string;
    status?: string;
    decisionVersion?: string;
  }) => void;
}

function openDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'addons-http-'));
  const path = join(dir, 'quiet.sqlite');
  const db = new DatabaseSync(path);
  db.exec(DDL);
  const insertSession = db.prepare(
    `INSERT INTO sessions VALUES(?,?,?,?,?,?,NULL)`,
  );
  const insertStudy = db.prepare(
    `INSERT INTO study_sessions(sessionId,ownerHash,roomId,startTime,endTime,durationMs,status,endReason,expectedBucketCount,
     aggregateRevision,scoreRevision,interruptionCount,quietDuration,noisyDuration,userFocusScore,userEfficiencyScore,createdAt,updatedAt,
     sampleCount,sampleClippedCount,validInferenceMs,classifiedMs,unknownMs,categoryUnknownMs,coverageRatio,qualityFlags,
     modelHash,runtimeVersion,preprocessVersion,mapVersion,decisionVersion)
     VALUES(?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertBucket = db.prepare(
    `INSERT INTO acoustic_summaries(id,sessionId,bucketIndex,startOffsetMs,endOffsetMs,quietMs,noisyMs,unknownMs,
     validInferenceMs,classifiedMs,categoryMs,categoryUnknownMs,top3,episodes,inferenceCount,expectedWindowCount,
     droppedWindowCount,clippedMs,resampleClampCount,aiStatus,reason,modelHash,runtimeVersion,preprocessVersion,mapVersion,
     decisionVersion,receivedAt,payloadHash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?)`,
  );
  const insert = (input: Parameters<Db['insert']>[0]): void => {
    const owner = input.owner ?? hashOf(OWNER_A_KEY);
    // 默认 60 桶 = 300 s：既有资格门槛要求 duration ≥ 300 s（否则会被 quality:too_short 挡掉）。
    const bucketCount = input.bucketCount ?? 60;
    const durationMs = input.durationMs ?? bucketCount * 5000;
    const valid = input.validInferenceMs ?? durationMs;
    const quietMs = input.quietMs ?? 0;
    const noisyMs = input.noisyMs ?? 0;
    const unknownMs = input.unknownMs ?? durationMs - quietMs - noisyMs;
    const start = input.startTime ?? T0;
    insertSession.run(input.sessionId, input.roomId ?? 'study-201', 'microphone', -55, input.processing ?? VERIFIED, start);
    const decisionVersion = input.decisionVersion ?? 'decision-v1';
    insertStudy.run(
      input.sessionId, owner, input.roomId ?? 'study-201', start, start + durationMs, durationMs,
      input.status ?? 'ended', bucketCount, 1, input.scoreRevision ?? 1,
      0, quietMs / 1000, noisyMs / 1000, input.focus === undefined ? 4 : input.focus,
      input.efficiency === undefined ? 3 : input.efficiency, start, start,
      bucketCount, 0, valid, valid, unknownMs, 0, 1, input.qualityFlags ?? '[]',
      MODEL, 'tflite-2.16.1', 'preproc-v2', 'map-v1', decisionVersion,
    );
    for (let i = 0; i < bucketCount; i += 1) {
      const width = i === bucketCount - 1 ? durationMs - i * 5000 : 5000;
      // 逐桶按比例分摊，保证 Σquiet/Σnoisy/Σunknown 与 session 级聚合**逐字相等**（否则服务端复算会 409）。
      const share = (value: number): number => Math.round((value * width) / durationMs);
      const bQuiet = share(quietMs);
      const bNoisy = share(noisyMs);
      const bUnknown = width - bQuiet - bNoisy;
      const cats = Object.fromEntries(CATEGORY_IDS.map((id) => [id, id === 'conversation' ? (input.conversationMs ?? 1000) : 0]));
      insertBucket.run(
        `${input.sessionId}-${i}`, input.sessionId, i, i * 5000, i * 5000 + width,
        bQuiet, bNoisy, bUnknown, share(valid), share(valid), JSON.stringify(cats), 0, '[]', '[]', 1, 1, 0, 0, 0,
        'ready', MODEL, 'tflite-2.16.1', 'preproc-v2', 'map-v1', 'decision-v1', start + i * 5000 + 4000, 'p',
      );
    }
  };
  return { path, insert, close: () => db.close() };
}

interface Booted {
  base: string;
  close: () => Promise<void>;
  file: string;
}

async function boot(dbPath: string): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), 'addons-store-'));
  const file = join(dir, 'room-index-v1.json');
  const { app } = createAddonApp({ dbPath, roomIndexFile: file, now: () => T0 + 40_000 });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    file,
  };
}

async function post(base: string, path: string, key: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Study-Key': key },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function passportsFor(...ids: string[]): { sessionId: string; scoreRevision: number; provenance: string; scoreAckObserved: boolean }[] {
  return ids.map((sessionId) => ({ sessionId, scoreRevision: 1, provenance: 'real', scoreAckObserved: true }));
}

const sid = (n: number): string => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;

test('F2H-1 缺 key / 非法 key 与旧语义一致（401）', async () => {
  const { path, insert, close } = openDb();
  const booted = await boot(path);
  try {
    const noKey = await fetch(`${booted.base}/v1/correlations/read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(noKey.status, 401);
    const badKey = await fetch(`${booted.base}/v1/correlations/read`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Study-Key': 'short' }, body: '{}' });
    assert.equal(badKey.status, 401);
    const body = await badKey.json() as { error: { code: string } };
    assert.equal(body.error.code, 'STUDY_KEY_INVALID');
  } finally {
    await booted.close();
    close();
  }
});

test('F2H-2 真实提交但记录不足 10 段 ⇒ 明确 insufficient_n（不是错误，也不给数值）', async () => {
  const { path, insert, close } = openDb();
  insert({ sessionId: sid(1), conversationMs: 1000, focus: 4 });
  insert({ sessionId: sid(2), conversationMs: 2000, focus: 5 });
  const booted = await boot(path);
  try {
    const res = await post(booted.base, '/v1/correlations/read', OWNER_A_KEY, {
      schemaVersion: 'category-pearson-v1', from: T0 - 1000, to: T0 + 86_400_000, passports: passportsFor(sid(1), sid(2)),
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.acceptedSessionN, 2);
    const conv = (res.json.groups[0].pairs as { category: string; score: string; n: number; r: number | null; reason: string }[])
      .find((p) => p.category === 'conversation' && p.score === 'focus');
    assert.equal(conv?.n, 2);
    assert.equal(conv?.r, null);
    assert.equal(conv?.reason, 'insufficient_n');
  } finally {
    await booted.close();
    close();
  }
});

test('F2H-3 processing 未知 / 缺证 ⇒ blocked_unknown_processing 且计数可见', async () => {
  const { path, insert, close } = openDb();
  insert({ sessionId: sid(1), processing: '' });
  insert({ sessionId: sid(2), processing: 'unknown' });
  insert({ sessionId: sid(3), processing: 'qp-proc-v1;fs=16000;agc=未报告' });
  const booted = await boot(path);
  try {
    const res = await post(booted.base, '/v1/correlations/read', OWNER_A_KEY, {
      schemaVersion: 'category-pearson-v1', from: T0 - 1000, to: T0 + 86_400_000, passports: passportsFor(sid(1), sid(2), sid(3)),
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.acceptedSessionN, 0);
    assert.equal(res.json.blockedProcessingN, 3);
    assert.equal(res.json.groups.length, 0);
    assert.equal(res.json.exclusions.blocked_unknown_processing, 3);
  } finally {
    await booted.close();
    close();
  }
});

test('F2H-4 零方差：10 段同一暴露 ⇒ zero_variance（r 为 null，不是 0）', async () => {
  const { path, insert, close } = openDb();
  for (let i = 0; i < 10; i += 1) {
    insert({ sessionId: sid(i), conversationMs: 1000, focus: (i % 5) + 1, startTime: T0 + i * 600_000 });
  }
  const booted = await boot(path);
  try {
    const res = await post(booted.base, '/v1/correlations/read', OWNER_A_KEY, {
      schemaVersion: 'category-pearson-v1', from: T0 - 1000, to: T0 + 86_400_000, passports: passportsFor(...Array.from({ length: 10 }, (_, i) => sid(i))),
    });
    assert.equal(res.json.acceptedSessionN, 10);
    const conv = (res.json.groups[0].pairs as { category: string; score: string; n: number; r: number | null; reason: string }[])
      .find((p) => p.category === 'conversation' && p.score === 'focus');
    assert.equal(conv?.n, 10);
    assert.equal(conv?.r, null);
    assert.equal(conv?.reason, 'zero_variance');
  } finally {
    await booted.close();
    close();
  }
});

test('F2H-5 10 段不同暴露 + 不同评分 ⇒ 给出 r（且与手算一致）', async () => {
  const { path, insert, close } = openDb();
  const scores = [1, 2, 3, 4, 5, 5, 4, 3, 2, 1];
  for (let i = 0; i < 10; i += 1) {
    insert({ sessionId: sid(i), conversationMs: 100 * (i + 1), focus: scores[i], startTime: T0 + i * 600_000 });
  }
  const booted = await boot(path);
  try {
    const res = await post(booted.base, '/v1/correlations/read', OWNER_A_KEY, {
      schemaVersion: 'category-pearson-v1', from: T0 - 1000, to: T0 + 86_400_000, passports: passportsFor(...Array.from({ length: 10 }, (_, i) => sid(i))),
    });
    const conv = (res.json.groups[0].pairs as { category: string; score: string; n: number; r: number | null; reason: string }[])
      .find((p) => p.category === 'conversation' && p.score === 'focus');
    assert.equal(conv?.reason, 'ok');
    assert.ok(conv !== undefined && conv.r !== null);
    // 手算：x = 1..10 线性，y = 1,2,3,4,5,5,4,3,2,1 ⇒ 两端对称，相关系数约 0.1421（有符号）
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const mx = xs.reduce((a, b) => a + b, 0) / 10;
    const my = scores.reduce((a, b) => a + b, 0) / 10;
    let sxy = 0; let sxx = 0; let syy = 0;
    for (let i = 0; i < 10; i += 1) { sxy += (xs[i] - mx) * (scores[i] - my); sxx += (xs[i] - mx) ** 2; syy += (scores[i] - my) ** 2; }
    const expected = sxy / Math.sqrt(sxx * syy);
    assert.ok(Math.abs((conv.r as number) - expected) < 1e-12);
  } finally {
    await booted.close();
    close();
  }
});

test('F2H-6 来源不是 real / 未 ACK / revision 过期 ⇒ 全部排除（不增加 N）', async () => {
  const { path, insert, close } = openDb();
  for (let i = 0; i < 10; i += 1) insert({ sessionId: sid(i), conversationMs: 100 * (i + 1), focus: (i % 5) + 1, startTime: T0 + i * 600_000 });
  const booted = await boot(path);
  try {
    const base = { schemaVersion: 'category-pearson-v1', from: T0 - 1000, to: T0 + 86_400_000 };
    const all = Array.from({ length: 10 }, (_, i) => sid(i));
    const asFixture = await post(booted.base, '/v1/correlations/read', OWNER_A_KEY, { ...base, passports: all.map((s) => ({ sessionId: s, scoreRevision: 1, provenance: 'fixture', scoreAckObserved: true })) });
    assert.equal(asFixture.json.acceptedSessionN, 0);
    assert.equal(asFixture.json.exclusions.provenance_or_ack, 10);
    const noAck = await post(booted.base, '/v1/correlations/read', OWNER_A_KEY, { ...base, passports: all.map((s) => ({ sessionId: s, scoreRevision: 1, provenance: 'real', scoreAckObserved: false })) });
    assert.equal(noAck.json.acceptedSessionN, 0);
    const stale = await post(booted.base, '/v1/correlations/read', OWNER_A_KEY, { ...base, passports: all.map((s) => ({ sessionId: s, scoreRevision: 0, provenance: 'real', scoreAckObserved: true })) });
    assert.equal(stale.json.acceptedSessionN, 0);
    assert.equal(stale.json.exclusions.revision_stale, 10);
  } finally {
    await booted.close();
    close();
  }
});

test('F2H-7 跨 owner：别人的 session 既不被接受也不泄漏存在性（只按 owner 过滤）', async () => {
  const { path, insert, close } = openDb();
  for (let i = 0; i < 10; i += 1) insert({ sessionId: sid(i), owner: hashOf(OWNER_B_KEY), conversationMs: 100 * (i + 1), focus: (i % 5) + 1, startTime: T0 + i * 600_000 });
  const booted = await boot(path);
  try {
    const res = await post(booted.base, '/v1/correlations/read', OWNER_A_KEY, {
      schemaVersion: 'category-pearson-v1', from: T0 - 1000, to: T0 + 86_400_000,
      passports: passportsFor(...Array.from({ length: 10 }, (_, i) => sid(i))),
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.acceptedSessionN, 0);
    assert.deepEqual(res.json.groups, []);
    assert.equal(res.json.exclusions.no_passport, undefined);
  } finally {
    await booted.close();
    close();
  }
});

test('F2H-8 body 白名单：未知字段 / passport 超限 / 范围非法一律 400', async () => {
  const { path, insert, close } = openDb();
  const booted = await boot(path);
  try {
    const base = { schemaVersion: 'category-pearson-v1', from: T0 - 1000, to: T0 + 86_400_000 };
    const extra = await post(booted.base, '/v1/correlations/read', OWNER_A_KEY, { ...base, passports: [], note: 'x' });
    assert.equal(extra.status, 400);
    const badRange = await post(booted.base, '/v1/correlations/read', OWNER_A_KEY, { ...base, to: T0 - 2000, passports: [] });
    assert.equal(badRange.status, 400);
    const tooWide = await post(booted.base, '/v1/correlations/read', OWNER_A_KEY, { ...base, to: T0 + 400 * 86_400_000, passports: [] });
    assert.equal(tooWide.status, 400);
  } finally {
    await booted.close();
    close();
  }
});

function roomBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'room-index-report-v1',
    reportId: '00000000-0000-4000-8000-000000000001',
    roomId: 'study-201',
    terminalId: '11111111-1111-4111-8111-111111111111',
    terminalSeq: 1,
    sessionId: sid(1),
    generation: 0,
    firstBucket: 0,
    lastBucket: 5,
    indexVersion: 'quiet-known-v1',
    configKey: 'preproc-v2|tflite-2.16.1|map-v1|decision-v1',
    processingKey: null,
    provenance: 'real',
    passport: { sessionId: sid(1), kind: 'real', explicitCaptureObserved: true },
    aggregate: { spanMs: 30_000, quietMs: 24_000, noisyMs: 6_000, unknownMs: 0, validInferenceMs: 30_000 },
    ...over,
  };
}

test('F3H-1 measurement / fixture 来源 ⇒ 400 NON_REAL_REPORT（不进公开列表）', async () => {
  const { path, insert, close } = openDb();
  insert({ sessionId: sid(1), bucketCount: 6, quietMs: 24_000, noisyMs: 6_000, unknownMs: 0 });
  const booted = await boot(path);
  try {
    for (const provenance of ['measurement', 'fixture', 'unknown']) {
      const res = await post(booted.base, '/v1/room-index', OWNER_A_KEY, roomBody({ provenance }));
      assert.equal(res.status, 400);
      assert.equal(res.json.error.code, 'NON_REAL_REPORT');
    }
    const noPassport = await post(booted.base, '/v1/room-index', OWNER_A_KEY, roomBody({ passport: { sessionId: sid(1), kind: 'real', explicitCaptureObserved: false } }));
    assert.equal(noPassport.status, 400);
  } finally {
    await booted.close();
    close();
  }
});

test('F3H-2 服务端复算：上报聚合与只读库不一致 ⇒ 409 EVIDENCE_MISMATCH（不信客户端自报）', async () => {
  const { path, insert, close } = openDb();
  insert({ sessionId: sid(1), bucketCount: 6, quietMs: 24_000, noisyMs: 6_000, unknownMs: 0 });
  const booted = await boot(path);
  try {
    const tampered = await post(booted.base, '/v1/room-index', OWNER_A_KEY, roomBody({ aggregate: { spanMs: 30_000, quietMs: 30_000, noisyMs: 0, unknownMs: 0, validInferenceMs: 30_000 } }));
    assert.equal(tampered.status, 409);
    assert.equal(tampered.json.error.code, 'EVIDENCE_MISMATCH');
  } finally {
    await booted.close();
    close();
  }
});

test('F3H-3 房间号不符 / 跨 owner ⇒ 404；同 reportId 重试 ⇒ 原 ACK（幂等）', async () => {
  const { path, insert, close } = openDb();
  insert({ sessionId: sid(1), bucketCount: 6, quietMs: 24_000, noisyMs: 6_000, unknownMs: 0 });
  const booted = await boot(path);
  try {
    const wrongRoom = await post(booted.base, '/v1/room-index', OWNER_A_KEY, roomBody({ roomId: 'reading-101' }));
    assert.equal(wrongRoom.status, 404);
    const otherOwner = await post(booted.base, '/v1/room-index', OWNER_B_KEY, roomBody());
    assert.equal(otherOwner.status, 404);

    const first = await post(booted.base, '/v1/room-index', OWNER_A_KEY, roomBody());
    assert.equal(first.status, 200);
    assert.equal(first.json.accepted, true);
    assert.equal(first.json.quietIndex, 80);
    const retry = await post(booted.base, '/v1/room-index', OWNER_A_KEY, roomBody());
    assert.deepEqual(retry.json, first.json);

    const conflicting = await post(booted.base, '/v1/room-index', OWNER_A_KEY, roomBody({ terminalSeq: 9 }));
    assert.equal(conflicting.status, 409);
    assert.equal(conflicting.json.error.code, 'IDEMPOTENCY_CONFLICT');
  } finally {
    await booted.close();
    close();
  }
});

test('F3H-6 ★C6 canonical：分组键由服务端读回复算 ⇒ 客户端谎报 configKey 不能合组', async () => {
  const { path, insert, close } = openDb();
  insert({ sessionId: sid(1), bucketCount: 6, quietMs: 24_000, noisyMs: 6_000, unknownMs: 0 });
  // 第二个 session 的真实版本不同（decision-v2）⇒ 权威 configKey 与第一个**不可比**。
  insert({ sessionId: sid(2), bucketCount: 6, quietMs: 24_000, noisyMs: 6_000, unknownMs: 0, decisionVersion: 'decision-v2' });
  const booted = await boot(path);
  const CLAIM = 'preproc-v2|tflite-2.16.1|map-v1|decision-v1';
  const body = (n: number, terminal: string, claim: string, extra: Record<string, unknown> = {}): Record<string, unknown> => roomBody({
    reportId: `00000000-0000-4000-8000-00000000000${n}`,
    terminalId: terminal,
    sessionId: sid(n),
    passport: { sessionId: sid(n), kind: 'real', explicitCaptureObserved: true },
    configKey: claim,
    ...extra,
  });
  try {
    const first = await post(booted.base, '/v1/room-index', OWNER_A_KEY, body(1, '11111111-1111-4111-8111-111111111111', CLAIM));
    assert.equal(first.status, 200);
    // 谎报：第二个终端的真实版本是 decision-v2，却声称自己与第一个同组。
    const lie = await post(booted.base, '/v1/room-index', OWNER_A_KEY, body(2, '22222222-2222-4222-8222-222222222222', CLAIM));
    assert.equal(lie.status, 200, '谎报 configKey 不再被采信 ⇒ 报告按权威组入库（不因此被拒）');

    const rooms = await (await fetch(`${booted.base}/v1/rooms`, { headers: { 'X-Study-Key': OWNER_A_KEY } })).json() as {
      rooms: { roomId: string; status: string; reason: string | null; configKey: string | null; terminalCount: number }[];
    };
    const study = rooms.rooms.find((r) => r.roomId === 'study-201');
    // 若还用客户端声明分组，这里会合成一个 fresh 单值；权威分组下两个真实版本必须分开 ⇒ mixed_config。
    assert.equal(study?.reason, 'mixed_config', '两个真实版本不同的终端不得被谎报键并成一组');
    assert.equal(study?.status, 'unknown');
    assert.equal(study?.terminalCount, 2);

    // processingKey 是**可见的假声明**：与权威读回不符 ⇒ 明确 409，不静默吞掉。
    const badProc = await post(booted.base, '/v1/room-index', OWNER_A_KEY, body(1, '11111111-1111-4111-8111-111111111111', CLAIM, { processingKey: 'qp-proc-v1;agc=off' }));
    assert.equal(badProc.status, 409);
    assert.equal(badProc.json.error.code, 'PROCESSING_MISMATCH');
  } finally {
    await booted.close();
    close();
  }
});

test('F3H-4 GET /v1/rooms：匿名聚合（不含 terminalId / ownerHash / sessionId），未知房间照实 unknown', async () => {
  const { path, insert, close } = openDb();
  insert({ sessionId: sid(1), bucketCount: 6, quietMs: 24_000, noisyMs: 6_000, unknownMs: 0 });
  const booted = await boot(path);
  try {
    await post(booted.base, '/v1/room-index', OWNER_A_KEY, roomBody());
    const res = await fetch(`${booted.base}/v1/rooms`, { headers: { 'X-Study-Key': OWNER_A_KEY } });
    assert.equal(res.status, 200);
    const json = await res.json() as { rooms: { roomId: string; status: string; quietIndex: number | null; terminalCount: number }[] };
    assert.equal(json.rooms.length, 3);
    const study = json.rooms.find((r) => r.roomId === 'study-201');
    assert.equal(study?.status, 'fresh');
    assert.ok(Math.abs((study?.quietIndex as number) - 80) < 1e-9);
    assert.equal(study?.terminalCount, 1);
    const raw = JSON.stringify(json);
    assert.equal(raw.includes('11111111'), false);
    assert.equal(raw.includes(hashOf(OWNER_A_KEY)), false);
    assert.equal(raw.includes(sid(1)), false);
    // 未上报的房间是 unknown/no_report，值为 null。
    const empty = json.rooms.find((r) => r.roomId === 'discussion-302');
    assert.equal(empty?.status, 'unknown');
    assert.equal(empty?.quietIndex, null);
  } finally {
    await booted.close();
    close();
  }
});

test('F3H-5 当前正式桶形态（unknownMs=桶宽）⇒ 指数 null/unknown_state_coverage，不假绿', async () => {
  const { path, insert, close } = openDb();
  insert({ sessionId: sid(1), bucketCount: 6, quietMs: 0, noisyMs: 0, unknownMs: 30_000 });
  const booted = await boot(path);
  try {
    const res = await post(booted.base, '/v1/room-index', OWNER_A_KEY, roomBody({ aggregate: { spanMs: 30_000, quietMs: 0, noisyMs: 0, unknownMs: 30_000, validInferenceMs: 30_000 } }));
    assert.equal(res.status, 200);
    assert.equal(res.json.quietIndex, null);
    assert.equal(res.json.quietReason, 'unknown_state_coverage');
    const rooms = await (await fetch(`${booted.base}/v1/rooms`, { headers: { 'X-Study-Key': OWNER_A_KEY } })).json() as { rooms: { roomId: string; status: string; quietIndex: number | null; reason: string | null }[] };
    const study = rooms.rooms.find((r) => r.roomId === 'study-201');
    assert.equal(study?.quietIndex, null);
    assert.equal(study?.status, 'fresh');
    assert.equal(study?.reason, 'unknown_state_coverage');
  } finally {
    await booted.close();
    close();
  }
});
