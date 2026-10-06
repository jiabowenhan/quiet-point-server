/**
 * F3 存储一致性最小测试（Sol §1D⑤ 第 3/6 行）：
 *  · 同 reportId 同 body ⇒ 返回**原** ACK / 原 serverSeq / 原时间（重试不刷新新鲜度，不增序号）；
 *  · 同 ID 异 body ⇒ 409；
 *  · terminalSeq / 窗口回退 ⇒ 明确 stale 状态且**不覆盖**；
 *  · 重启从持久高水位恢复，不重复分配也不回退；
 *  · 主 JSON 损坏 ⇒ unknown 并停止接受（**不创建空快照谎称成功**）；
 *  · 每 owner 每房间 8 活跃 terminal 上限明确报错。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QUIET_INDEX_VERSION, type RoomAggregate } from '../f3/contract.js';
import { MAX_TERMINALS_PER_ROOM, RoomIndexStore, StoreError } from '../f3/store.js';
import type { RoomReport } from '../f3/contract.js';

let clock = 1_760_000_000_000;
const now = (): number => clock;

/** 默认 = 一个合格 30 s 窗口（quiet 24 s / noisy 6 s ⇒ 指数 80）。 */
function agg(over: Partial<RoomAggregate> = {}): RoomAggregate {
  const quietMs = over.quietMs ?? 24_000;
  const noisyMs = over.noisyMs ?? 6_000;
  const unknownMs = over.unknownMs ?? 0;
  return { spanMs: over.spanMs ?? 30_000, quietMs, noisyMs, unknownMs, validInferenceMs: over.validInferenceMs ?? 30_000 };
}

let idSeq = 0;
function uuid(): string {
  idSeq += 1;
  const tail = String(idSeq).padStart(12, '0');
  return `00000000-0000-4000-8000-${tail}`;
}

function dto(over: Partial<RoomReport> = {}): RoomReport {
  return {
    schemaVersion: 'room-index-report-v1',
    reportId: uuid(),
    roomId: 'study-201',
    terminalId: '11111111-1111-4111-8111-111111111111',
    terminalSeq: 1,
    sessionId: '22222222-2222-4222-8222-222222222222',
    generation: 0,
    firstBucket: 0,
    lastBucket: 5,
    indexVersion: QUIET_INDEX_VERSION,
    configKey: 'preproc-v2|tflite-2.16.1|map-v1|decision-v1',
    processingKey: 'qp-proc-v1;agc=off;ch=1;ec=off;fs=16000;ns=off',
    provenance: 'real',
    passport: { sessionId: '22222222-2222-4222-8222-222222222222', kind: 'real', explicitCaptureObserved: true },
    aggregate: agg(),
    ...over,
  };
}

function freshStore(): { store: RoomIndexStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'f3-store-'));
  const file = join(dir, 'room-index-v1.json');
  clock = 1_760_000_000_000;
  return { store: new RoomIndexStore({ filePath: file, now }), file };
}

function accept(store: RoomIndexStore, over: Partial<RoomReport> = {}, evidenceOffsetS = 5): ReturnType<RoomIndexStore['accept']> {
  const report = dto(over);
  return store.accept({
    owner: 'owner-a',
    dto: report,
    aggregate: report.aggregate,
    evidenceReceivedAt: clock - evidenceOffsetS * 1000,
    evidenceEndAt: clock - evidenceOffsetS * 1000,
    receivedAt: clock,
  });
}

/** 用**同一个** reportId 发两次（幂等重试）；`accept()` 每次都会新生成 reportId，故这里显式给。 */
function acceptSame(store: RoomIndexStore, report: RoomReport, evidenceOffsetS = 5): ReturnType<RoomIndexStore['accept']> {
  return store.accept({
    owner: 'owner-a',
    dto: report,
    aggregate: report.aggregate,
    evidenceReceivedAt: clock - evidenceOffsetS * 1000,
    evidenceEndAt: clock - evidenceOffsetS * 1000,
    receivedAt: clock,
  });
}

test('F3-13 同 reportId 同 body 重试：返回原 ACK（原 serverSeq / 原时间），不增序号', () => {
  const { store } = freshStore();
  const report = dto();
  const first = acceptSame(store, report);
  clock += 60_000;
  const retry = acceptSame(store, report);
  assert.deepEqual(retry, first);
  assert.equal(retry.serverSeq, 1);
  assert.equal(store.status().serverSeqHighWater, 1);
  // 重试不刷新新鲜度：evidenceEndAt 仍是第一次的值。
  assert.equal(retry.evidenceEndAt, first.evidenceEndAt);
  // 且没有新增去重条目/终端条目。
  const { rooms } = store.listRooms(clock);
  assert.equal(rooms.find((r) => r.roomId === 'study-201')?.terminalCount, 1);
});

