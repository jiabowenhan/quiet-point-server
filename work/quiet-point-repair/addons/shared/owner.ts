/**
 * 附加服务（`addons/`）与旧 `server/**` 的**唯一**共享面：owner 语义 + 统一错误体。
 *
 * 红线（Sol `SOL_DESIGN_F2_F6_F7_F3.md` §0.1 第 1 条）：
 *  · 现有 `server/**` 全部字节不动；本文件**只读导入**纯常量（`shared/study-model.ts`，无 IO），
 *    绝不 import `study-store.ts` / `study-routes.ts`（它们会在导入期初始化数据库写路径）。
 *  · `KEY_PATTERN` 是 `server/study-routes.ts:29` 的**私有**常量，此处按原文复制一份（见
 *    `addons/tests/owner-equivalence.test.ts` 的等价反例），不改旧鉴权。
 */

import { STATUS_BY_CODE, type StudyErrorCode } from '../../shared/study-model.js';

/** 与 `server/study-routes.ts:29` 逐字相同的凭据形状（复制，不改旧文件）。 */
export const KEY_PATTERN = /^[A-Za-z0-9_\-+/=]{22,200}$/;

/** 附加服务专用错误码（旧 `StudyErrorCode` 之外的部分；同码时沿用旧状态码表）。 */
export type AddonErrorCode =
  | StudyErrorCode
  | 'PAYLOAD_TOO_LARGE_PASSPORTS'
  | 'NON_REAL_REPORT'
  | 'AGGREGATE_CONTRACT'
  | 'EVIDENCE_MISMATCH'
  | 'ROOM_SESSION_MISMATCH'
  | 'TERMINAL_SEQ_REGRESSION'
  | 'WINDOW_REGRESSION'
  | 'STORE_UNAVAILABLE'
  | 'STORE_CAPACITY'
  | 'SCHEMA_VERSION_UNSUPPORTED'
  /* F4 打卡（新增；不改上面任何既有码与状态映射） */
  | 'CHECKIN_DATE_FUTURE'
  | 'CHECKIN_DATE_TOO_OLD'
  /* C6 / F3 canonical（新增；不改上面任何既有码与状态映射） */
  | 'PROCESSING_MISMATCH'
  /* C-6 注册/登录（新增；不改上面任何既有码与状态映射） */
  | 'AUTH_USERNAME_INVALID'
  | 'AUTH_PASSWORD_TOO_SHORT'
  | 'AUTH_PASSWORD_TOO_LONG'
  | 'AUTH_PASSWORD_WEAK'
  | 'AUTH_USERNAME_TAKEN'
  | 'AUTH_INVALID_CREDENTIALS'
  | 'AUTH_TOKEN_MISSING'
  | 'AUTH_TOKEN_INVALID'
  | 'AUTH_TOKEN_EXPIRED'
  | 'AUTH_TOKEN_REVOKED';

const ADDON_STATUS: Partial<Record<AddonErrorCode, number>> = {
  PAYLOAD_TOO_LARGE_PASSPORTS: 413,
  NON_REAL_REPORT: 400,
  AGGREGATE_CONTRACT: 400,
  EVIDENCE_MISMATCH: 409,
  ROOM_SESSION_MISMATCH: 404,
  TERMINAL_SEQ_REGRESSION: 409,
  WINDOW_REGRESSION: 409,
  STORE_UNAVAILABLE: 503,
  STORE_CAPACITY: 507,
  SCHEMA_VERSION_UNSUPPORTED: 400,
  CHECKIN_DATE_FUTURE: 400,
  CHECKIN_DATE_TOO_OLD: 400,
  PROCESSING_MISMATCH: 409,
  /* C-6 注册/登录（新增；不改上面任何既有码与状态映射） */
  AUTH_USERNAME_INVALID: 400,
  AUTH_PASSWORD_TOO_SHORT: 400,
  AUTH_PASSWORD_TOO_LONG: 400,
  AUTH_PASSWORD_WEAK: 400,
  AUTH_USERNAME_TAKEN: 409,
  AUTH_INVALID_CREDENTIALS: 401,
  AUTH_TOKEN_MISSING: 401,
  AUTH_TOKEN_INVALID: 401,
  AUTH_TOKEN_EXPIRED: 401,
  AUTH_TOKEN_REVOKED: 401,
};

export class AddonError extends Error {
  readonly code: AddonErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  constructor(code: AddonErrorCode, message: string) {
    super(message);
    this.name = 'AddonError';
    this.code = code;
    this.status = ADDON_STATUS[code] ?? STATUS_BY_CODE[code as StudyErrorCode] ?? 400;
    this.retryable = this.status === 503;
  }
}

export function errorBody(err: AddonError): { error: { code: string; message: string; retryable: boolean } } {
  return { error: { code: err.code, message: err.message, retryable: err.retryable } };
}

/**
 * 与 `server/study-routes.ts:32–42` **同语义**的只读适配器：
 *  · 缺头 / 空串 ⇒ `STUDY_KEY_REQUIRED`（401）
 *  · 非字符串或不过 `KEY_PATTERN` ⇒ `STUDY_KEY_INVALID`（401）
 *  · 合法 ⇒ `sha256(明文)`（十六进制小写），**明文 key 绝不落盘、绝不进日志**
 */
export function ownerHashFrom(headers: Record<string, unknown>, sha256: (value: string) => string): string {
  const raw = headers['x-study-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null || value === '') {
    throw new AddonError('STUDY_KEY_REQUIRED', '缺少 X-Study-Key 请求头');
  }
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    throw new AddonError('STUDY_KEY_INVALID', 'X-Study-Key 格式非法');
  }
  return sha256(value);
}
