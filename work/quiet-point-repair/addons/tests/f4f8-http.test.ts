/**
 * F4 / F8-c 真实 HTTP 端到端（真实 express + 真实 fetch + 真实独立有界 JSON）：
 *  · F4：同日幂等、异 body 冲突、跨日/断日 streak、双身份隔离、时钟异常与回补窗口、
 *    **无网 → pending → 恢复后幂等补传且 ACK 与 GET 同值**；
 *  · F8-c：双向 opt-in、房间级粗档、TTL 过期、随时可关、无身份泄漏；
 *  · 两条功能共用同一个 3002 附加服务，但**各自独立**的有界存储（互不污染）。
 *
 * 本文件不读旧库内容（F4/F8 都不碰 quiet.sqlite）；旧库路径仅作为 F2/F3 路由的形参传入。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createAddonApp } from '../main.js';
import { createMemoryPendingStorage, createPendingQueue } from '../f4/pending-queue.js';
import { PRESENCE_TTL_MS } from '../f8/contract.js';

const OWNER_A_KEY = 'A'.repeat(24);
const OWNER_B_KEY = 'B'.repeat(24);
/** 2026-10-05 12:00 +08。 */
const T0 = Date.UTC(2026, 9, 5, 4, 0, 0);

interface Booted {
  base: string;
  close: () => Promise<void>;
  files: { checkin: string; presence: string; roomIndex: string };
}

let clock = T0;
const now = (): number => clock;

async function boot(): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), 'f4f8-http-'));
  const checkin = join(dir, 'checkin-v1.json');
  const presence = join(dir, 'presence-v1.json');
  const roomIndex = join(dir, 'room-index-v1.json');
  const { app } = createAddonApp({ dbPath: join(dir, 'quiet.sqlite'), roomIndexFile: roomIndex, checkinFile: checkin, presenceFile: presence, now });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    files: { checkin, presence, roomIndex },
  };
}

async function call(base: string, path: string, key: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method: init.method,
    headers: init.body === undefined
      ? { 'X-Study-Key': key }
      : { 'Content-Type': 'application/json', 'X-Study-Key': key },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const post = (base: string, path: string, key: string, body: unknown) => call(base, path, key, { method: 'POST', body });
const get = (base: string, path: string, key: string) => call(base, path, key, { method: 'GET' });

const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 'checkin-report-v1',
  date: '2026-10-05',
  ...over,
});

