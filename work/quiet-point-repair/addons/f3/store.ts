/**
 * F3 的持久化：**独立有界 JSON 快照**（`data-addons/room-index-v1.json`），零 SQLite 新表/迁移。
 *
 * 一致性纪律（Sol §1 D ③.5）：
 *  · 去重与更新走**同一个串行提交**（Node 单线程 + 同步原子写 ⇒ 不存在交错）；
 *  · 写临时文件 → `fsync` → 同目录 `rename` → 才 ACK；
 *  · 同 `reportId` 同 bodyHash ⇒ 返回**原 ACK / 原 serverSeq / 原时间**（不刷新新鲜度）；
 *    同 ID 异 body ⇒ 409；`terminalSeq` 回退或真实窗口回退 ⇒ 返回明确 stale 状态且**不覆盖**；
 *  · `serverSeq` 启动从持久高水位恢复；崩溃中的临时文件**不当正式数据**；
 *  · 主 JSON 损坏 ⇒ 公开 unknown 并**停止接受新报告**（绝不创建空快照谎称成功）。
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import {
  QUIET_INDEX_VERSION,
  quietIndex,
  viewForRoom,
  type RoomAggregate,
  type RoomReport,
  type RoomStatus,
  type RoomViewV1,
  type StoredReport,
} from './contract.js';

export const STORE_SCHEMA_VERSION = 1;
/** 最多 3 房间 × 8 活跃 terminal（每 owner）。 */
export const MAX_TERMINALS_PER_ROOM = 8;
/** 每 terminal 去重 ID 上限。 */
export const MAX_DEDUPE_PER_TERMINAL = 128;
/** 旧元数据保留 7 日。 */
export const META_TTL_MS = 7 * 86_400_000;
/** 快照大小上限 2 MiB。 */
export const MAX_STORE_BYTES = 2 * 1024 * 1024;

export interface RoomAck {
  reportId: string;
  accepted: boolean;
  stale: boolean;
  reason: string | null;
  roomId: string;
  indexVersion: string;
  serverSeq: number;
  serverReceivedAt: number;
  evidenceReceivedAt: number | null;
  evidenceEndAt: number | null;
  ageSeconds: number | null;
  quietIndex: number | null;
  quietReason: string | null;
  status: RoomStatus;
}

interface Slot {
  latest: StoredReport | null;
  seqs: string[];
}

interface DedupeEntry {
  bodyHash: string;
  roomId: string;
  slotKey: string;
  at: number;
  ack: RoomAck;
}

interface StoreFile {
  schemaVersion: number;
  serverSeqHighWater: number;
  slots: Record<string, Record<string, Slot>>;
  dedupe: Record<string, DedupeEntry>;
  updatedAt: number;
}

export interface AcceptInput {
  owner: string;
  dto: RoomReport;
  aggregate: RoomAggregate;
  /** C6/Sol §2.5 F3：服务端权威分组键（缺省才回落到 dto 的声明值，只为兼容旧调用点）。 */
  canonical?: { configKey: string; processingKey: string | null; modelHash?: string };
  claimMatched?: { configKey: boolean; processingKey: boolean };
  evidenceReceivedAt: number | null;
  evidenceEndAt: number | null;
  receivedAt: number;
}

export interface CapacityState {
  corrupted: boolean;
  serverSeqHighWater: number;
  terminalCount: number;
  dedupeCount: number;
  bytes: number;
}

export class RoomIndexStore {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private data: StoreFile | null = null;
  private corrupted = false;
  private corruptedReason: string | null = null;

  constructor(options: { filePath: string; now?: () => number; maxBytes?: number }) {
    this.filePath = options.filePath;
    this.now = options.now ?? (() => Date.now());
    this.maxBytes = options.maxBytes ?? MAX_STORE_BYTES;
  }

  private empty(): StoreFile {
    return { schemaVersion: STORE_SCHEMA_VERSION, serverSeqHighWater: 0, slots: {}, dedupe: {}, updatedAt: this.now() };
  }

