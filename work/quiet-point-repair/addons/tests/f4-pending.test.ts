/**
 * F4 离线本地降级：有界 pending 队列 + 幂等补传（纯逻辑，注入式 send，零真实网络）。
 *
 * 对应 Sol §2.6C「最小关闭证据」的离线侧：
 *  · 无网 ⇒ 本地记录 + 明确「已本地记录，待同步」（**不假装已同步**）；
 *  · 恢复后幂等补传（重复 flush 不重复送）；可重试失败停手、永久失败标记 rejected；
 *  · 重启持久化；损坏与容量都如实计数上报。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_ONLY_MESSAGE,
  SYNCED_MESSAGE,
  createMemoryPendingStorage,
  createPendingQueue,
  localDayOf,
  type SendOutcome,
} from '../f4/pending-queue.js';

const BASE = Date.UTC(2026, 9, 5, 4, 0, 0);
let clock = BASE;
const now = (): number => clock;
const dayOf = (offsetDays: number): string => localDayOf(BASE + offsetDays * 86_400_000);

function ok(entry: { date: string }): SendOutcome {
  return { ok: true };
}
function retryable(): SendOutcome {
  return { ok: false, retryable: true, code: 'ADDONS_UNAVAILABLE' };
}
function permanent(code = 'CHECKIN_DATE_TOO_OLD'): SendOutcome {
  return { ok: false, retryable: false, code };
}

test('F4P-1 离线本地记录 ⇒ 明确「已本地记录，待同步」，绝不说已同步；同一天只记一条', () => {
  clock = BASE;
  const queue = createPendingQueue({ storage: createMemoryPendingStorage(), now });
  const first = queue.recordLocal(dayOf(0), 'study-201');
  assert.equal(first.localOnly, true);
  assert.equal(first.synced, false);
  assert.equal(first.message, LOCAL_ONLY_MESSAGE);
  assert.equal(first.entry.status, 'pending');
  // 重复点击：不产生第二条、attempts 不变、状态不变。
  const again = queue.recordLocal(dayOf(0), 'study-201');
  assert.equal(again.localOnly, true);
  assert.equal(again.entry.attempts, 0);
  assert.equal(queue.entries().length, 1);
  assert.equal(queue.status().pendingCount, 1);
  // UI 侧查询：同一天必须显示"待同步"。
  const status = queue.statusOf(dayOf(0));
  assert.equal(status.status, 'pending');
  assert.equal(status.synced, false);
  assert.equal(status.message, LOCAL_ONLY_MESSAGE);
});

test('F4P-2 联网后幂等补传：成功即 synced，再 flush 不重复送', async () => {
  clock = BASE;
  const queue = createPendingQueue({ storage: createMemoryPendingStorage(), now });
  queue.recordLocal(dayOf(-1), null);
  queue.recordLocal(dayOf(0), 'study-201');
  const sent: string[] = [];
  const report = await queue.flush(async (entry) => {
    sent.push(entry.date);
    return ok(entry);
  });
  assert.deepEqual(sent, [dayOf(-1), dayOf(0)]); // 最旧的先补
  assert.equal(report.attempted, 2);
  assert.equal(report.synced, 2);
  assert.equal(report.rejected, 0);
  assert.equal(report.remaining, 0);
  assert.equal(report.stoppedByRetryableFailure, false);
  assert.equal(queue.statusOf(dayOf(0)).synced, true);
  assert.equal(queue.statusOf(dayOf(0)).message, SYNCED_MESSAGE);
  // 第二次 flush：本地已同步的不再送（幂等）。
  const second = await queue.flush(async (entry) => {
    sent.push(entry.date);
    return ok(entry);
  });
  assert.equal(second.attempted, 0);
  assert.equal(sent.length, 2);
});

test('F4P-3 可重试失败 ⇒ 停手 + 其余保持待同步；恢复后补传成功', async () => {
  clock = BASE;
  const queue = createPendingQueue({ storage: createMemoryPendingStorage(), now });
  queue.recordLocal(dayOf(-2), null);
  queue.recordLocal(dayOf(-1), null);
  queue.recordLocal(dayOf(0), null);
  const first = await queue.flush(async () => retryable());
  assert.equal(first.attempted, 1); // 第一条就失败 ⇒ 立刻停手，不硬刷
  assert.equal(first.synced, 0);
  assert.equal(first.stoppedByRetryableFailure, true);
  assert.equal(first.remaining, 3);
  assert.equal(queue.statusOf(dayOf(-2)).status, 'pending');
  assert.equal(queue.statusOf(dayOf(-2)).attempts, 1);

  // 网络恢复 ⇒ 三条全部补传，且是幂等重试（服务端按 (date, identity) 去重）。
  let online = true;
  const resumed = await queue.flush(async (entry) => (online ? ok(entry) : retryable()));
  assert.equal(resumed.synced, 3);
  assert.equal(resumed.remaining, 0);
  assert.equal(queue.status().syncedCount, 3);
});

test('F4P-4 永久失败（服务端 400）⇒ 标记 rejected 并继续处理后面的记录', async () => {
  clock = BASE;
  const queue = createPendingQueue({ storage: createMemoryPendingStorage(), now });
  queue.recordLocal(dayOf(-2), null);
  queue.recordLocal(dayOf(0), null);
  const report = await queue.flush(async (entry) => (entry.date === dayOf(-2) ? permanent() : ok(entry)));
  assert.equal(report.attempted, 2);
  assert.equal(report.rejected, 1);
  assert.equal(report.synced, 1);
  assert.equal(report.remaining, 0);
  assert.equal(queue.statusOf(dayOf(-2)).status, 'rejected');
  assert.equal(queue.statusOf(dayOf(-2)).synced, false);
  assert.match(queue.statusOf(dayOf(-2)).message, /未能同步/);
  // 被拒绝的不会在下一轮被反复重试。
  const again = await queue.flush(async () => ({ ok: true }));
  assert.equal(again.attempted, 0);
});

test('F4P-5 send 自己抛异常 ⇒ 按可重试处理（不误判成永久失败）', async () => {
  clock = BASE;
  const queue = createPendingQueue({ storage: createMemoryPendingStorage(), now });
  queue.recordLocal(dayOf(0), null);
  const report = await queue.flush(async () => {
    throw new Error('network down');
  });
  assert.equal(report.stoppedByRetryableFailure, true);
  assert.equal(report.rejected, 0);
  assert.equal(queue.statusOf(dayOf(0)).status, 'pending');
  assert.equal(queue.statusOf(dayOf(0)).attempts, 1);
});

test('F4P-6 重启持久化：换一个 queue 实例仍读得到同一份待同步状态', async () => {
  clock = BASE;
  const storage = createMemoryPendingStorage();
  const queue = createPendingQueue({ storage, now });
  queue.recordLocal(dayOf(-1), 'reading-101');
  queue.recordLocal(dayOf(0), null);
  await queue.flush(async (entry) => (entry.date === dayOf(-1) ? ok(entry) : retryable()));

  const reopened = createPendingQueue({ storage, now });
  assert.equal(reopened.status().syncedCount, 1);
  assert.equal(reopened.status().pendingCount, 1);
  assert.equal(reopened.statusOf(dayOf(-1)).synced, true);
  assert.equal(reopened.statusOf(dayOf(0)).status, 'pending');
  assert.equal(reopened.entries().find((e) => e.date === dayOf(0))?.roomId, null);
});

test('F4P-7 有界容量：淘汰序 = 已同步 → 已拒绝 → 待同步，且计数上报（不静默丢）', async () => {
  clock = BASE;
  const queue = createPendingQueue({ storage: createMemoryPendingStorage(), now, maxEntries: 3 });
  queue.recordLocal(dayOf(-3), null);
  queue.recordLocal(dayOf(-2), null);
  queue.recordLocal(dayOf(-1), null);
  assert.equal(queue.entries().length, 3);
  // 第 4 条 ⇒ 淘汰最旧的「待同步」。
  const fourth = queue.recordLocal(dayOf(0), null);
  assert.equal(fourth.dropped.overflow, 1);
  assert.deepEqual(queue.entries().map((e) => e.date).sort(), [dayOf(-2), dayOf(-1), dayOf(0)].sort());
  assert.equal(queue.status().droppedOverflow, 1);

  // 已同步的条目优先被淘汰（服务器才是真源），待同步的最后才丢。
  const syncedDates = [dayOf(-2), dayOf(-1), dayOf(0)];
  await queue.flush(async (entry) => ok(entry));
  assert.equal(queue.status().syncedCount, 3);
  clock += 60_000;
  const overflowed = queue.recordLocal(dayOf(1), null);
  // 队列已满且全部 synced ⇒ 淘汰最旧的已同步条目。
  assert.equal(overflowed.dropped.overflow, 1);
  const remaining = queue.entries();
  assert.equal(remaining.length, 3);
  assert.equal(remaining.some((e) => e.date === syncedDates[0]), false);
  assert.equal(overflowed.entry.status, 'pending');
  assert.equal(queue.status().droppedOverflow, 2);
});

test('F4P-8 过期：超出补传窗口的日期不入队冒充待同步，计数 droppedExpired', () => {
  clock = BASE;
  const queue = createPendingQueue({ storage: createMemoryPendingStorage(), now, ttlDays: 7 });
  const stale = queue.recordLocal(dayOf(-10), null);
  assert.equal(stale.localOnly, true);
  assert.equal(stale.synced, false);
  assert.equal(stale.entry.status, 'rejected');
  assert.equal(stale.entry.lastError, 'CHECKIN_DATE_TOO_OLD');
  assert.equal(stale.dropped.expired, 1);
  assert.equal(queue.status().pendingCount, 0);
  assert.equal(queue.status().droppedExpired, 1);
  assert.match(stale.message, /超出 7 天同步窗口/);
  // 恰好第 7 天仍可排队补传。
  const boundary = queue.recordLocal(dayOf(-7), null);
  assert.equal(boundary.entry.status, 'pending');
  assert.equal(boundary.message, LOCAL_ONLY_MESSAGE);
});

test('F4P-9 本地存档损坏 ⇒ 如实上报并重新开始（不静默假装什么都没发生）', () => {
  clock = BASE;
  const queue = createPendingQueue({ storage: createMemoryPendingStorage({ schemaVersion: 99, entries: 'nope' }), now });
  assert.equal(queue.status().corrupted, true);
  assert.ok((queue.status().corruptedReason ?? '').length > 0);
  const recorded = queue.recordLocal(dayOf(0), null);
  assert.equal(recorded.recoveredFromCorruption !== null, true);
  assert.equal(recorded.entry.status, 'pending');
  assert.equal(queue.status().pendingCount, 1);
  // 从空开始，不会把坏数据里的条目当真的。
  assert.equal(queue.entries().length, 1);
});