test('F4H-1 缺 key / 非法 key ⇒ 401（沿用既有匿名鉴权语义，未新增鉴权路径）', async () => {
  clock = T0;
  const booted = await boot();
  try {
    const noKey = await fetch(`${booted.base}/v1/checkin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(noKey.status, 401);
    const badKey = await post(booted.base, '/v1/checkin', 'short', body());
    assert.equal(badKey.status, 401);
    assert.equal(badKey.json.error.code, 'STUDY_KEY_INVALID');
    const todayNoKey = await fetch(`${booted.base}/v1/checkin/today`);
    assert.equal(todayNoKey.status, 401);
  } finally {
    await booted.close();
  }
});

test('F4H-2 真实 HTTP 打卡：同日重复幂等（同 serverSeq），POST 与 GET /today 同值', async () => {
  clock = T0;
  const booted = await boot();
  try {
    const first = await post(booted.base, '/v1/checkin', OWNER_A_KEY, body({ roomId: 'study-201', streak: 99 }));
    assert.equal(first.status, 200);
    assert.equal(first.json.accepted, true);
    assert.equal(first.json.duplicate, false);
    assert.equal(first.json.streak, 1);
    // 客户端自报 streak=99 **不作真源**。
    assert.equal(first.json.currentStreak, 1);
    assert.equal(first.json.serverToday, '2026-10-05');
    assert.equal(first.json.serverSeq, 1);

    clock += 30_000;
    const retry = await post(booted.base, '/v1/checkin', OWNER_A_KEY, body({ roomId: 'study-201' }));
    assert.equal(retry.status, 200);
    assert.equal(retry.json.duplicate, true);
    assert.equal(retry.json.serverSeq, 1);
    assert.equal(retry.json.serverReceivedAt, first.json.serverReceivedAt);
    assert.equal(retry.json.currentStreak, 1);

    const today = await get(booted.base, '/v1/checkin/today', OWNER_A_KEY);
    assert.equal(today.status, 200);
    assert.equal(today.json.checkedIn, true);
    assert.equal(today.json.streak, first.json.currentStreak);
    assert.equal(today.json.mottoIndex, first.json.mottoIndex);
    assert.equal(today.json.motto, first.json.motto);
    assert.equal(today.json.roomId, 'study-201');
    assert.equal(today.json.serverSeq, 1);
    assert.equal(today.json.storeCorrupted, false);
  } finally {
    await booted.close();
  }
});

test('F4H-3 异 body 冲突 ⇒ 409；未声明字段（deviceId 等）⇒ 400，换 ID 冒充不了别人', async () => {
  clock = T0;
  const booted = await boot();
  try {
    assert.equal((await post(booted.base, '/v1/checkin', OWNER_A_KEY, body({ roomId: 'study-201' }))).status, 200);
    const conflict = await post(booted.base, '/v1/checkin', OWNER_A_KEY, body({ roomId: 'reading-101' }));
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error.code, 'IDEMPOTENCY_CONFLICT');
    for (const field of ['deviceId', 'anonymousId', 'owner', 'terminalId']) {
      const res = await post(booted.base, '/v1/checkin', OWNER_A_KEY, body({ [field]: 'x' }));
      assert.equal(res.status, 400, `字段 ${field} 应被拒`);
      assert.equal(res.json.error.code, 'VALIDATION_FAILED');
    }
    // 非法日期/房间号同样 400。
    assert.equal((await post(booted.base, '/v1/checkin', OWNER_A_KEY, body({ date: '2026-02-30' }))).status, 400);
    assert.equal((await post(booted.base, '/v1/checkin', OWNER_A_KEY, body({ roomId: 'nowhere' }))).status, 400);
  } finally {
    await booted.close();
  }
});

test('F4H-4 跨日连续 3 天 + 断档重置，GET 指定日期与今日各自复算', async () => {
  clock = T0;
  const booted = await boot();
  try {
    const day = (offset: number): string => new Date(T0 + offset * 86_400_000).toISOString().slice(0, 10);
    for (let i = 0; i < 3; i += 1) {
      clock = T0 + i * 86_400_000;
      const res = await post(booted.base, '/v1/checkin', OWNER_A_KEY, body({ date: day(i) }));
      assert.equal(res.status, 200);
      assert.equal(res.json.streak, i + 1);
    }
    // 跳过一天（第 3 天不打卡）后再看：仍是可续的 3。
    clock = T0 + 3 * 86_400_000;
    const gap = await get(booted.base, '/v1/checkin/today', OWNER_A_KEY);
    assert.equal(gap.json.checkedIn, false);
    assert.equal(gap.json.streak, 3);
    assert.equal(gap.json.lastCheckinDate, day(2));
    // 指定日期查询仍能拿到当天的真实状态。
    const dayTwo = await get(booted.base, `/v1/checkin/today?date=${day(2)}`, OWNER_A_KEY);
    assert.equal(dayTwo.json.checkedIn, true);
    assert.equal(dayTwo.json.streak, 3);
    // 断档两天 ⇒ 归零；重新打卡从 1 起。
    clock = T0 + 5 * 86_400_000;
    assert.equal((await get(booted.base, '/v1/checkin/today', OWNER_A_KEY)).json.streak, 0);
    clock = T0 + 6 * 86_400_000;
    const restart = await post(booted.base, '/v1/checkin', OWNER_A_KEY, body({ date: day(6) }));
    assert.equal(restart.json.streak, 1);
  } finally {
    await booted.close();
  }
});

test('F4H-5 双身份隔离：A 的打卡不影响 B 的今日状态', async () => {
  clock = T0;
  const booted = await boot();
  try {
    await post(booted.base, '/v1/checkin', OWNER_A_KEY, body({ roomId: 'study-201' }));
    const b = await get(booted.base, '/v1/checkin/today', OWNER_B_KEY);
    assert.equal(b.status, 200);
    assert.equal(b.json.checkedIn, false);
    assert.equal(b.json.streak, 0);
    assert.equal(b.json.lastCheckinDate, null);
    const bPost = await post(booted.base, '/v1/checkin', OWNER_B_KEY, body({ roomId: 'reading-101' }));
    assert.equal(bPost.json.streak, 1);
    // 两边各自的房间互不串。
    assert.equal((await get(booted.base, '/v1/checkin/today', OWNER_A_KEY)).json.roomId, 'study-201');
    assert.equal((await get(booted.base, '/v1/checkin/today', OWNER_B_KEY)).json.roomId, 'reading-101');
  } finally {
    await booted.close();
  }
});

test('F4H-6 设备时钟异常：未来日期 400 CHECKIN_DATE_FUTURE；超回补窗口 400 CHECKIN_DATE_TOO_OLD', async () => {
  clock = T0;
  const booted = await boot();
  try {
    const future = await post(booted.base, '/v1/checkin', OWNER_A_KEY, body({ date: '2026-10-06' }));
    assert.equal(future.status, 400);
    assert.equal(future.json.error.code, 'CHECKIN_DATE_FUTURE');
    const ancient = await post(booted.base, '/v1/checkin', OWNER_A_KEY, body({ date: '2026-09-20' }));
    assert.equal(ancient.status, 400);
    assert.equal(ancient.json.error.code, 'CHECKIN_DATE_TOO_OLD');
    // 恰好第 7 天可回补，且明确标记 backfilled。
    const edge = await post(booted.base, '/v1/checkin', OWNER_A_KEY, body({ date: '2026-09-28' }));
    assert.equal(edge.status, 200);
    assert.equal(edge.json.backfilled, true);
    // GET 未来日期同样 400；非法查询日期 400。
    assert.equal((await get(booted.base, '/v1/checkin/today?date=2026-10-06', OWNER_A_KEY)).status, 400);
    assert.equal((await get(booted.base, '/v1/checkin/today?date=nope', OWNER_A_KEY)).status, 400);
  } finally {
    await booted.close();
  }
});

test('F4H-7 无网 → 本地 pending → 恢复后幂等补传，且 ACK 与 GET 同值', async () => {
  clock = T0;
  const booted = await boot();
  const offlineBase = 'http://127.0.0.1:1'; // 必然拒绝连接
  const sender = (base: string) => async (entry: { date: string; roomId: string | null }): Promise<{ ok: true } | { ok: false; retryable: boolean; code: string }> => {
    try {
      const res = await fetch(`${base}/v1/checkin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Study-Key': OWNER_A_KEY },
        body: JSON.stringify({ schemaVersion: 'checkin-report-v1', date: entry.date, roomId: entry.roomId }),
      });
      if (res.ok) return { ok: true };
      const payload = await res.json().catch(() => null) as { error?: { code?: string; retryable?: boolean } } | null;
      return { ok: false, retryable: payload?.error?.retryable === true || res.status >= 500, code: payload?.error?.code ?? `HTTP_${res.status}` };
    } catch {
      return { ok: false, retryable: true, code: 'ADDONS_UNAVAILABLE' };
    }
  };

  try {
    const queue = createPendingQueue({ storage: createMemoryPendingStorage(), now });
    // ① 无网：本地记录，明确"待同步"。
    const local = queue.recordLocal('2026-10-05', 'study-201');
    assert.equal(local.localOnly, true);
    assert.equal(local.message, '已本地记录，待同步');
    const offlineFlush = await queue.flush(sender(offlineBase));
    assert.equal(offlineFlush.stoppedByRetryableFailure, true);
    assert.equal(offlineFlush.synced, 0);
    assert.equal(queue.statusOf('2026-10-05').synced, false);
    assert.equal(queue.statusOf('2026-10-05').message, '已本地记录，待同步');

    // ② 联网：幂等补传成功，本地状态翻成"已同步"。
    const onlineFlush = await queue.flush(sender(booted.base));
    assert.equal(onlineFlush.synced, 1);
    assert.equal(queue.statusOf('2026-10-05').synced, true);
    assert.equal(queue.statusOf('2026-10-05').message, '已同步');

    // ③ ACK 与 GET /today 同值（同 streak / mottoIndex / motto）。
    const today = await get(booted.base, '/v1/checkin/today', OWNER_A_KEY);
    assert.equal(today.json.checkedIn, true);
    assert.equal(today.json.streak, 1);
    assert.equal(today.json.mottoIndex, 0);
    const again = await post(booted.base, '/v1/checkin', OWNER_A_KEY, body({ roomId: 'study-201' }));
    assert.equal(again.json.duplicate, true);
    assert.equal(again.json.mottoIndex, today.json.mottoIndex);
    assert.equal(again.json.currentStreak, today.json.streak);
    // ④ 再 flush 不重复送。
    assert.equal((await queue.flush(sender(booted.base))).attempted, 0);
  } finally {
    await booted.close();
  }
});

