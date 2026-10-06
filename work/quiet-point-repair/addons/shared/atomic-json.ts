/**
 * 有界 JSON 落盘的**共用最小工具**（F4 / F8-c 用；F3 有自己的等价实现，**不改它**）。
 *
 * 沿用 F3 已验证的一致性纪律（`addons/f3/store.ts` 同款）：
 *  · 写临时文件 → `fsync` → 同目录 `rename`（原子替换）→ 才允许向调用方确认；
 *  · 超过字节上限**当场抛错**，调用方**不得** ACK 成功；
 *  · 启动清场：遗留的同进程临时文件**不算正式数据**；
 *  · 主 JSON 损坏只**如实上报**，绝不写空快照谎称成功（判定留给各 store）。
 *
 * 这些存储全部落在 `data-addons/` 与旧 `data/quiet.sqlite` **不同文件**，
 * 不动旧库 schema、不新增旧库表（红线：SCOPE_FINAL 14:38 第 2 条）。
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** 附加服务内各独立有界存储的**统一**错误类型（路由层按 `code` 映射 HTTP 状态）。 */
export class DataStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DataStoreError';
    this.code = code;
  }
}

export type ReadResult =
  | { kind: 'ok'; value: unknown }
  | { kind: 'missing' }
  | { kind: 'corrupted'; error: string };

/** 读 JSON；文件不存在 ≠ 损坏（前者是首次启动的正常状态）。 */
export function readJsonFile(filePath: string): ReadResult {
  if (!existsSync(filePath)) return { kind: 'missing' };
  try {
    return { kind: 'ok', value: JSON.parse(readFileSync(filePath, 'utf8')) as unknown };
  } catch (err) {
    return { kind: 'corrupted', error: err instanceof Error ? err.message : 'unknown' };
  }
}

/** 原子写；超限 ⇒ `STORE_CAPACITY`，IO 失败 ⇒ `STORE_UNAVAILABLE`（都可重试/可解释）。 */
export function writeJsonAtomic(filePath: string, value: unknown, maxBytes: number): void {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > maxBytes) {
    throw new DataStoreError('STORE_CAPACITY', `快照超过 ${maxBytes} 字节上限`);
  }
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}`;
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, json);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, filePath);
  } catch (err) {
    if (err instanceof DataStoreError) throw err;
    throw new DataStoreError('STORE_UNAVAILABLE', err instanceof Error ? err.message : '落盘失败');
  }
}

/** 启动清场：遗留的同进程临时文件不算正式数据。 */
export function sweepTemp(filePath: string): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  if (!existsSync(tmp)) return;
  try {
    unlinkSync(tmp);
  } catch {
    /* 清理失败不影响正式数据 */
  }
}

/** 当前文件字节数（不存在 = 0）。 */
export function fileBytes(filePath: string): number {
  try {
    return existsSync(filePath) ? statSync(filePath).size : 0;
  } catch {
    return 0;
  }
}
