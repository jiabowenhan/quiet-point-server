/**
 * C-6 注册 / 登录 · **契约与纯规则**（无 IO、无 async、可直接单测）。
 *
 * 范围（`work\SCOPE_FINAL.md` §15:0x 最简版）：
 *  · 自选账号名 + 自设口令；**无手机号 / 无邮箱 / 无验证码 / 无找回**；
 *  · 口令 scrypt + 随机盐（Node 内置 crypto，零新依赖）；定时安全比较；token 不落日志；
 *  · **只增量新增**：本目录不 import `server/**`、不碰 `X-Study-Key`、不碰旧库。
 *
 * 本文件只做三件事：**常量**、**账号名/口令的纯规则**、**请求/响应形状（zod，全 strict）**。
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// schema 版本
// ---------------------------------------------------------------------------

export const AUTH_REGISTER_SCHEMA_VERSION = 'auth-register-v1';
export const AUTH_LOGIN_SCHEMA_VERSION = 'auth-login-v1';
export const AUTH_REGISTER_ACK_SCHEMA_VERSION = 'auth-register-ack-v1';
export const AUTH_SESSION_SCHEMA_VERSION = 'auth-session-v1';
export const AUTH_LOGOUT_SCHEMA_VERSION = 'auth-logout-v1';

/**
 * 诚实口径（UI / 设计文档 / 报告三处逐字一致，**不得**宣称"企业级安全"）。
 * 服务端也把这句话放进注册与建会话的响应里，避免只有前端在说、后端在沉默。
 */
export const AUTH_HONEST_NOTICE =
  '演示级账号体系：无邮箱/短信验证、无找回密码、无多设备风控；请勿使用你在别处的真实密码。';

// ---------------------------------------------------------------------------
// 会话与 token
// ---------------------------------------------------------------------------

/** 会话绝对有效期：**2 小时**（不滑动续期 —— 简单、可预期、可测）。 */
export const AUTH_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
/** token 熵：32 字节 = 256 bit ⇒ base64url 恰 43 字符。 */
export const AUTH_TOKEN_BYTES = 32;
/** token 形状（base64url，43 字符）：形状不对 ⇒ `AUTH_TOKEN_INVALID`，**不去查表**。 */
export const AUTH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** 同一账号最多保留的会话条数（超出按 `issuedAt` 淘汰**最旧**的）。 */
export const AUTH_MAX_SESSIONS_PER_USER = 8;
/** 全局会话条数上限（含"已登出但未过期"的记录）；超限 ⇒ 507，不静默踢掉别人的会话。 */
export const AUTH_MAX_SESSIONS_TOTAL = 512;

// ---------------------------------------------------------------------------
// 账号名
// ---------------------------------------------------------------------------

export const USERNAME_MIN_CODEPOINTS = 3;
export const USERNAME_MAX_CODEPOINTS = 24;
/** 首字符：中文/字母/数字；其后：中文/字母/数字/下划线/连字符（`u` 标志 ⇒ 中文账号名合法）。 */
export const USERNAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u;

export type UsernameResult =
  | { ok: true; username: string; key: string }
  | { ok: false; code: 'AUTH_USERNAME_INVALID'; message: string };

/**
 * 账号名规则（**纯函数**）：
 *  ① NFKC 归一化后必须与原串逐字相等（否则 400：避免"看起来一样、其实是两个账号"）；
 *  ② 码点长度 3–24；③ 形状见 `USERNAME_PATTERN`；④ **唯一性键** = NFKC(原串).toLowerCase()。
 *
 * 唯一性键做小写折叠 ⇒ `alice` / `Alice` / `ALICE` 视为**同一个账号**（防混淆仿冒）；
 * 展示名保留用户输入的大小写。
 */
export function normalizeUsername(raw: unknown): UsernameResult {
  if (typeof raw !== 'string') return { ok: false, code: 'AUTH_USERNAME_INVALID', message: '账号名必须是字符串' };
  const username = raw;
  if (username.normalize('NFKC') !== username) {
    return { ok: false, code: 'AUTH_USERNAME_INVALID', message: '账号名含全角或兼容字符，请改用标准字符重新输入' };
  }
  const length = [...username].length;
  if (length < USERNAME_MIN_CODEPOINTS || length > USERNAME_MAX_CODEPOINTS) {
    return { ok: false, code: 'AUTH_USERNAME_INVALID', message: `账号名长度需为 ${USERNAME_MIN_CODEPOINTS}–${USERNAME_MAX_CODEPOINTS} 个字符` };
  }
  if (!USERNAME_PATTERN.test(username)) {
    return { ok: false, code: 'AUTH_USERNAME_INVALID', message: '账号名只能用中文、字母、数字、下划线与连字符，且需以中文/字母/数字开头' };
  }
  return { ok: true, username, key: username.toLowerCase() };
}