test('F8H-1 真实 HTTP：双向 opt-in 与房间级粗档（响应无身份、无精确人数）', async () => {
  clock = T0;
  const booted = await boot();
  try {
    const a = await post(booted.base, '/v1/presence/heartbeat', OWNER_A_KEY, { schemaVersion: 'presence-heartbeat-v1', roomId: 'study-201', optIn: true });
    assert.equal(a.status, 200);
    assert.equal(a.json.youOptedIn, true);
    assert.equal(a.json.peerPresence, 'none');
    const bView = await get(booted.base, '/v1/presence/room?roomId=study-201', OWNER_B_KEY);
    assert.equal(bView.json.youOptedIn, false);
    assert.equal(bView.json.peerPresence, 'hidden');

    const b = await post(booted.base, '/v1/presence/heartbeat', OWNER_B_KEY, { schemaVersion: 'presence-heartbeat-v1', roomId: 'study-201', optIn: true });
    assert.equal(b.json.peerPresence, 'one');
    const aView = await get(booted.base, '/v1/presence/room?roomId=study-201', OWNER_A_KEY);
    assert.equal(aView.json.peerPresence, 'one');
    assert.equal(aView.json.label, '另有 1 位同学也在安静学习');
    const raw = JSON.stringify(aView.json);
    assert.equal(raw.includes(OWNER_B_KEY), false);
    assert.equal(/owner|count/i.test(raw), false);

    // 随时可关：B 关掉 ⇒ A 立刻回到"只有你"。
    const off = await post(booted.base, '/v1/presence/heartbeat', OWNER_B_KEY, { schemaVersion: 'presence-heartbeat-v1', roomId: 'study-201', optIn: false });
    assert.equal(off.json.youOptedIn, false);
    assert.equal((await get(booted.base, '/v1/presence/room?roomId=study-201', OWNER_A_KEY)).json.peerPresence, 'none');
  } finally {
    await booted.close();
  }
});

