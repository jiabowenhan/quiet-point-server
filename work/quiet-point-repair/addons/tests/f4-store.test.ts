/**
 * F4 打卡存储（有界 JSON，零 SQLite 新表）：幂等、跨日/断日、跨午夜、时钟异常、回补窗口、
 * 重启持久化、损坏缺证、容量上限。
 *
 * 对应 Sol §2.6C「最小关闭证据」的存储侧：同日幂等、跨日/断日 streak、双身份隔离、异 body 冲突、
 * 进程重启持久化、损坏/容量处理。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_BACKFILL_DAYS, MOTTOS, mottoFor } from '../f4/contract.js';
import { CheckinStore, MAX_DATES_PER_DEVICE, MAX_DEVICES } from '../f4/store.js';
import { DataStoreError } from '../shared/atomic-json.js';

/** 固定「服务端今天」= 2026-10-05（Asia/Shanghai 正午）。 */
const NOON_1005 = Date.UTC(2026, 9, 5, 4, 0, 0);
let clock = NOON_1005;
const now = (): number => clock;

const OWNER_A = 'a'.repeat(64);
const OWNER_B = 'b'.repeat(64);

function freshStore(): { store: CheckinStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'f4-store-'));
  clock = NOON_1005;
  return { store: new CheckinStore({ filePath: join(dir, 'checkin-v1.json'), now }), file: join(dir, 'checkin-v1.json') };
}

function dayAt(offsetDays: number): string {
  const base = Date.UTC(2026, 9, 5, 4, 0, 0) + offsetDays * 86_400_000;
  return new Date(base).toISOString().slice(0, 10);
}

test('F4S-1 同日重复打卡 ⇒ 幂等：原 serverSeq / 原时间、streak 不重复增长', () => {
  const { store } = freshStore();
  const first = store.checkin({ owner: OWNER_A, date: '2026-10-05', roomId: 'study-201' });
  assert.equal(first.accepted, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.serverSeq, 1);
  assert.equal(first.serverReceivedAt, NOON_1005);
  assert.equal(first.streak, 1);
  assert.equal(first.currentStreak, 1);

  clock += 60_000;
  const retry = store.checkin({ owner: OWNER_A, date: '2026-10-05', roomId: 'study-201' });
  assert.equal(retry.accepted, true);
  assert.equal(retry.duplicate, true);
  // 不分配新序号、不刷新时间（幂等语义）。
  assert.equal(retry.serverSeq, first.serverSeq);
  assert.equal(retry.serverReceivedAt, first.serverReceivedAt);
  // 除 duplicate 标记外，两次响应逐字相同 ⇒ 没有隐藏的"第二次增长"。
  const { duplicate: d1, ...rest1 } = first;
  const { duplicate: d2, ...rest2 } = retry;
  assert.equal(d1, false);
  assert.equal(d2, true);
  assert.deepEqual(rest2, rest1);
  // 只留一条记录，高水位仍是 1。
  assert.deepEqual(store.listDates(OWNER_A), ['2026-10-05']);
  assert.equal(store.status().serverSeqHighWater, 1);
});