test('F3-14 同 reportId 异 body ⇒ IDEMPOTENCY_CONFLICT', () => {
  const { store } = freshStore();
  const report = dto();
  const base = { owner: 'owner-a', dto: report, aggregate: report.aggregate, evidenceReceivedAt: clock, evidenceEndAt: clock, receivedAt: clock };
  store.accept(base);
  const changed = { ...report, terminalSeq: 2, aggregate: agg({ quietMs: 1_000, noisyMs: 29_000 }) };
  assert.throws(
    () => store.accept({ ...base, dto: changed, aggregate: changed.aggregate }),
    (err: unknown) => err instanceof StoreError && err.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('F3-15 terminalSeq 回退 ⇒ 明确 stale 且不覆盖最新报告', () => {
  const { store } = freshStore();
  const good = accept(store, { terminalSeq: 5, lastBucket: 11 });
  clock += 5_000;
  const regressed = accept(store, { terminalSeq: 3, lastBucket: 17 });
  assert.equal(regressed.accepted, false);
  assert.equal(regressed.stale, true);
  assert.equal(regressed.reason, 'terminal_seq_regression');
  assert.equal(regressed.serverSeq, good.serverSeq);
  const rooms = store.listRooms(clock).rooms;
  const study = rooms.find((r) => r.roomId === 'study-201');
  assert.equal(study?.serverSeq, good.serverSeq);
});

test('F3-16 同 session 的窗口回退（lastBucket 变小）⇒ stale 且不覆盖', () => {
  const { store } = freshStore();
  accept(store, { terminalSeq: 1, lastBucket: 20, firstBucket: 15 });
  clock += 5_000;
  const back = accept(store, { terminalSeq: 2, lastBucket: 10, firstBucket: 5 });
  assert.equal(back.stale, true);
  assert.equal(back.reason, 'window_regression');
});

test('F3-17 重启：serverSeq 从持久高水位继续（不回退、不重复）', () => {
  const { store, file } = freshStore();
  accept(store, { terminalSeq: 1 });
  clock += 5_000;
  accept(store, { terminalSeq: 2, lastBucket: 11, firstBucket: 6 });
  assert.equal(store.status().serverSeqHighWater, 2);

  const reopened = new RoomIndexStore({ filePath: file, now });
  assert.equal(reopened.status().serverSeqHighWater, 2);
  const third = accept(reopened, { terminalSeq: 3, lastBucket: 17, firstBucket: 12 });
  assert.equal(third.serverSeq, 3);
});

test('F3-18 主 JSON 损坏 ⇒ unknown + 停止接受；绝不写空快照谎称成功', () => {
  const dir = mkdtempSync(join(tmpdir(), 'f3-corrupt-'));
  const file = join(dir, 'room-index-v1.json');
  writeFileSync(file, '{ this is not json', 'utf8');
  const before = readFileSync(file, 'utf8');
  const store = new RoomIndexStore({ filePath: file, now });
  assert.equal(store.isCorrupted(), true);
  const listed = store.listRooms(clock);
  assert.equal(listed.corrupted, true);
  assert.equal(listed.rooms.length, 0);
  assert.throws(
    () => accept(store),
    (err: unknown) => err instanceof StoreError && err.code === 'STORE_UNAVAILABLE',
  );
  // 原文件字节**未被覆盖**（没有创建"成功"的空快照）。
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(existsSync(`${file}.tmp`), false);
});

test('F3-19 两房间 / 两 terminal：房间聚合与终端数正确，且不泄露身份字段', () => {
  const { store } = freshStore();
  accept(store, { terminalId: '11111111-1111-4111-8111-111111111111', terminalSeq: 1, roomId: 'study-201', aggregate: agg({ spanMs: 30_000, quietMs: 22_500, noisyMs: 7_500, validInferenceMs: 30_000 }) });
  clock += 5_000;
  accept(store, { terminalId: '33333333-3333-4333-8333-333333333333', terminalSeq: 1, roomId: 'study-201', aggregate: agg({ spanMs: 30_000, quietMs: 9_000, noisyMs: 21_000, validInferenceMs: 30_000 }) });
  clock += 5_000;
  accept(store, { terminalId: '44444444-4444-4444-8444-444444444444', terminalSeq: 1, roomId: 'reading-101' });
  const { rooms } = store.listRooms(clock);
  const study = rooms.find((r) => r.roomId === 'study-201');
  assert.equal(study?.terminalCount, 2);
  assert.ok(Math.abs((study?.quietIndex as number) - 52.5) < 1e-9);
  const reading = rooms.find((r) => r.roomId === 'reading-101');
  assert.equal(reading?.quietIndex, 80);
  const json = JSON.stringify(rooms);
  assert.equal(json.includes('11111111'), false);
  assert.equal(json.includes('owner-a'), false);
});

test('F3-20 每 owner 每房间活跃 terminal 上限 8：第 9 个明确报错', () => {
  const { store } = freshStore();
  for (let i = 0; i < MAX_TERMINALS_PER_ROOM; i += 1) {
    clock += 1_000;
    accept(store, { terminalId: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`, terminalSeq: 1 });
  }
  clock += 1_000;
  assert.throws(
    () => accept(store, { terminalId: '99999999-9999-4999-8999-999999999999', terminalSeq: 1 }),
    (err: unknown) => err instanceof StoreError && err.code === 'STORE_CAPACITY',
  );
});

test('F3-21 accepted 的 ACK 是服务端生成的时间/序号，且 stale=false 时状态为 fresh', () => {
  const { store } = freshStore();
  const ack = accept(store);
  assert.equal(ack.accepted, true);
  assert.equal(ack.stale, false);
  assert.equal(ack.status, 'fresh');
  assert.equal(ack.serverSeq, 1);
  assert.equal(ack.serverReceivedAt, clock);
  assert.equal(ack.indexVersion, QUIET_INDEX_VERSION);
  assert.equal(ack.quietIndex, 80);
});

test('F3-22 未来证据时刻（时钟回拨）⇒ ACK 状态 unknown，不装 fresh', () => {
  const { store } = freshStore();
  const report = dto();
  const ack = store.accept({
    owner: 'owner-a',
    dto: report,
    aggregate: report.aggregate,
    evidenceReceivedAt: clock + 60_000,
    evidenceEndAt: clock + 60_000,
    receivedAt: clock,
  });
  assert.equal(ack.status, 'unknown');
  assert.ok((ack.ageSeconds ?? 0) < 0);
});