  /** 懒加载；损坏时**只标记**，绝不写回空快照。 */
  load(): void {
    if (this.data !== null || this.corrupted) return;
    if (!existsSync(this.filePath)) {
      this.data = this.empty();
      return;
    }
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not_object');
      const candidate = parsed as StoreFile;
      if (candidate.schemaVersion !== STORE_SCHEMA_VERSION || typeof candidate.slots !== 'object' || candidate.slots === null) {
        throw new Error('bad_shape');
      }
      if (typeof candidate.serverSeqHighWater !== 'number' || !Number.isFinite(candidate.serverSeqHighWater)) {
        throw new Error('bad_high_water');
      }
      this.data = {
        schemaVersion: STORE_SCHEMA_VERSION,
        serverSeqHighWater: candidate.serverSeqHighWater,
        slots: candidate.slots,
        dedupe: typeof candidate.dedupe === 'object' && candidate.dedupe !== null ? candidate.dedupe : {},
        updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : this.now(),
      };
    } catch (err) {
      this.corrupted = true;
      this.corruptedReason = err instanceof Error ? err.message : 'unknown';
      this.data = null;
    }
  }

  status(): CapacityState {
    this.load();
    const data = this.data;
    let terminalCount = 0;
    if (data !== null) for (const room of Object.values(data.slots)) terminalCount += Object.keys(room).length;
    let bytes = 0;
    try {
      if (existsSync(this.filePath)) bytes = statSync(this.filePath).size;
    } catch {
      bytes = 0;
    }
    return {
      corrupted: this.corrupted,
      serverSeqHighWater: data?.serverSeqHighWater ?? 0,
      terminalCount,
      dedupeCount: data === null ? 0 : Object.keys(data.dedupe).length,
      bytes,
    };
  }

  isCorrupted(): boolean {
    this.load();
    return this.corrupted;
  }

  corruptedReasonText(): string | null {
    this.load();
    return this.corruptedReason;
  }

  private slotKeyOf(owner: string, terminalId: string): string {
    return `${owner}:${terminalId}`;
  }

  private slotOf(data: StoreFile, roomId: string, slotKey: string): Slot | undefined {
    return data.slots[roomId]?.[slotKey];
  }

  /** 原子落盘；失败抛错（调用方**不得** ACK 成功）。 */
  private persist(data: StoreFile): void {
    const json = JSON.stringify(data);
    if (Buffer.byteLength(json, 'utf8') > this.maxBytes) {
      throw new StoreError('STORE_CAPACITY', `快照超过 ${this.maxBytes} 字节上限`);
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, json);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.filePath);
    this.data = data;
  }

  private prune(data: StoreFile, now: number): void {
    for (const [roomId, room] of Object.entries(data.slots)) {
      let terminals = Object.entries(room);
      // 每 owner 上限：同 owner 的 terminal 超过上限时淘汰最旧的（不静默丢新报告）。
      const byOwner = new Map<string, [string, Slot][]>();
      for (const entry of terminals) {
        const owner = entry[0].split(':')[0];
        const list = byOwner.get(owner);
        if (list === undefined) byOwner.set(owner, [entry]);
        else list.push(entry);
      }
      const keep = new Set<string>();
      for (const list of byOwner.values()) {
        const sorted = [...list].sort((a, b) => (b[1].latest?.serverSeq ?? -1) - (a[1].latest?.serverSeq ?? -1));
        for (const [key, slot] of sorted.slice(0, MAX_TERMINALS_PER_ROOM)) {
          if (slot.latest !== null && now - slot.latest.serverReceivedAt > META_TTL_MS) continue;
          keep.add(key);
        }
      }
      terminals = terminals.filter(([key]) => keep.has(key));
      if (terminals.length === 0) delete data.slots[roomId];
      else data.slots[roomId] = Object.fromEntries(terminals);
    }
    const live = new Set<string>();
    for (const room of Object.values(data.slots)) for (const slot of Object.values(room)) for (const id of slot.seqs) live.add(id);
    for (const [id, entry] of Object.entries(data.dedupe)) {
      if (!live.has(id) || now - entry.at > META_TTL_MS) delete data.dedupe[id];
    }
  }

  /**
   * 接受一条报告。返回的 ACK 是**服务端生成的**时间/序号；错误一律抛 `StoreError`。
   */
  accept(input: AcceptInput): RoomAck {
    this.load();
    if (this.corrupted || this.data === null) {
      throw new StoreError('STORE_UNAVAILABLE', `房间指数快照不可用：${this.corruptedReason ?? 'corrupted'}`);
    }
    const now = this.now();
    const bodyHash = createHash('sha256')
      .update(JSON.stringify({ ...input.dto, aggregate: input.aggregate }))
      .digest('hex');
    const previous = this.data.dedupe[input.dto.reportId];
    if (previous !== undefined) {
      if (previous.bodyHash !== bodyHash) {
        throw new StoreError('IDEMPOTENCY_CONFLICT', '同 reportId 的报告内容不一致');
      }
      // 重试：返回**原** ACK / 原 serverSeq / 原时间（不刷新新鲜度）。
      return previous.ack;
    }

    const roomId = input.dto.roomId;
    const slotKey = this.slotKeyOf(input.owner, input.dto.terminalId);
    const data: StoreFile = {
      schemaVersion: STORE_SCHEMA_VERSION,
      serverSeqHighWater: this.data.serverSeqHighWater,
      slots: { ...this.data.slots },
      dedupe: { ...this.data.dedupe },
      updatedAt: now,
    };
    const room = { ...(data.slots[roomId] ?? {}) };
    const existing = room[slotKey];
    if (existing === undefined && Object.keys(room).filter((k) => k.startsWith(`${input.owner}:`)).length >= MAX_TERMINALS_PER_ROOM) {
      throw new StoreError('STORE_CAPACITY', `房间 ${roomId} 的活跃终端已达 ${MAX_TERMINALS_PER_ROOM} 上限`);
    }
    const slot: Slot = existing === undefined ? { latest: null, seqs: [] } : { latest: existing.latest, seqs: [...existing.seqs] };

    const serverSeq = data.serverSeqHighWater + 1;
    const computed = quietIndex(input.aggregate);
    const base: Omit<RoomAck, 'accepted' | 'stale' | 'reason' | 'status' | 'ageSeconds'> = {
      reportId: input.dto.reportId,
      roomId,
      indexVersion: QUIET_INDEX_VERSION,
      serverSeq,
      serverReceivedAt: input.receivedAt,
      evidenceReceivedAt: input.evidenceReceivedAt,
      evidenceEndAt: input.evidenceEndAt,
      quietIndex: computed.value,
      quietReason: computed.reason,
    };

    const regression = (reason: string): RoomAck => {
      // 明确 stale 报告状态：**不覆盖**已存的最新报告，也不推进高水位。
      const prior = slot.latest;
      return {
        ...base,
        serverSeq: prior?.serverSeq ?? serverSeq,
        serverReceivedAt: prior?.serverReceivedAt ?? input.receivedAt,
        evidenceReceivedAt: prior?.evidenceReceivedAt ?? input.evidenceReceivedAt,
        evidenceEndAt: prior?.evidenceEndAt ?? input.evidenceEndAt,
        quietIndex: prior?.quietIndex ?? null,
        quietReason: prior?.quietReason ?? null,
        accepted: false,
        stale: true,
        reason,
        status: 'stale',
        ageSeconds: prior?.evidenceEndAt === null || prior?.evidenceEndAt === undefined ? null : (now - prior.evidenceEndAt) / 1000,
      };
    };

    const prior = slot.latest;
    if (prior !== null) {
      if (input.dto.terminalSeq <= prior.terminalSeq) return regression('terminal_seq_regression');
      // 真实窗口结束时间不得回退（跨 session 不比较 UUID 大小，只比较时间锚 + 桶号）。
      const priorEnd = prior.evidenceEndAt;
      const nextEnd = input.evidenceEndAt;
      if (priorEnd !== null && nextEnd !== null && nextEnd < priorEnd) return regression('window_regression');
      if (prior.sessionId === input.dto.sessionId && input.dto.lastBucket <= prior.lastBucket) return regression('window_regression');
    }

    const stored: StoredReport = {
      reportId: input.dto.reportId,
      roomId,
      terminalId: input.dto.terminalId,
      terminalSeq: input.dto.terminalSeq,
      sessionId: input.dto.sessionId,
      generation: input.dto.generation,
      firstBucket: input.dto.firstBucket,
      lastBucket: input.dto.lastBucket,
      indexVersion: QUIET_INDEX_VERSION,
      // C6/Sol §2.5 F3：**权威**分组键由服务端复算（客户端声明已经在路由层核对过）。
      configKey: input.canonical?.configKey ?? input.dto.configKey,
      processingKey: input.canonical === undefined ? input.dto.processingKey : input.canonical.processingKey,
      aggregate: input.aggregate,
      quietIndex: computed.value,
      quietReason: computed.reason,
      serverSeq,
      serverReceivedAt: input.receivedAt,
      evidenceReceivedAt: input.evidenceReceivedAt,
      evidenceEndAt: input.evidenceEndAt,
      bodyHash,
    };
    slot.latest = stored;
    slot.seqs.push(input.dto.reportId);
    if (slot.seqs.length > MAX_DEDUPE_PER_TERMINAL) {
      const dropped = slot.seqs.splice(0, slot.seqs.length - MAX_DEDUPE_PER_TERMINAL);
      for (const id of dropped) delete data.dedupe[id];
    }
    room[slotKey] = slot;
    data.slots[roomId] = room;
    data.serverSeqHighWater = serverSeq;
    data.updatedAt = now;

    const ageSeconds = input.evidenceEndAt === null ? null : (now - input.evidenceEndAt) / 1000;
    const ack: RoomAck = {
      ...base,
      accepted: true,
      stale: false,
      reason: null,
      status: ageSeconds !== null && ageSeconds < 0 ? 'unknown' : 'fresh',
      ageSeconds,
    };
    data.dedupe[input.dto.reportId] = { bodyHash, roomId, slotKey, at: now, ack };
    this.prune(data, now);
    this.persist(data);
    return ack;
  }

  /** 匿名房间聚合（不暴露 terminalId / ownerHash / sessionId）。 */
  listRooms(now: number): { rooms: RoomViewV1[]; corrupted: boolean } {
    this.load();
    if (this.corrupted || this.data === null) return { rooms: [], corrupted: true };
    const out: RoomViewV1[] = [];
    for (const [roomId, room] of Object.entries(this.data.slots)) {
      const reports: StoredReport[] = [];
      for (const slot of Object.values(room)) if (slot.latest !== null) reports.push(slot.latest);
      const terminalCount = reports.length;
      const view = viewForRoom({ roomId: roomId as RoomViewV1['roomId'], reports, terminalCount, now });
      out.push(view);
    }
    return { rooms: out, corrupted: false };
  }
}

export class StoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

/** 启动清场：遗留的临时文件不算正式数据。 */
export function sweepTempFiles(filePath: string): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  if (existsSync(tmp)) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 清理失败不影响正式数据 */
    }
  }
}