test('F4S-2 同一天同一身份但房间不同 ⇒ 409 IDEMPOTENCY_CONFLICT（异 body 冲突）', () => {
  const { store } = freshStore();
  store.checkin({ owner: OWNER_A, date: '2026-10-05', roomId: 'study-201' });
  assert.throws(
    () => store.checkin({ owner: OWNER_A, date: '2026-10-05', roomId: 'reading-101' }),
    (err: unknown) => err instanceof DataStoreError && err.code === 'IDEMPOTENCY_CONFLICT',
  );
  // null 与 '' 也是不同内容（这里空串不可达，用 null 对照）。
  assert.throws(
    () => store.checkin({ owner: OWNER_A, date: '2026-10-05', roomId: null }),
    (err: unknown) => err instanceof DataStoreError && err.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('F4S-3 跨日连续 / 断档重置 / 当天未打卡仍保留可续段', () => {
  const { store } = freshStore();
  const a1 = store.checkin({ owner: OWNER_A, date: dayAt(-2), roomId: null });
  assert.equal(a1.streak, 1);
  clock += 1000;
  const a2 = store.checkin({ owner: OWNER_A, date: dayAt(-1), roomId: null });
  assert.equal(a2.streak, 2);
  clock += 1000;
  const a3 = store.checkin({ owner: OWNER_A, date: dayAt(0), roomId: null });
  assert.equal(a3.streak, 3);
  assert.equal(a3.currentStreak, 3);
  assert.equal(a3.mottoIndex, mottoFor(3).index);
  assert.equal(a3.motto, MOTTOS[mottoFor(3).index]);
  assert.equal(a3.backfilled, false);

  // 跨到第二天，当天没打卡 ⇒ 观察值是"昨天的 3"（今天还能续上）。
  clock += 86_400_000;
  const view = store.today(OWNER_A, dayAt(1));
  assert.equal(view.checkedIn, false);
  assert.equal(view.streak, 3);
  assert.equal(view.lastCheckinDate, dayAt(0));

  // 断两天 ⇒ 归零（不是把旧的搬过来）。
  clock += 86_400_000;
  assert.equal(store.today(OWNER_A, dayAt(2)).streak, 0);

  // 断档后重新开始 ⇒ streak 从 1 起。
  clock += 1000;
  const restart = store.checkin({ owner: OWNER_A, date: dayAt(2), roomId: null });
  assert.equal(restart.streak, 1);
  assert.equal(restart.currentStreak, 1);
});

test('F4S-4 跨午夜：23:59:59 与 00:00:01 分属两个日界，连成 2 天', () => {
  const dir = mkdtempSync(join(tmpdir(), 'f4-midnight-'));
  const file = join(dir, 'checkin-v1.json');
  // 2026-10-05 23:59:59 +08 == UTC 15:59:59
  clock = Date.UTC(2026, 9, 5, 15, 59, 59);
  const store = new CheckinStore({ filePath: file, now });
  const before = store.checkin({ owner: OWNER_A, date: '2026-10-05', roomId: null });
  assert.equal(before.streak, 1);
  assert.equal(before.serverToday, '2026-10-05');

  // 2026-10-06 00:00:01 +08 == UTC 16:00:01（同一 UTC 日，但上海已换日）
  clock = Date.UTC(2026, 9, 5, 16, 0, 1);
  const after = store.checkin({ owner: OWNER_A, date: '2026-10-06', roomId: null });
  assert.equal(after.serverToday, '2026-10-06');
  assert.equal(after.streak, 2);
  assert.equal(after.backfilled, false);
  assert.deepEqual(store.listDates(OWNER_A), ['2026-10-05', '2026-10-06']);
});

test('F4S-5 设备时钟异常：未来日期明确拒绝；回补窗口边界确定', () => {
  const { store } = freshStore();
  // 未来（设备时钟快）⇒ 400 语义，不静默改成今天。
  assert.throws(
    () => store.checkin({ owner: OWNER_A, date: '2026-10-06', roomId: null }),
    (err: unknown) => err instanceof DataStoreError && err.code === 'CHECKIN_DATE_FUTURE',
  );
  assert.throws(
    () => store.checkin({ owner: OWNER_A, date: '2030-01-01', roomId: null }),
    (err: unknown) => err instanceof DataStoreError && err.code === 'CHECKIN_DATE_FUTURE',
  );
  // 超出回补窗口 ⇒ 明确拒绝（不是静默丢弃）。
  assert.throws(
    () => store.checkin({ owner: OWNER_A, date: dayAt(-(MAX_BACKFILL_DAYS + 1)), roomId: null }),
    (err: unknown) => err instanceof DataStoreError && err.code === 'CHECKIN_DATE_TOO_OLD',
  );
  // 恰好第 7 天 ⇒ 接受，并标记为回补。
  const boundary = store.checkin({ owner: OWNER_A, date: dayAt(-MAX_BACKFILL_DAYS), roomId: null });
  assert.equal(boundary.backfilled, true);
  assert.equal(boundary.date, dayAt(-MAX_BACKFILL_DAYS));
  assert.equal(boundary.streak, 1);
  // 回补不会把服务端的"今天"洗成已打卡。
  const today = store.today(OWNER_A, dayAt(0));
  assert.equal(today.checkedIn, false);
  assert.equal(today.lastCheckinDate, dayAt(-MAX_BACKFILL_DAYS));
});

test('F4S-6 回补连续段：补上中间断掉的那天，streak 由唯一日期集合重算', () => {
  const { store } = freshStore();
  store.checkin({ owner: OWNER_A, date: dayAt(-2), roomId: null });
  store.checkin({ owner: OWNER_A, date: dayAt(0), roomId: null });
  assert.equal(store.today(OWNER_A, dayAt(0)).streak, 1);
  assert.equal(store.today(OWNER_A, dayAt(0)).longestStreak, 1);
  // 补 −1 天 ⇒ 三段连起来变成 3。
  const bridge = store.checkin({ owner: OWNER_A, date: dayAt(-1), roomId: null });
  assert.equal(bridge.streak, 2);
  assert.equal(bridge.currentStreak, 3);
  assert.equal(store.today(OWNER_A, dayAt(0)).longestStreak, 3);
});

test('F4S-7 双身份隔离：A 看不到 B 的记录，序号同一高水位但互不可见', () => {
  const { store } = freshStore();
  store.checkin({ owner: OWNER_A, date: '2026-10-05', roomId: 'study-201' });
  const b = store.checkin({ owner: OWNER_B, date: '2026-10-05', roomId: 'reading-101' });
  assert.equal(b.streak, 1);
  assert.deepEqual(store.listDates(OWNER_A), ['2026-10-05']);
  assert.equal(store.today(OWNER_B, '2026-10-05').roomId, 'reading-101');
  assert.equal(store.today(OWNER_A, '2026-10-05').roomId, 'study-201');
  // B 未打卡的日子里，A 的连续段不受影响。
  clock += 86_400_000;
  assert.equal(store.today(OWNER_A, dayAt(1)).streak, 1);
  assert.equal(store.today(OWNER_B, dayAt(1)).streak, 1);
});

test('F4S-8 重启：高水位与日期集合从持久快照恢复（不回退、不重复）', () => {
  const { store, file } = freshStore();
  store.checkin({ owner: OWNER_A, date: dayAt(-1), roomId: null });
  clock += 1000;
  store.checkin({ owner: OWNER_A, date: dayAt(0), roomId: null });
  assert.equal(store.status().serverSeqHighWater, 2);

  const reopened = new CheckinStore({ filePath: file, now });
  assert.equal(reopened.status().corrupted, false);
  assert.deepEqual(reopened.listDates(OWNER_A), [dayAt(-1), dayAt(0)]);
  assert.equal(reopened.today(OWNER_A, dayAt(0)).streak, 2);
  // 重启后重复提交同一天仍是幂等（不是新记录）。
  const retry = reopened.checkin({ owner: OWNER_A, date: dayAt(0), roomId: null });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.serverSeq, 2);
  // 新的一天照常推进序号。
  clock += 86_400_000;
  const next = reopened.checkin({ owner: OWNER_A, date: dayAt(1), roomId: null });
  assert.equal(next.serverSeq, 3);
});

test('F4S-9 损坏 ⇒ 缺证：打卡拒绝、today 返回 checkedIn=null（不谎称没打卡），原文件不被覆盖', () => {
  const dir = mkdtempSync(join(tmpdir(), 'f4-corrupt-'));
  const file = join(dir, 'checkin-v1.json');
  writeFileSync(file, '{ this is not json', 'utf8');
  const before = readFileSync(file, 'utf8');
  const store = new CheckinStore({ filePath: file, now });
  assert.equal(store.isCorrupted(), true);
  assert.equal(store.status().corrupted, true);
  assert.throws(
    () => store.checkin({ owner: OWNER_A, date: dayAt(0), roomId: null }),
    (err: unknown) => err instanceof DataStoreError && err.code === 'STORE_UNAVAILABLE',
  );
  const view = store.today(OWNER_A, dayAt(0));
  assert.equal(view.checkedIn, null);
  assert.equal(view.streak, null);
  assert.equal(view.motto, null);
  assert.equal(view.storeCorrupted, true);
  assert.equal(view.reason, 'store_corrupted');
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('F4S-10 保留窗口：超出 180 天的查询 ⇒ checkedIn=null / out_of_retention（不假装"没打卡"）', () => {
  const { store } = freshStore();
  store.checkin({ owner: OWNER_A, date: dayAt(-1), roomId: null });
  const recent = store.today(OWNER_A, dayAt(-1));
  assert.equal(recent.checkedIn, true);
  const ancient = store.today(OWNER_A, dayAt(-400));
  assert.equal(ancient.checkedIn, null);
  assert.equal(ancient.streak, null);
  assert.equal(ancient.reason, 'out_of_retention');
});

test('F4S-11 容量：设备数上限明确报错；每设备保留上限按最新日期裁剪', () => {
  const { store } = freshStore();
  for (let i = 0; i < MAX_DEVICES; i += 1) {
    store.checkin({ owner: `${String(i).padStart(2, '0')}${'c'.repeat(62)}`, date: dayAt(0), roomId: null });
  }
  assert.equal(store.status().deviceCount, MAX_DEVICES);
  assert.throws(
    () => store.checkin({ owner: 'z'.repeat(64), date: dayAt(0), roomId: null }),
    (err: unknown) => err instanceof DataStoreError && err.code === 'STORE_CAPACITY',
  );

  // 每设备上限：连续 181 天逐日打卡（每天都是"当天打卡"，合法路径）⇒ 裁剪后保留最新 180 天。
  const dir = mkdtempSync(join(tmpdir(), 'f4-cap-'));
  clock = NOON_1005;
  const bulk = new CheckinStore({ filePath: join(dir, 'checkin-v1.json'), now });
  for (let i = 0; i <= MAX_DATES_PER_DEVICE; i += 1) {
    clock = NOON_1005 + i * 86_400_000;
    bulk.checkin({ owner: OWNER_A, date: dayAt(i), roomId: null });
  }
  const dates = bulk.listDates(OWNER_A);
  assert.equal(dates.length, MAX_DATES_PER_DEVICE);
  assert.equal(dates[0], dayAt(1));
  assert.equal(dates[dates.length - 1], dayAt(MAX_DATES_PER_DEVICE));
  // 裁剪只影响最旧的那天，剩下的连续段仍完整可复算。
  assert.equal(bulk.today(OWNER_A, dayAt(MAX_DATES_PER_DEVICE)).streak, MAX_DATES_PER_DEVICE);
});
