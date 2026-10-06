/**
 * F4 **离线本地降级**：有界 pending 队列 + 幂等补传（纯逻辑，零 IO、零网络、零采集）。
 *
 * 为什么放在 addons 侧：它是**协议的一部分**（补传语义、幂等键、向服务端的回补窗口一致），
 * 必须有确定性测试；而它自己不做任何 HTTP —— 真正的发送函数由调用方（app 侧）注入。
 * 这样 app 只需一个 ~20 行适配器（Capacitor Preferences / localStorage 实现 `PendingStorage`，
 * fetch 实现 `Send`），不必重新发明队列语义。
 *
 * 冻结口径（SCOPE_FINAL §21:20 第 5 条 + §2.6C）：
 *  · **无网时本地记录 + 进有界队列**，UI 得到的是 `localOnly:true` + 「已本地记录，待同步」——
 *    **绝不**返回"已同步"（不假装）；
 *  · 联网后**幂等补传**：同一天重复 flush 只送一次（本地已同步不再送；服务端再按 (date, identity) 幂等兜底）；
 *  · 有界：默认最多 64 条；超出/过期**计数上报**（不是静默丢）；
 *  · 补传窗口与服务端 `MAX_BACKFILL_DAYS` 一致，超窗记录服务端必然拒绝 ⇒ 本地提前判过期并计数。
 *
 * 本文件**不 import** 任何采集/音频模块：不碰麦克风采集 API、不创建音频上下文、不申请录音权限
 * （连标识符都不出现——由 `tests/f4f8-guard.test.ts` 的静态守卫逐行扫描强制）。
 * 打卡路径不签发任何采音意图（§2.6C 明令）。
 */

import { MAX_BACKFILL_DAYS } from './contract.js';
import { diffDays, shanghaiDayOf } from '../shared/day.js';

/** 与 `shared/day.ts` 同一规则：客户端也按 Asia/Shanghai 算"今天"，避免跨午夜与服务端错日。 */
export const localDayOf = shanghaiDayOf;

export const PENDING_SCHEMA_VERSION = 1;
/** 有界 pending 队列容量（超出按淘汰序丢弃并计数）。 */
export const MAX_PENDING_ENTRIES = 64;
/** 与服务端回补窗口一致；更旧的本地记录不可能被接受。 */
export const PENDING_TTL_DAYS = MAX_BACKFILL_DAYS;

export const LOCAL_ONLY_MESSAGE = '已本地记录，待同步';
export const SYNCED_MESSAGE = '已同步';

export type PendingStatus = 'pending' | 'synced' | 'rejected';

export interface PendingEntry {
  date: string;
  roomId: string | null;
  status: PendingStatus;
  attempts: number;
  lastError: string | null;
  localRecordedAt: number;
  syncedAt: number | null;
}

export interface PendingFile {
  schemaVersion: number;
  entries: PendingEntry[];
  droppedExpired: number;
  droppedOverflow: number;
  updatedAt: number;
}

export interface PendingStorage {
  /** 返回上一次 `save()` 的值；无则返回 null。实现方需自行容错（坏值由本模块判定）。 */
  load(): unknown;
  save(value: unknown): void;
}

/** 内存实现：给测试与「还没接 Preferences 的宿主」用。 */
export function createMemoryPendingStorage(initial: unknown = null): PendingStorage {
  let current: unknown = initial;
  return {
    load: () => current,
    save: (value: unknown) => {
      current = JSON.parse(JSON.stringify(value)) as unknown;
    },
  };
}

export type SendOutcome = { ok: true } | { ok: false; retryable: boolean; code: string };
export type Send = (entry: { date: string; roomId: string | null; attempt: number }) => Promise<SendOutcome>;

export interface RecordResult {
  entry: PendingEntry;
  /** true = 只在本地，**没有**同步到服务端（UI 必须显示 `message`）。 */
  localOnly: boolean;
  synced: boolean;
  message: string;
  /** 本次操作触发的淘汰计数（过期 / 容量），0 表示没有丢东西。 */
  dropped: { expired: number; overflow: number };
  /** >0 表示读到过损坏的本地队列并已重新开始（如实上报，不装作什么都没发生）。 */
  recoveredFromCorruption: string | null;
}

export interface FlushReport {
  attempted: number;
  synced: number;
  rejected: number;
  remaining: number;
  /** 遇到可重试失败即停手（网络断了不硬刷），其余保持 pending。 */
  stoppedByRetryableFailure: boolean;
  messages: string[];
}

export interface QueueStatus {
  pendingCount: number;
  syncedCount: number;
  rejectedCount: number;
  corrupted: boolean;
  corruptedReason: string | null;
  droppedExpired: number;
  droppedOverflow: number;
}

