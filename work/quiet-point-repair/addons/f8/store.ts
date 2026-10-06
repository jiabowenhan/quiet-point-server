/**
 * F8-c 共同存在信号持久化：**独立有界 JSON**（`data-addons/presence-v1.json`）。
 *
 * 「不留历史」的具体做法（不是口号）：
 *  · 每个身份在存储里**只有一条**记录 —— `{ at }`（最后一次心跳时刻），没有数组、没有事件序列；
 *  · opt-out ⇒ **当场删除**该记录（连同空房间一起删）；
 *  · 过期（`now - at ≥ TTL`）⇒ 读路径与写路径都会剔除；文件里最坏只留 TTL 内的一个时间戳；
 *  · 不记录房间/身份的进出流水、不记录时长、不累计任何统计量。
 *
 * 匿名性：存储内部用 `sha256(X-Study-Key)` 做**去重键**（这是"数人头"的必要条件），
 * 但该值**永不**出现在任何响应里（见 `view`/`heartbeat` 的返回字段，全无 owner/hash/名单）。
 *
 * 有界：每房间 ≤32 个 opted-in 身份、文件 ≤256 KiB；超限 **507 明确报错**，不静默顶掉在线的人。
 */

import {
  MAX_PRESENCE_IDENTITIES_PER_ROOM,
  PRESENCE_HEARTBEAT_INTERVAL_MS,
  PRESENCE_TTL_MS,
  PRESENCE_HEARTBEAT_SCHEMA_VERSION,
  PRESENCE_VIEW_SCHEMA_VERSION,
  peerBucket,
  presenceLabel,
  type PeerPresence,
  type PresenceAck,
  type PresenceView,
} from './contract.js';
import { DataStoreError, fileBytes, readJsonFile, sweepTemp, writeJsonAtomic } from '../shared/atomic-json.js';

export const PRESENCE_STORE_SCHEMA_VERSION = 1;
export const MAX_PRESENCE_BYTES = 256 * 1024;

interface PresenceRecord {
  at: number;
}

interface StoreFile {
  schemaVersion: number;
  rooms: Record<string, Record<string, PresenceRecord>>;
  updatedAt: number;
}

export interface PresenceCapacityState {
  corrupted: boolean;
  corruptedReason: string | null;
  roomCount: number;
  identityCount: number;
  bytes: number;
}

export interface HeartbeatInput {
  owner: string;
  roomId: string;
  optIn: boolean;
  receivedAt: number;
}

export class PresenceStore {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private data: StoreFile | null = null;
  private corrupted = false;
  private corruptedReason: string | null = null;

  constructor(options: { filePath: string; now?: () => number; maxBytes?: number }) {
    this.filePath = options.filePath;
    this.now = options.now ?? (() => Date.now());
    this.maxBytes = options.maxBytes ?? MAX_PRESENCE_BYTES;
  }

  private empty(): StoreFile {
    return { schemaVersion: PRESENCE_STORE_SCHEMA_VERSION, rooms: {}, updatedAt: this.now() };
  }

  load(): void {
    if (this.data !== null || this.corrupted) return;
    const read = readJsonFile(this.filePath);
    if (read.kind === 'missing') {
      this.data = this.empty();
      return;
    }
    if (read.kind === 'corrupted') {
      this.corrupted = true;
      this.corruptedReason = read.error;
      return;
    }
    try {
      const candidate = read.value as Partial<StoreFile> | null;
      if (candidate === null || typeof candidate !== 'object') throw new Error('not_object');
      if (candidate.schemaVersion !== PRESENCE_STORE_SCHEMA_VERSION) throw new Error('bad_schema_version');
      if (typeof candidate.rooms !== 'object' || candidate.rooms === null) throw new Error('bad_rooms');
      this.data = {
        schemaVersion: PRESENCE_STORE_SCHEMA_VERSION,
        rooms: candidate.rooms as Record<string, Record<string, PresenceRecord>>,
        updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : this.now(),
      };
    } catch (err) {
      this.corrupted = true;
      this.corruptedReason = err instanceof Error ? err.message : 'unknown';
      this.data = null;
    }
  }

  isCorrupted(): boolean {
    this.load();
    return this.corrupted;
  }

  status(): PresenceCapacityState {
    this.load();
    let roomCount = 0;
    let identityCount = 0;
    if (this.data !== null) {
      roomCount = Object.keys(this.data.rooms).length;
      for (const room of Object.values(this.data.rooms)) identityCount += Object.keys(room).length;
    }
    return {
      corrupted: this.corrupted,
      corruptedReason: this.corruptedReason,
      roomCount,
      identityCount,
      bytes: fileBytes(this.filePath),
    };
  }

  /** 存活 = `now - at < TTL`（恰好到 TTL 即过期，确定性边界）。 */
  private liveCount(room: Record<string, PresenceRecord>, at: number, excludeOwner?: string): number {
    let live = 0;
    for (const [owner, record] of Object.entries(room)) {
      if (owner === excludeOwner) continue;
      if (at - record.at < PRESENCE_TTL_MS) live += 1;
    }
    return live;
  }