/** 供登录使用：只算唯一性键（形状不合法时返回 null；**不区分**账号是否存在）。 */
export function usernameKeyOrNull(raw: unknown): string | null {
  const result = normalizeUsername(raw);
  return result.ok ? result.key : null;
}

// ---------------------------------------------------------------------------
// 口令
// ---------------------------------------------------------------------------

export const PASSWORD_MIN_CODEPOINTS = 8;
export const PASSWORD_MAX_CODEPOINTS = 128;
/** UTF-8 字节上限（防御：不让超长输入拖垮 scrypt；与长度上限双保险）。 */
export const PASSWORD_MAX_BYTES = 1024;

/** 内置常见弱口令（小写比对）。**故意短小**：只挡"一眼就知道会被撞库"的那些。 */
export const COMMON_PASSWORDS: readonly string[] = [
  'password', 'password1', 'passw0rd', 'p@ssw0rd', '12345678', '123456789', '1234567890',
  'qwertyui', 'qwerty123', 'qwertyuiop', 'iloveyou', 'admin123', 'administrator', 'letmein1',
  'welcome1', 'abc12345', 'abcd1234', 'a1234567', '1qaz2wsx', 'zaq12wsx', '11111111',
  '00000000', '88888888', '66666666', 'sunshine', 'princess', 'football', 'superman',
  'monkey123', 'woaini1314', '5201314520',
];

export type PasswordCode = 'AUTH_PASSWORD_TOO_SHORT' | 'AUTH_PASSWORD_TOO_LONG' | 'AUTH_PASSWORD_WEAK';
export type PasswordResult = { ok: true } | { ok: false; code: PasswordCode; message: string };

/** 控制字符（含 NUL）—— 混进来一律拒绝（它在 JSON/日志/终端里都容易惹事）。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** 整串是同一字符（如 `aaaaaaaa`）。 */
function isSingleCharacter(value: string): boolean {
  return [...new Set([...value])].length === 1;
}

/** 整串是连号（升序或降序且步长恒为 1，如 `abcdefgh` / `98765432`）。 */
function isSequentialRun(value: string): boolean {
  const points = [...value].map((c) => c.codePointAt(0) ?? 0);
  if (points.length < 6) return false;
  const step = points[1]! - points[0]!;
  if (step !== 1 && step !== -1) return false;
  for (let i = 2; i < points.length; i += 1) {
    if (points[i]! - points[i - 1]! !== step) return false;
  }
  return true;
}

/**
 * 口令规则（**纯函数**，判定顺序写死在注释里，测试逐条钉）：
 *  ① 含控制字符 ⇒ WEAK(control_chars)
 *  ② 码点长度 < 8 ⇒ TOO_SHORT；> 128 或 UTF-8 字节 > 1024 ⇒ TOO_LONG
 *  ③ 单一字符 / 常见弱口令 / 纯数字且 ≤10 位 / 连号 / 含账号名 ⇒ WEAK
 *
 * 口令本身**绝不**出现在任何返回的 message 里。
 */
