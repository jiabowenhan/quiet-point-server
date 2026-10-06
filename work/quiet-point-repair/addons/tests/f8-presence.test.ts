/**
 * F8-c 匿名「共同存在信号」：双向 opt-in、只有房间级粗档（不给精确人数/名单）、
 * 短 TTL 过期即消失、随时可关、不留历史、有界容量、损坏缺证。
 *
 * 对应 SCOPE_FINAL §23:35 的隐私边界（硬性），逐条落到断言上。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_PRESENCE_IDENTITIES_PER_ROOM,
  PRESENCE_TTL_MS,
  peerBucket,
  presenceLabel,
} from '../f8/contract.js';
import { PresenceStore } from '../f8/store.js';
import { DataStoreError } from '../shared/atomic-json.js';

const T0 = 1_760_000_000_000;
const OWNER_A = 'a'.repeat(64);
const OWNER_B = 'b'.repeat(64);
const OWNER_C = 'c'.repeat(64);
const ROOM = 'study-201';

function freshStore(): { store: PresenceStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'f8-presence-'));
  const file = join(dir, 'presence-v1.json');
  return { store: new PresenceStore({ filePath: file, now: () => T0 }), file };
}

test('F8-1 双向 opt-in：只开一方互相都看不见；双方都开才互相可见', () => {
  const { store } = freshStore();
  // A 开、B 没开 ⇒ A 看到「只有你」，B 看到 hidden（不揭示任何人）。
  const a1 = store.heartbeat({ owner: OWNER_A, roomId: ROOM, optIn: true, receivedAt: T0 });
  assert.equal(a1.youOptedIn, true);
  assert.equal(a1.peerPresence, 'none');
  const b1 = store.view(OWNER_B, ROOM, T0);
  assert.equal(b1.youOptedIn, false);
  assert.equal(b1.peerPresence, 'hidden');
  // B 开 ⇒ 双方都看到 one；A 不会看到 B 的身份。
  const b2 = store.heartbeat({ owner: OWNER_B, roomId: ROOM, optIn: true, receivedAt: T0 });
  assert.equal(b2.peerPresence, 'one');
  assert.equal(b2.label, presenceLabel('one'));
  assert.equal(store.view(OWNER_A, ROOM, T0).peerPresence, 'one');
});

test('F8-2 只有一个房间级粗档：≥2 一律同一档，不给精确人数也不给名单', () => {
  const { store } = freshStore();
  assert.deepEqual([peerBucket(0), peerBucket(1), peerBucket(2), peerBucket(3), peerBucket(99)], ['none', 'one', 'some', 'some', 'some']);
  assert.equal(peerBucket(Number.NaN), 'none');
  store.heartbeat({ owner: OWNER_A, roomId: ROOM, optIn: true, receivedAt: T0 });
  const two = store.heartbeat({ owner: OWNER_B, roomId: ROOM, optIn: true, receivedAt: T0 });
  assert.equal(two.peerPresence, 'one');
  const three = store.heartbeat({ owner: OWNER_C, roomId: ROOM, optIn: true, receivedAt: T0 });
  assert.equal(three.peerPresence, 'some');
  // 再多人也只停在 some —— 连"到底是 2 还是 20"都推不出来。
  for (let i = 0; i < 5; i += 1) store.heartbeat({ owner: `${String(i)}${'d'.repeat(63)}`, roomId: ROOM, optIn: true, receivedAt: T0 });
  const view = store.view(OWNER_A, ROOM, T0);
  assert.equal(view.peerPresence, 'some');
  const raw = JSON.stringify(view);
  assert.equal(raw.includes('owner'), false);
  assert.equal(raw.includes(OWNER_B), false);
  assert.equal(/count|人数|roster|members/i.test(raw), false);
  assert.equal(raw.includes('"at"'), false);
  // 字段集合本身就没有"人数"的位置（逐字锁定，防以后偷偷加个 peerCount）。
  assert.deepEqual(Object.keys(view).sort(), [
    'computedAt',
    'heartbeatIntervalSeconds',
    'label',
    'peerPresence',
    'reason',
    'roomId',
    'schemaVersion',
    'storeCorrupted',
    'ttlSeconds',
    'youOptedIn',
  ]);
});

test('F8-3 短 TTL：过期即消失（89.999 s 还在，90 s 就没有了），不形成监视面', () => {
  const { store } = freshStore();
  // B 的心跳更早 ⇒ B 先过期；A 晚 1 s 心跳 ⇒ A 仍然在线。
  store.heartbeat({ owner: OWNER_B, roomId: ROOM, optIn: true, receivedAt: T0 });
  store.heartbeat({ owner: OWNER_A, roomId: ROOM, optIn: true, receivedAt: T0 + 1000 });
  assert.equal(store.view(OWNER_A, ROOM, T0 + PRESENCE_TTL_MS - 1).peerPresence, 'one');
  // B 到 TTL ⇒ 从 A 的视野里消失，但 A 自己还在（不是"你没开"）。
  const afterPeerExpiry = store.view(OWNER_A, ROOM, T0 + PRESENCE_TTL_MS);
  assert.equal(afterPeerExpiry.youOptedIn, true);
  assert.equal(afterPeerExpiry.peerPresence, 'none');
  // A 自己也到 TTL ⇒ 回到 hidden（不是"只有你"这种假结论）。
  const afterSelfExpiry = store.view(OWNER_A, ROOM, T0 + 1000 + PRESENCE_TTL_MS);
  assert.equal(afterSelfExpiry.youOptedIn, false);
  assert.equal(afterSelfExpiry.peerPresence, 'hidden');
  assert.equal(store.view(OWNER_A, ROOM, T0 + 10 * PRESENCE_TTL_MS).peerPresence, 'hidden');
});

test('F8-4 随时可关：optIn=false 当场撤回心跳，对方立刻看不到', () => {
  const { store, file } = freshStore();
  store.heartbeat({ owner: OWNER_A, roomId: ROOM, optIn: true, receivedAt: T0 });
  store.heartbeat({ owner: OWNER_B, roomId: ROOM, optIn: true, receivedAt: T0 });
  assert.equal(store.status().identityCount, 2);
  const off = store.heartbeat({ owner: OWNER_B, roomId: ROOM, optIn: false, receivedAt: T0 + 1000 });
  assert.equal(off.youOptedIn, false);
  assert.equal(off.peerPresence, 'hidden');
  assert.equal(store.status().identityCount, 1);
  assert.equal(store.view(OWNER_A, ROOM, T0 + 1000).peerPresence, 'none');
  // 存储里也不留 B 的痕迹。
  assert.equal(readFileSync(file, 'utf8').includes(OWNER_B), false);
  // 重复关闭是幂等的（不报错、不新增）。
  const again = store.heartbeat({ owner: OWNER_B, roomId: ROOM, optIn: false, receivedAt: T0 + 2000 });
  assert.equal(again.youOptedIn, false);
});

test('F8-5 不留历史：每人只有一条最新心跳（无数组/无流水），过期条目在下次写入时被清掉', () => {
  const { store, file } = freshStore();
  store.heartbeat({ owner: OWNER_A, roomId: ROOM, optIn: true, receivedAt: T0 });
  store.heartbeat({ owner: OWNER_B, roomId: ROOM, optIn: true, receivedAt: T0 });
  // 反复续期不产生历史条目。
  for (let i = 1; i <= 5; i += 1) store.heartbeat({ owner: OWNER_A, roomId: ROOM, optIn: true, receivedAt: T0 + i * 1000 });
  const persisted = JSON.parse(readFileSync(file, 'utf8')) as { rooms: Record<string, Record<string, Record<string, number>>> };
  const room = persisted.rooms[ROOM] as Record<string, Record<string, number>>;
  assert.deepEqual(Object.keys(room).sort(), [OWNER_A, OWNER_B].sort());
  for (const record of Object.values(room)) assert.deepEqual(Object.keys(record), ['at']);
  assert.equal(JSON.stringify(persisted).includes('history'), false);
  // B 过期后，任何人再次心跳 ⇒ 写入路径把 B 的过期记录清掉（文件里不再有）。
  store.heartbeat({ owner: OWNER_A, roomId: ROOM, optIn: true, receivedAt: T0 + PRESENCE_TTL_MS + 1 });
  const after = readFileSync(file, 'utf8');
  assert.equal(after.includes(OWNER_B), false);
  assert.equal(after.includes(OWNER_A), true);
});

test('F8-6 只读视图无写副作用：没有任何心跳时 GET 不创建文件', () => {
  const { store, file } = freshStore();
  const view = store.view(OWNER_A, ROOM, T0);
  assert.equal(view.peerPresence, 'hidden');
  assert.equal(view.youOptedIn, false);
  assert.equal(existsSync(file), false);
  // 心跳之后才有文件。
  store.heartbeat({ owner: OWNER_A, roomId: ROOM, optIn: true, receivedAt: T0 });
  assert.equal(existsSync(file), true);
});

test('F8-7 有界容量：每房间 32 人上限 ⇒ 第 33 个明确 507', () => {
  const { store } = freshStore();
  const owners = Array.from({ length: MAX_PRESENCE_IDENTITIES_PER_ROOM }, (_, i) => `${String(i).padStart(2, '0')}${'e'.repeat(62)}`);
  for (const owner of owners) store.heartbeat({ owner, roomId: ROOM, optIn: true, receivedAt: T0 });
  assert.equal(store.status().identityCount, MAX_PRESENCE_IDENTITIES_PER_ROOM);
  assert.throws(
    () => store.heartbeat({ owner: 'z'.repeat(64), roomId: ROOM, optIn: true, receivedAt: T0 }),
    (err: unknown) => err instanceof DataStoreError && err.code === 'STORE_CAPACITY',
  );
  // 已在线的人续期不受上限影响（不把老用户顶掉）。
  const renewed = store.heartbeat({ owner: owners[0] as string, roomId: ROOM, optIn: true, receivedAt: T0 + 1000 });
  assert.equal(renewed.youOptedIn, true);
});

test('F8-8 损坏 ⇒ 缺证：view 返回 unknown（不假装没人），心跳拒绝，原文件不被覆盖', () => {
  const dir = mkdtempSync(join(tmpdir(), 'f8-corrupt-'));
  const file = join(dir, 'presence-v1.json');
  writeFileSync(file, '{ broken json', 'utf8');
  const before = readFileSync(file, 'utf8');
  const store = new PresenceStore({ filePath: file, now: () => T0 });
  assert.equal(store.isCorrupted(), true);
  const view = store.view(OWNER_A, ROOM, T0);
  assert.equal(view.peerPresence, 'unknown');
  assert.equal(view.storeCorrupted, true);
  assert.equal(view.reason, 'store_corrupted');
  assert.throws(
    () => store.heartbeat({ owner: OWNER_A, roomId: ROOM, optIn: true, receivedAt: T0 }),
    (err: unknown) => err instanceof DataStoreError && err.code === 'STORE_UNAVAILABLE',
  );
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('F8-9 房间隔离：不同房间互不可见', () => {
  const { store } = freshStore();
  store.heartbeat({ owner: OWNER_B, roomId: 'reading-101', optIn: true, receivedAt: T0 });
  store.heartbeat({ owner: OWNER_A, roomId: ROOM, optIn: true, receivedAt: T0 });
  assert.equal(store.view(OWNER_A, ROOM, T0).peerPresence, 'none');
  assert.equal(store.view(OWNER_B, 'reading-101', T0).peerPresence, 'none');
});