test('F8H-2 TTL 过期后消失（服务端时钟推进）；非法参数/缺 key 明确报错', async () => {
  clock = T0;
  const booted = await boot();
  try {
    // B 先心跳（先过期），A 晚 1 s 心跳（仍在有效期）。
    await post(booted.base, '/v1/presence/heartbeat', OWNER_B_KEY, { schemaVersion: 'presence-heartbeat-v1', roomId: 'study-201', optIn: true });
    clock = T0 + 1000;
    await post(booted.base, '/v1/presence/heartbeat', OWNER_A_KEY, { schemaVersion: 'presence-heartbeat-v1', roomId: 'study-201', optIn: true });
    assert.equal((await get(booted.base, '/v1/presence/room?roomId=study-201', OWNER_A_KEY)).json.peerPresence, 'one');
    // B 到期消失，A 自己还在 ⇒ "只有你"（不是"你没开"）。
    clock = T0 + PRESENCE_TTL_MS;
    const peerGone = await get(booted.base, '/v1/presence/room?roomId=study-201', OWNER_A_KEY);
    assert.equal(peerGone.json.youOptedIn, true);
    assert.equal(peerGone.json.peerPresence, 'none');
    // A 自己也到期 ⇒ hidden。
    clock = T0 + 1000 + PRESENCE_TTL_MS;
    const selfGone = await get(booted.base, '/v1/presence/room?roomId=study-201', OWNER_A_KEY);
    assert.equal(selfGone.json.youOptedIn, false);
    assert.equal(selfGone.json.peerPresence, 'hidden');

    assert.equal((await get(booted.base, '/v1/presence/room', OWNER_A_KEY)).status, 400);
    assert.equal((await get(booted.base, '/v1/presence/room?roomId=nowhere', OWNER_A_KEY)).status, 400);
    const extra = await post(booted.base, '/v1/presence/heartbeat', OWNER_A_KEY, { schemaVersion: 'presence-heartbeat-v1', roomId: 'study-201', optIn: true, deviceId: 'x' });
    assert.equal(extra.status, 400);
    const noKey = await fetch(`${booted.base}/v1/presence/room?roomId=study-201`);
    assert.equal(noKey.status, 401);
  } finally {
    await booted.close();
  }
});

test('F8H-3 两条功能共用同一个服务，但存储互相独立（各写各的文件）', async () => {
  clock = T0;
  const booted = await boot();
  try {
    await post(booted.base, '/v1/checkin', OWNER_A_KEY, body({ roomId: 'study-201' }));
    await post(booted.base, '/v1/presence/heartbeat', OWNER_A_KEY, { schemaVersion: 'presence-heartbeat-v1', roomId: 'study-201', optIn: true });
    assert.equal(existsSync(booted.files.checkin), true);
    assert.equal(existsSync(booted.files.presence), true);
    assert.notEqual(booted.files.checkin, booted.files.presence);
    // 关掉 presence（撤回）不影响打卡数据。
    await post(booted.base, '/v1/presence/heartbeat', OWNER_A_KEY, { schemaVersion: 'presence-heartbeat-v1', roomId: 'study-201', optIn: false });
    const today = await get(booted.base, '/v1/checkin/today', OWNER_A_KEY);
    assert.equal(today.json.checkedIn, true);
    // F3 的房间列表接口仍然在（同一 app 上并存，互不干扰）。
    const rooms = await get(booted.base, '/v1/rooms', OWNER_A_KEY);
    assert.equal(rooms.status, 200);
    assert.equal(Array.isArray(rooms.json.rooms), true);
  } finally {
    await booted.close();
  }
});

