/**
 * C-6 账号与会话的**独立有界存储**（`data-addons/auth-v1.json`）。
 *
 * 红线：
 *  · **不碰** `data/quiet.sqlite`（本轮根本不打开它）、**不碰** `server/**`、**不碰** `X-Study-Key`；
 *  · 只存 `salt / hash / kdf 参数 / 时间戳`；**明文口令与明文 token 一个字节都不落盘**
 *    （会话表的主键就是 `sha256(token)`）；
 *  · **原子写**：写临时文件 → `fsync` → 同目录 `rename`（复用 `shared/atomic-json.ts`，与 F3/F4/F8-c 同款纪律）；
 *  · **有界**：用户 ≤64、会话 ≤512、文件 ≤512 KiB；超限 ⇒ `STORE_CAPACITY`(507)，不静默淘汰别人的账号；
 *  · **损坏纪律**：快照损坏只**如实上报** `STORE_UNAVAILABLE`(503)，**绝不写回空快照**，
 *    也**绝不**把损坏说成"口令错误"。
 *
 * ★ **并发注册幂等的关键**：`insertUser()` 是**纯同步**的"检查—提交"临界区（内部没有任何 `await`）。
 *   scrypt 派生在调用方（routes）里 await，**落在临界区之外**；因此 Node 单线程下两个并发注册
 *   **不可能**同时通过唯一性检查 —— 一个成功、另一个必然拿到 `AUTH_USERNAME_TAKEN`。
 */

import { AUTH_MAX_SESSIONS_PER_USER, AUTH_MAX_SESSIONS_TOTAL } from './contract.js';
import { DataStoreError, fileBytes, readJsonFile, sweepTemp, writeJsonAtomic } from '../shared/atomic-json.js';
import type { PasswordRecord } from './passwords.js';

export const AUTH_STORE_SCHEMA_VERSION = 1;
/** 用户数上限（超限 ⇒ 507，不静默淘汰）。 */
export const MAX_AUTH_USERS = 64;
/** 快照字节上限。 */
export const MAX_AUTH_BYTES = 512 * 1024;

/** 落盘的用户记录（**没有**任何明文口令材料）。 */
export interface AuthUserRecord {
  /** 展示名（保留用户输入的大小写）。 */
  username: string;
  /** 唯一性键（NFKC + 小写折叠）；同时是 `users` 的 map key。 */
  key: string;
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  keylen: number;
  salt: string;
  hash: string;
  createdAt: number;
  updatedAt: number;
  serverSeq: number;
}

/** 落盘的会话记录（**主键是 token 的 sha256**，不是 token 本身）。 */
export interface AuthSessionRecord {
  key: string;
  issuedAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

interface AuthStoreFile {
  schemaVersion: number;
  serverSeqHighWater: number;
  users: Record<string, AuthUserRecord>;
  sessions: Record<string, AuthSessionRecord>;
  updatedAt: number;
}

export interface AuthStoreStatus {
  corrupted: boolean;
  corruptedReason: string | null;
  userCount: number;
  sessionCount: number;
  activeSessionCount: number;
  serverSeqHighWater: number;
  bytes: number;
}

/** 插入用户/会话时的输入（口令材料由调用方用 KDF 生成）。 */
export interface InsertUserInput {
  username: string;
  key: string;
  record: PasswordRecord;
}

export interface InsertSessionInput {
  tokenHash: string;
  key: string;
  issuedAt: number;
  expiresAt: number;
}

export class AuthStore {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly maxUsers: number;
  private data: AuthStoreFile | null = null;
  private corrupted = false;
  private corruptedReason: string | null = null;

  constructor(options: { filePath: string; now?: () => number; maxBytes?: number; maxUsers?: number }) {
    this.filePath = options.filePath;
    this.now = options.now ?? (() => Date.now());
    this.maxBytes = options.maxBytes ?? MAX_AUTH_BYTES;
    this.maxUsers = options.maxUsers ?? MAX_AUTH_USERS;
  }

  private empty(): AuthStoreFile {
    return { schemaVersion: AUTH_STORE_SCHEMA_VERSION, serverSeqHighWater: 0, users: {}, sessions: {}, updatedAt: this.now() };
  }

