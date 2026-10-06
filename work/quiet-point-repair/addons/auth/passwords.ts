/**
 * C-6 口令派生与会话 token 的**密码学底座**（Node 内置 `crypto`，**零新依赖**）。
 *
 * 纪律（SCOPE_FINAL §14:4x 第 3 条）：
 *  · 口令**绝不存明文** ⇒ scrypt + **每用户 16 字节随机盐**；
 *  · 比较用 **`timingSafeEqual`**（定时安全），长度不等先返回 false（`timingSafeEqual` 会抛）；
 *  · 会话 token 用 **`crypto.randomBytes(32)`**（256 bit），服务端**只存 sha256**；
 *  · 明文口令 / 明文 token **绝不进日志、绝不进错误消息**；本文件**没有任何 `console.*`**。
 *
 * 为什么 scrypt 走**异步**：N=16384 的单次派生约几十毫秒，同步版会卡住整个事件循环
 * （附加服务同时还在服务 F2/F3/F4/F8-c）⇒ 一律用 callback 版包 Promise。
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

/** scrypt 参数：`128·N·r = 16 MiB`，`maxmem` 给到 64 MiB 留足余量。 */
export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keylen: number;
}

export const SCRYPT_PARAMS: ScryptParams = { N: 16_384, r: 8, p: 1, keylen: 64 };
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
/** 每用户随机盐长度（字节）。 */
export const SALT_BYTES = 16;

/** 落盘的**口令材料**（参数一并存 ⇒ 以后调参也能验证旧口令）。 */
export interface PasswordRecord extends ScryptParams {
  kdf: 'scrypt';
  /** hex（32 字符 = 16 字节）。 */
  salt: string;
  /** hex（128 字符 = 64 字节）。 */
  hash: string;
}

export interface PasswordKdf {
  hash(password: string): Promise<PasswordRecord>;
  verify(password: string, record: PasswordRecord): Promise<boolean>;
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM }, (err, key) => {
      if (err !== null && err !== undefined) reject(err);
      else resolve(key);
    });
  });
}

/**
 * 真实 KDF（生产路径）。
 * `verify` 的**参数取自记录本身**（不是当前默认值）⇒ 记录里存的参数才是唯一真源。
 */
export function createScryptKdf(params: ScryptParams = SCRYPT_PARAMS): PasswordKdf {
  return {
    async hash(password: string): Promise<PasswordRecord> {
      const salt = randomBytes(SALT_BYTES);
      const key = await derive(password, salt, params);
      return { kdf: 'scrypt', ...params, salt: salt.toString('hex'), hash: key.toString('hex') };
    },
    async verify(password: string, record: PasswordRecord): Promise<boolean> {
      const salt = Buffer.from(record.salt, 'hex');
      const expected = Buffer.from(record.hash, 'hex');
      const key = await derive(password, salt, record);
      if (key.length !== expected.length) return false;
      return timingSafeEqual(key, expected);
    },
  };
}

/**
 * **反枚举用**的固定假记录：账号不存在时也照样跑一次同代价的 scrypt 校验，
 * 让"账号不存在"与"口令错误"在**耗时上不可区分**（响应体本来就逐字相同）。
 *
 * 它是**故意公开**的常量（不是密钥）：`verify` 对它**永远**返回 false。
 */
export const AUTH_DUMMY_PASSWORD_RECORD: PasswordRecord = {
  kdf: 'scrypt',
  ...SCRYPT_PARAMS,
  salt: '00000000000000000000000000000000',
  hash: '00'.repeat(64),
};

/** 会话 token（256 bit 熵，base64url → 43 字符）。 */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}