test('F4H-8 HTTP 层缺证/容量：打卡快照损坏 ⇒ 503（retryable）而 GET 仍 200+null；设备数满 ⇒ 507', async () => {
  clock = T0;
  const dir = mkdtempSync(join(tmpdir(), 'f4f8-badstore-'));
  const checkin = join(dir, 'checkin-v1.json');
  writeFileSync(checkin, '{ not json at all', 'utf8');
  const { app } = createAddonApp({ dbPath: join(dir, 'quiet.sqlite'), roomIndexFile: join(dir, 'room-index-v1.json'), checkinFile: checkin, presenceFile: join(dir, 'presence-v1.json'), now });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const post1 = await post(base, '/v1/checkin', OWNER_A_KEY, body());
    assert.equal(post1.status, 503);
    assert.equal(post1.json.error.retryable, true);
    const today = await get(base, '/v1/checkin/today', OWNER_A_KEY);
    assert.equal(today.status, 200);
    assert.equal(today.json.checkedIn, null);
    assert.equal(today.json.storeCorrupted, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // 设备数上限（16）⇒ 第 17 个身份 507（明确容量错误，不是静默丢）。
  const booted = await boot();
  try {
    const keys = Array.from({ length: 16 }, (_, i) => `${String.fromCharCode(67 + i).repeat(24)}`);
    for (const key of keys) {
      const res = await post(booted.base, '/v1/checkin', key, body());
      assert.equal(res.status, 200, `第 ${keys.indexOf(key) + 1} 个身份应成功`);
    }
    const overflow = await post(booted.base, '/v1/checkin', 'Z'.repeat(24), body());
    assert.equal(overflow.status, 507);
    assert.equal(overflow.json.error.code, 'STORE_CAPACITY');
    assert.equal(overflow.json.error.retryable, false);
  } finally {
    await booted.close();
  }
});

test('F8H-4 HTTP 层容量：同房间第 33 个 opt-in 身份 ⇒ 507；损坏的 presence 快照 ⇒ 心跳 503 而 GET 仍 200+unknown', async () => {
  clock = T0;
  const booted = await boot();
  try {
    const owners = Array.from({ length: 32 }, (_, i) => `${'K'.repeat(20)}${String(i).padStart(4, '0')}`);
    for (const key of owners) {
      const res = await post(booted.base, '/v1/presence/heartbeat', key, { schemaVersion: 'presence-heartbeat-v1', roomId: 'study-201', optIn: true });
      assert.equal(res.status, 200, `第 ${owners.indexOf(key) + 1} 个身份应成功`);
    }
    const overflow = await post(booted.base, '/v1/presence/heartbeat', 'MMMM'.repeat(6), { schemaVersion: 'presence-heartbeat-v1', roomId: 'study-201', optIn: true });
    assert.equal(overflow.status, 507);
    assert.equal(overflow.json.error.code, 'STORE_CAPACITY');
    // 已在线的人仍能看到粗档（不因满员而假报 hidden/unknown）。
    const view = await get(booted.base, '/v1/presence/room?roomId=study-201', owners[0] as string);
    assert.equal(view.json.peerPresence, 'some');
  } finally {
    await booted.close();
  }

  const dir = mkdtempSync(join(tmpdir(), 'f8-badstore-'));
  const presence = join(dir, 'presence-v1.json');
  writeFileSync(presence, 'not json', 'utf8');
  const { app } = createAddonApp({ dbPath: join(dir, 'quiet.sqlite'), roomIndexFile: join(dir, 'room-index-v1.json'), checkinFile: join(dir, 'checkin-v1.json'), presenceFile: presence, now });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const beat = await post(base, '/v1/presence/heartbeat', OWNER_A_KEY, { schemaVersion: 'presence-heartbeat-v1', roomId: 'study-201', optIn: true });
    assert.equal(beat.status, 503);
    const view = await get(base, '/v1/presence/room?roomId=study-201', OWNER_A_KEY);
    assert.equal(view.status, 200);
    assert.equal(view.json.peerPresence, 'unknown');
    assert.equal(view.json.storeCorrupted, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