export function checkPassword(password: unknown, username: string | null = null): PasswordResult {
  if (typeof password !== 'string') return { ok: false, code: 'AUTH_PASSWORD_WEAK', message: '口令必须是字符串' };
  if (CONTROL_CHARS.test(password)) {
    return { ok: false, code: 'AUTH_PASSWORD_WEAK', message: '口令不能包含控制字符或换行' };
  }
  const length = [...password].length;
  if (length < PASSWORD_MIN_CODEPOINTS) {
    return { ok: false, code: 'AUTH_PASSWORD_TOO_SHORT', message: `口令至少 ${PASSWORD_MIN_CODEPOINTS} 位` };
  }
  if (length > PASSWORD_MAX_CODEPOINTS || Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    return { ok: false, code: 'AUTH_PASSWORD_TOO_LONG', message: `口令最多 ${PASSWORD_MAX_CODEPOINTS} 位` };
  }
  const lower = password.toLowerCase();
  if (isSingleCharacter(password)) {
    return { ok: false, code: 'AUTH_PASSWORD_WEAK', message: '口令不能是同一个字符重复' };
  }
  if (COMMON_PASSWORDS.includes(lower)) {
    return { ok: false, code: 'AUTH_PASSWORD_WEAK', message: '这是常见弱口令，请换一个' };
  }
  if (/^\d+$/.test(password)) {
    return { ok: false, code: 'AUTH_PASSWORD_WEAK', message: '口令不能是纯数字' };
  }
  if (isSequentialRun(password)) {
    return { ok: false, code: 'AUTH_PASSWORD_WEAK', message: '口令不能是连续递增或递减的字符' };
  }
  if (username !== null && username !== '') {
    const name = username.toLowerCase();
    if (lower === name || (name.length >= 3 && lower.includes(name))) {
      return { ok: false, code: 'AUTH_PASSWORD_WEAK', message: '口令不能包含账号名' };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Authorization: Bearer <token>
// ---------------------------------------------------------------------------

export type BearerResult =
  | { ok: true; token: string }
  | { ok: false; code: 'AUTH_TOKEN_MISSING' | 'AUTH_TOKEN_INVALID'; message: string };

/**
 * 解析 `Authorization: Bearer <token>`：
 *  · 缺头 / 空串 ⇒ `AUTH_TOKEN_MISSING`
 *  · scheme 不是 `Bearer`（含"拿 X-Study-Key 来冒充"）或 token 形状不合 ⇒ `AUTH_TOKEN_INVALID`
 * **明文 token 只会在这条路径上短暂存在，绝不进日志、绝不回显。**
 */
export function bearerTokenFrom(headers: Record<string, unknown>): BearerResult {
  const raw = headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null || value === '') {
    return { ok: false, code: 'AUTH_TOKEN_MISSING', message: '缺少 Authorization: Bearer 请求头' };
  }
  if (typeof value !== 'string') {
    return { ok: false, code: 'AUTH_TOKEN_INVALID', message: 'Authorization 请求头格式非法' };
  }
  const match = /^Bearer[ ]+(\S+)$/i.exec(value.trim());
  if (match === null) {
    return { ok: false, code: 'AUTH_TOKEN_INVALID', message: 'Authorization 只接受 Bearer 方案' };
  }
  const token = match[1] as string;
  if (!AUTH_TOKEN_PATTERN.test(token)) {
    return { ok: false, code: 'AUTH_TOKEN_INVALID', message: '会话 token 形状非法' };
  }
  return { ok: true, token };
}

// ---------------------------------------------------------------------------
// 请求形状（**全部 strict**：出现未声明字段一律 400）
// ---------------------------------------------------------------------------

export const registerRequestSchema = z
  .object({
    schemaVersion: z.literal(AUTH_REGISTER_SCHEMA_VERSION),
    username: z.string(),
    password: z.string(),
  })
  .strict();
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z
  .object({
    schemaVersion: z.literal(AUTH_LOGIN_SCHEMA_VERSION),
    username: z.string(),
    password: z.string(),
  })
  .strict();
export type LoginRequest = z.infer<typeof loginRequestSchema>;

// ---------------------------------------------------------------------------
// 响应形状
// ---------------------------------------------------------------------------

export interface RegisterAck {
  schemaVersion: typeof AUTH_REGISTER_ACK_SCHEMA_VERSION;
  created: true;
  username: string;
  createdAt: number;
  serverSeq: number;
  /** **注册不签发 token**（注册与登录是两个明确步骤，便于真机分别取证）。 */
  sessionIssued: false;
  notice: string;
}

export interface SessionAck {
  schemaVersion: typeof AUTH_SESSION_SCHEMA_VERSION;
  authenticated: true;
  /** 明文 token **只在这一次响应里出现**；服务端落盘的只有它的 sha256。 */
  token: string;
  username: string;
  issuedAt: number;
  expiresAt: number;
  ttlMs: number;
  notice: string;
}

/** 会话校验视图：**不回显 token**（既没必要，也免得被顺手写进日志）。 */
export interface SessionView {
  schemaVersion: typeof AUTH_SESSION_SCHEMA_VERSION;
  authenticated: true;
  username: string;
  issuedAt: number;
  expiresAt: number;
  remainingMs: number;
  notice: string;
}

export interface LogoutAck {
  schemaVersion: typeof AUTH_LOGOUT_SCHEMA_VERSION;
  /** 本次调用是否**真的**完成了撤销。 */
  revoked: boolean;
  /** true = 这个 token 之前已经登出过（**幂等**，不是错误）。 */
  alreadyRevoked: boolean;
}