  private pruneRoom(room: Record<string, PresenceRecord>, at: number): Record<string, PresenceRecord> {
    const kept: Record<string, PresenceRecord> = {};
    for (const [owner, record] of Object.entries(room)) {
      if (at - record.at < PRESENCE_TTL_MS) kept[owner] = record;
    }
    return kept;
  }

  /** 把所有房间的过期心跳剔掉（内存态）；返回是否发生改动。 */
  private pruneAll(at: number): boolean {
    const data = this.data as StoreFile;
    let changed = false;
    for (const [roomId, room] of Object.entries(data.rooms)) {
      const kept = this.pruneRoom(room, at);
      if (Object.keys(kept).length !== Object.keys(room).length) changed = true;
      if (Object.keys(kept).length === 0) {
        if (Object.keys(room).length > 0) changed = true;
        delete data.rooms[roomId];
      } else {
        data.rooms[roomId] = kept;
      }
    }
    return changed;
  }

  /** 心跳（开启=续期；关闭=**立即撤回**）。 */
  heartbeat(input: HeartbeatInput): PresenceAck {
    this.load();
    if (this.corrupted || this.data === null) {
      throw new DataStoreError('STORE_UNAVAILABLE', `共同存在信号存储不可用：${this.corruptedReason ?? 'corrupted'}`);
    }
    const { owner, roomId, optIn, receivedAt } = input;
    this.pruneAll(receivedAt);
    const rooms: Record<string, Record<string, PresenceRecord>> = { ...(this.data as StoreFile).rooms };
    const room: Record<string, PresenceRecord> = { ...(rooms[roomId] ?? {}) };
    let mutated = false;

    if (optIn) {
      const isNew = room[owner] === undefined;
      if (isNew && Object.keys(room).length >= MAX_PRESENCE_IDENTITIES_PER_ROOM) {
        throw new DataStoreError('STORE_CAPACITY', `房间 ${roomId} 的共同存在信号已达 ${MAX_PRESENCE_IDENTITIES_PER_ROOM} 人上限`);
      }
      room[owner] = { at: receivedAt };
      rooms[roomId] = room;
      mutated = true;
    } else if (room[owner] !== undefined) {
      // 随时可关：立即删除，不留痕迹。
      delete room[owner];
      if (Object.keys(room).length === 0) delete rooms[roomId];
      else rooms[roomId] = room;
      mutated = true;
    }

    const next: StoreFile = {
      schemaVersion: PRESENCE_STORE_SCHEMA_VERSION,
      rooms,
      updatedAt: receivedAt,
    };
    if (mutated) {
      sweepTemp(this.filePath);
      writeJsonAtomic(this.filePath, next, this.maxBytes);
    }
    this.data = next;

    const youOptedIn = optIn;
    const peerPresence: PeerPresence = youOptedIn ? peerBucket(this.liveCount(room, receivedAt, owner)) : 'hidden';
    return {
      schemaVersion: PRESENCE_HEARTBEAT_SCHEMA_VERSION,
      roomId,
      youOptedIn,
      peerPresence,
      label: presenceLabel(peerPresence),
      ttlSeconds: PRESENCE_TTL_MS / 1000,
      nextHeartbeatSeconds: PRESENCE_HEARTBEAT_INTERVAL_MS / 1000,
      serverReceivedAt: receivedAt,
      storeCorrupted: false,
      reason: null,
    };
  }

  /**
   * 只读视图（GET）。**不落盘**（读路径不产生写副作用）；过期条目在内存视图中剔除。
   * 缺证纪律：存储损坏 ⇒ `unknown`（**不**谎称"只有你"）。
   */
  view(owner: string, roomId: string, at: number): PresenceView {
    this.load();
    if (this.corrupted || this.data === null) {
      return {
        schemaVersion: PRESENCE_VIEW_SCHEMA_VERSION,
        roomId,
        youOptedIn: false,
        peerPresence: 'unknown',
        label: presenceLabel('unknown'),
        ttlSeconds: PRESENCE_TTL_MS / 1000,
        heartbeatIntervalSeconds: PRESENCE_HEARTBEAT_INTERVAL_MS / 1000,
        computedAt: at,
        storeCorrupted: true,
        reason: 'store_corrupted',
      };
    }
    this.pruneAll(at);
    const room = (this.data as StoreFile).rooms[roomId] ?? {};
    const youOptedIn = room[owner] !== undefined && at - (room[owner] as PresenceRecord).at < PRESENCE_TTL_MS;
    const peerPresence: PeerPresence = youOptedIn ? peerBucket(this.liveCount(room, at, owner)) : 'hidden';
    return {
      schemaVersion: PRESENCE_VIEW_SCHEMA_VERSION,
      roomId,
      youOptedIn,
      peerPresence,
      label: presenceLabel(peerPresence),
      ttlSeconds: PRESENCE_TTL_MS / 1000,
      heartbeatIntervalSeconds: PRESENCE_HEARTBEAT_INTERVAL_MS / 1000,
      computedAt: at,
      storeCorrupted: false,
      reason: null,
    };
  }
}