export interface PendingQueue {
  recordLocal(date: string, roomId: string | null): RecordResult;
  flush(send: Send): Promise<FlushReport>;
  /** UI 用：某天到底同步了没有。 */
  statusOf(date: string): { found: boolean; status: PendingStatus | 'none'; synced: boolean; message: string; attempts: number };
  entries(): PendingEntry[];
  status(): QueueStatus;
}

interface Loaded {
  file: PendingFile;
  corruptedReason: string | null;
}

function emptyFile(now: number): PendingFile {
  return { schemaVersion: PENDING_SCHEMA_VERSION, entries: [], droppedExpired: 0, droppedOverflow: 0, updatedAt: now };
}

export function createPendingQueue(options: {
  storage: PendingStorage;
  now?: () => number;
  maxEntries?: number;
  ttlDays?: number;
}): PendingQueue {
  const now = options.now ?? (() => Date.now());
  const maxEntries = options.maxEntries ?? MAX_PENDING_ENTRIES;
  const ttlDays = options.ttlDays ?? PENDING_TTL_DAYS;
  let corruptedReason: string | null = null;

  /** 损坏 ⇒ 用空队列继续，但**记住原因**并在每次返回里如实上报（不静默）。 */
  function load(): Loaded {
    const raw = options.storage.load();
    if (raw === null || raw === undefined) return { file: emptyFile(now()), corruptedReason: null };
    try {
      const candidate = raw as Partial<PendingFile> | null;
      if (candidate === null || typeof candidate !== 'object') throw new Error('not_object');
      if (candidate.schemaVersion !== PENDING_SCHEMA_VERSION) throw new Error('bad_schema_version');
      if (!Array.isArray(candidate.entries)) throw new Error('bad_entries');
      const entries: PendingEntry[] = [];
      for (const item of candidate.entries) {
        const entry = item as Partial<PendingEntry> | null;
        if (entry === null || typeof entry !== 'object' || typeof entry.date !== 'string') throw new Error('bad_entry');
        if (entry.status !== 'pending' && entry.status !== 'synced' && entry.status !== 'rejected') throw new Error('bad_entry_status');
        entries.push({
          date: entry.date,
          roomId: typeof entry.roomId === 'string' ? entry.roomId : null,
          status: entry.status,
          attempts: typeof entry.attempts === 'number' && Number.isFinite(entry.attempts) ? entry.attempts : 0,
          lastError: typeof entry.lastError === 'string' ? entry.lastError : null,
          localRecordedAt: typeof entry.localRecordedAt === 'number' ? entry.localRecordedAt : now(),
          syncedAt: typeof entry.syncedAt === 'number' ? entry.syncedAt : null,
        });
      }
      return {
        file: {
          schemaVersion: PENDING_SCHEMA_VERSION,
          entries,
          droppedExpired: typeof candidate.droppedExpired === 'number' ? candidate.droppedExpired : 0,
          droppedOverflow: typeof candidate.droppedOverflow === 'number' ? candidate.droppedOverflow : 0,
          updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : now(),
        },
        corruptedReason: null,
      };
    } catch (err) {
      corruptedReason = err instanceof Error ? err.message : 'unknown';
      return { file: emptyFile(now()), corruptedReason };
    }
  }

  function save(file: PendingFile): void {
    options.storage.save(JSON.parse(JSON.stringify(file)) as unknown);
  }

  /**
   * 有界裁剪（顺序即纪律）：
   *  ① 过窗（服务端必然拒绝）→ `droppedExpired`；
   *  ② 仍超容量 → 淘汰序 = 最旧的「已同步」→ 最旧的「已拒绝」→ 最旧的「待同步」⇒ `droppedOverflow`。
   * 淘汰**只计数**，绝不改状态假装成功。
   */
  function prune(file: PendingFile): { expired: number; overflow: number } {
    const today = localDayOf(now());
    const kept = file.entries.filter((e) => diffDays(today, e.date) <= ttlDays);
    const expired = file.entries.length - kept.length;
    let overflow = 0;
    if (kept.length > maxEntries) {
      const rank = (s: PendingStatus): number => (s === 'synced' ? 0 : s === 'rejected' ? 1 : 2);
      const order = [...kept].sort((a, b) => rank(a.status) - rank(b.status) || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      const drop = new Set(order.slice(0, kept.length - maxEntries));
      overflow = drop.size;
      file.entries = kept.filter((e) => !drop.has(e));
    } else {
      file.entries = kept;
    }
    file.droppedExpired += expired;
    file.droppedOverflow += overflow;
    file.updatedAt = now();
    return { expired, overflow };
  }

  function statusOf(date: string): { found: boolean; status: PendingStatus | 'none'; synced: boolean; message: string; attempts: number } {
    const { file } = load();
    const entry = file.entries.find((e) => e.date === date);
    if (entry === undefined) return { found: false, status: 'none', synced: false, message: LOCAL_ONLY_MESSAGE, attempts: 0 };
    if (entry.status === 'synced') return { found: true, status: 'synced', synced: true, message: SYNCED_MESSAGE, attempts: entry.attempts };
    if (entry.status === 'rejected') {
      return { found: true, status: 'rejected', synced: false, message: `未能同步（${entry.lastError ?? '已拒绝'}）`, attempts: entry.attempts };
    }
    return { found: true, status: 'pending', synced: false, message: LOCAL_ONLY_MESSAGE, attempts: entry.attempts };
  }

  return {
    recordLocal(date: string, roomId: string | null): RecordResult {
      const { file, corruptedReason: foundCorruption } = load();
      const before = { expired: 0, overflow: 0 };
      const today = localDayOf(now());
      // 超出补传窗口 ⇒ 服务端必然 400：**不入队冒充待同步**，当场如实上报并计数。
      if (diffDays(today, date) > ttlDays) {
        file.droppedExpired += 1;
        file.updatedAt = now();
        save(file);
        return {
          entry: {
            date,
            roomId: roomId ?? null,
            status: 'rejected',
            attempts: 0,
            lastError: 'CHECKIN_DATE_TOO_OLD',
            localRecordedAt: now(),
            syncedAt: null,
          },
          localOnly: true,
          synced: false,
          message: `已超出 ${ttlDays} 天同步窗口，无法上传`,
          dropped: { expired: 1, overflow: 0 },
          recoveredFromCorruption: foundCorruption,
        };
      }
      const existing = file.entries.find((e) => e.date === date);
      if (existing === undefined) {
        file.entries.push({ date, roomId: roomId ?? null, status: 'pending', attempts: 0, lastError: null, localRecordedAt: now(), syncedAt: null });
      }
      const dropped = prune(file);
      before.expired = dropped.expired;
      before.overflow = dropped.overflow;
      save(file);
      const entry = file.entries.find((e) => e.date === date) as PendingEntry;
      const synced = entry.status === 'synced';
      return {
        entry,
        localOnly: !synced,
        synced,
        message: entry.status === 'synced' ? SYNCED_MESSAGE : entry.status === 'rejected' ? `未能同步（${entry.lastError ?? '已拒绝'}）` : LOCAL_ONLY_MESSAGE,
        dropped: before,
        recoveredFromCorruption: foundCorruption,
      };
    },

    async flush(send: Send): Promise<FlushReport> {
      const { file } = load();
      prune(file);
      const report: FlushReport = { attempted: 0, synced: 0, rejected: 0, remaining: 0, stoppedByRetryableFailure: false, messages: [] };
      const pending = file.entries.filter((e) => e.status === 'pending').sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      for (const entry of pending) {
        report.attempted += 1;
        entry.attempts += 1;
        let outcome: SendOutcome;
        try {
          outcome = await send({ date: entry.date, roomId: entry.roomId, attempt: entry.attempts });
        } catch (err) {
          // 发送函数自己抛（例如 fetch 直接 reject）⇒ 按可重试处理，不误判为永久失败。
          outcome = { ok: false, retryable: true, code: err instanceof Error && err.name === 'AbortError' ? 'TIMEOUT' : 'ADDONS_UNAVAILABLE' };
        }
        if (outcome.ok) {
          entry.status = 'synced';
          entry.syncedAt = now();
          entry.lastError = null;
          report.synced += 1;
          report.messages.push(`${entry.date} ${SYNCED_MESSAGE}`);
          continue;
        }
        entry.lastError = outcome.code;
        if (outcome.retryable) {
          // 网络不可用：**停手**（不硬刷、不把后面的记录标成失败），保持 pending 等下次。
          report.stoppedByRetryableFailure = true;
          report.messages.push(`${entry.date} ${LOCAL_ONLY_MESSAGE}（${outcome.code}）`);
          break;
        }
        entry.status = 'rejected';
        report.rejected += 1;
        report.messages.push(`${entry.date} 被服务端拒绝（${outcome.code}）`);
      }
      file.updatedAt = now();
      save(file);
      report.remaining = file.entries.filter((e) => e.status === 'pending').length;
      return report;
    },

    statusOf,

    entries(): PendingEntry[] {
      return load().file.entries.map((e) => ({ ...e }));
    },

    status(): QueueStatus {
      const { file, corruptedReason: reason } = load();
      const count = (s: PendingStatus): number => file.entries.filter((e) => e.status === s).length;
      return {
        pendingCount: count('pending'),
        syncedCount: count('synced'),
        rejectedCount: count('rejected'),
        corrupted: reason !== null,
        corruptedReason: reason,
        droppedExpired: file.droppedExpired,
        droppedOverflow: file.droppedOverflow,
      };
    },
  };
}