  /** 懒加载；损坏**只标记**，绝不写回空快照（沿用 F3/F4 纪律）。 */
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
      const candidate = read.value as Partial<AuthStoreFile> | null;
      if (candidate === null || typeof candidate !== 'object') throw new Error('not_object');
      if (candidate.schemaVersion !== AUTH_STORE_SCHEMA_VERSION) throw new Error('bad_schema_version');
      if (typeof candidate.serverSeqHighWater !== 'number' || !Number.isFinite(candidate.serverSeqHighWater)) {
        throw new Error('bad_high_water');
      }
      if (candidate.users === null || typeof candidate.users !== 'object') throw new Error('bad_users');
      if (candidate.sessions === null || typeof candidate.sessions !== 'object') throw new Error('bad_sessions');
      this.data = {
        schemaVersion: AUTH_STORE_SCHEMA_VERSION,
        serverSeqHighWater: candidate.serverSeqHighWater,
        users: candidate.users as Record<string, AuthUserRecord>,
        sessions: candidate.sessions as Record<string, AuthSessionRecord>,
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

  /**
   * 路由在**任何**判定之前调用它：快照损坏 ⇒ 立刻 `STORE_UNAVAILABLE`(503)。
   * 这道闸门的意义是**不让损坏被误读成业务结论** —— 例如"查不到用户"绝不能被说成"口令错误"。
   */
  assertUsable(): void {
    this.requireData();
  }

  /** 快照不可用 ⇒ 一律 503（**绝不**降级成"口令错误"或"没有这个账号"）。 */
  private requireData(): AuthStoreFile {
    this.load();
    if (this.corrupted || this.data === null) {
      throw new DataStoreError('STORE_UNAVAILABLE', `账号快照不可用：${this.corruptedReason ?? 'corrupted'}`);
    }
    return this.data;
  }

  status(): AuthStoreStatus {
    this.load();
    const now = this.now();
    const sessions = this.data === null ? {} : this.data.sessions;
    const all = Object.values(sessions);
    return {
      corrupted: this.corrupted,
      corruptedReason: this.corruptedReason,
      userCount: this.data === null ? 0 : Object.keys(this.data.users).length,
      sessionCount: all.length,
      activeSessionCount: all.filter((s) => s.revokedAt === null && s.expiresAt > now).length,
      serverSeqHighWater: this.data?.serverSeqHighWater ?? 0,
      bytes: fileBytes(this.filePath),
    };
  }

  /** 只读：账号名（**仅供测试/运维核对，不进任何 HTTP 响应**）。 */
  usernames(): string[] {
    this.load();
    if (this.data === null) return [];
    return Object.values(this.data.users).map((u) => u.username);
  }

  /** 只读：口令材料（**仅供测试核对"重注册不改原记录"**，不进任何 HTTP 响应）。 */
  userRecord(key: string): AuthUserRecord | null {
    this.load();
    if (this.data === null) return null;
    return this.data.users[key] ?? null;
  }

  findUser(key: string): AuthUserRecord | null {
    this.load();
    if (this.data === null) return null;
    return this.data.users[key] ?? null;
  }

  /**
   * 注册的**临界区**（纯同步、内部零 `await`）：
   *  ① 再次确认唯一性（调用方在 await scrypt 之前可能已经查过一次，这里必须**再查**）；
   *  ② 分配 `serverSeq`、组装 next、`writeJsonAtomic`（同步）→ 成功后才提交内存态。
   * 任何失败路径都**不改动** `this.data`。
   */
  insertUser(input: InsertUserInput): AuthUserRecord {
    const data = this.requireData();
    if (data.users[input.key] !== undefined) {
      throw new DataStoreError('AUTH_USERNAME_TAKEN', `账号名 ${input.username} 已被使用`);
    }
    if (Object.keys(data.users).length >= this.maxUsers) {
      throw new DataStoreError('STORE_CAPACITY', `账号数已达 ${this.maxUsers} 上限`);
    }
    const at = this.now();
    const serverSeq = data.serverSeqHighWater + 1;
    const record: AuthUserRecord = {
      username: input.username,
      key: input.key,
      kdf: input.record.kdf,
      N: input.record.N,
      r: input.record.r,
      p: input.record.p,
      keylen: input.record.keylen,
      salt: input.record.salt,
      hash: input.record.hash,
      createdAt: at,
      updatedAt: at,
      serverSeq,
    };
    const next: AuthStoreFile = {
      schemaVersion: AUTH_STORE_SCHEMA_VERSION,
      serverSeqHighWater: serverSeq,
      users: { ...data.users, [input.key]: record },
      sessions: this.pruneSessions(data.sessions, at),
      updatedAt: at,
    };
    sweepTemp(this.filePath);
    writeJsonAtomic(this.filePath, next, this.maxBytes);
    this.data = next;
    return record;
  }

  findSession(tokenHash: string): AuthSessionRecord | null {
    this.load();
    if (this.data === null) return null;
    return this.data.sessions[tokenHash] ?? null;
  }

  /**
   * 建立会话（临界区，纯同步）：先裁掉已过期的记录，再按**每账号 8 条**淘汰最旧的，
   * 最后检查全局上限（含"已登出但未过期"的记录）—— 超限**报 507**，不静默踢掉别人的会话。
   */
  insertSession(input: InsertSessionInput): AuthSessionRecord {
    const data = this.requireData();
    const at = this.now();
    const sessions = this.pruneSessions(data.sessions, at);

    // 每账号上限：按 issuedAt 淘汰最旧的（含已撤销但未过期的记录 ⇒ 文件大小有界）。
    const mine = Object.keys(sessions).filter((hash) => sessions[hash]!.key === input.key);
    if (mine.length >= AUTH_MAX_SESSIONS_PER_USER) {
      mine.sort((a, b) => (sessions[a]!.issuedAt - sessions[b]!.issuedAt));
      for (const hash of mine.slice(0, mine.length - AUTH_MAX_SESSIONS_PER_USER + 1)) delete sessions[hash];
    }
    if (Object.keys(sessions).length >= AUTH_MAX_SESSIONS_TOTAL) {
      throw new DataStoreError('STORE_CAPACITY', `会话数已达 ${AUTH_MAX_SESSIONS_TOTAL} 上限`);
    }

    const record: AuthSessionRecord = {
      key: input.key,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      revokedAt: null,
    };
    const next: AuthStoreFile = {
      schemaVersion: AUTH_STORE_SCHEMA_VERSION,
      serverSeqHighWater: data.serverSeqHighWater,
      users: data.users,
      sessions: { ...sessions, [input.tokenHash]: record },
      updatedAt: at,
    };
    sweepTemp(this.filePath);
    writeJsonAtomic(this.filePath, next, this.maxBytes);
    this.data = next;
    return record;
  }

  /** 撤销会话。返回 `null` = 没有这条会话；否则告知这次是否**真的**做了撤销（幂等语义）。 */
  revokeSession(tokenHash: string, at: number = this.now()): 'revoked' | 'already' | null {
    const data = this.requireData();
    const existing = data.sessions[tokenHash];
    if (existing === undefined) return null;
    if (existing.revokedAt !== null) return 'already';
    const next: AuthStoreFile = {
      schemaVersion: AUTH_STORE_SCHEMA_VERSION,
      serverSeqHighWater: data.serverSeqHighWater,
      users: data.users,
      sessions: { ...data.sessions, [tokenHash]: { ...existing, revokedAt: at } },
      updatedAt: at,
    };
    sweepTemp(this.filePath);
    writeJsonAtomic(this.filePath, next, this.maxBytes);
    this.data = next;
    return 'revoked';
  }

  /** 有界保留：丢掉 `expiresAt <= now` 的记录（**已登出但未过期**的保留 ⇒ "二次登出"仍可幂等回答）。 */
  private pruneSessions(sessions: Record<string, AuthSessionRecord>, at: number): Record<string, AuthSessionRecord> {
    const kept: Record<string, AuthSessionRecord> = {};
    for (const [hash, record] of Object.entries(sessions)) {
      if (record.expiresAt <= at) continue;
      kept[hash] = record;
    }
    return kept;
  }
}
