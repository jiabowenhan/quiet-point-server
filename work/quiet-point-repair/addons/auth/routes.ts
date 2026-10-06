/**
 * C-6 新增端点（**只挂在 3002 附加服务**上；绝不在 `server/index.ts` 挂路由）：
 *
 *   POST /v1/auth/register  —— 注册（账号名 + 口令；唯一性校验）
 *   POST /v1/auth/login     —— 登录（发会话 token）
 *   GET  /v1/auth/session   —— 会话校验
 *   POST /v1/auth/logout    —— 登出（撤销 token，幂等）
 *
 * 纪律：
 *  · **不读也不要求 `X-Study-Key`** —— 账号体系与既有匿名鉴权是**两条互不干扰的轴**（有 HTTP 反证）；
 *  · **本文件没有任何 `console.*`** ⇒ token / 口令在服务端**结构上不可能**被打印（门禁用源码扫描钉死）；
 *  · 注册的"检查—提交"是**同步临界区**（见 `store.insertUser`），scrypt 派生在临界区**之外** ⇒
 *    并发注册**恰好一个成功**，且**绝不可能**覆盖既有账号的口令；
 *  · 登录失败**只有一种**响应（账号不存在 vs 口令错误逐字相同），且账号不存在时**照跑一次 scrypt**
 *    （`AUTH_DUMMY_PASSWORD_RECORD`）⇒ 不通过响应体或耗时泄露"账号是否存在"。
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AddonError, errorBody } from '../shared/owner.js';
import { DataStoreError } from '../shared/atomic-json.js';
import {
  AUTH_HONEST_NOTICE,
  AUTH_LOGOUT_SCHEMA_VERSION,
  AUTH_REGISTER_ACK_SCHEMA_VERSION,
  AUTH_SESSION_SCHEMA_VERSION,
  AUTH_SESSION_TTL_MS,
  bearerTokenFrom,
  checkPassword,
  loginRequestSchema,
  normalizeUsername,
  registerRequestSchema,
  type LogoutAck,
  type RegisterAck,
  type SessionAck,
  type SessionView,
} from './contract.js';
import { AUTH_DUMMY_PASSWORD_RECORD, createScryptKdf, generateSessionToken, type PasswordKdf } from './passwords.js';
import { AuthStore } from './store.js';

export interface AuthRouterOptions {
  store: AuthStore;
  now?: () => number;
  /** 可注入（测试用假 KDF 计数"是否真的跑了一次校验"）；生产用 scrypt。 */
  kdf?: PasswordKdf;
  /** 可注入 token 生成器（默认 `crypto.randomBytes(32).toString('base64url')`）。 */
  tokenFactory?: () => string;
}

/** `DataStoreError` → HTTP 语义（与 F3/F4 同款映射；新码只在 `shared/owner.ts` 里增量登记）。 */
function translate(err: unknown): AddonError {
  if (err instanceof AddonError) return err;
  if (err instanceof DataStoreError) {
    const known = ['STORE_UNAVAILABLE', 'STORE_CAPACITY', 'AUTH_USERNAME_TAKEN'];
    if (known.includes(err.code)) return new AddonError(err.code as 'STORE_UNAVAILABLE', err.message);
    return new AddonError('STORE_UNAVAILABLE', err.message);
  }
  return new AddonError('STORE_UNAVAILABLE', err instanceof Error ? err.message : '附加服务内部错误');
}

/** 登录失败的**唯一**响应（账号不存在 / 口令错误**逐字相同**）。 */
const INVALID_CREDENTIALS_MESSAGE = '账号或密码不正确';

export function createAuthRouter(options: AuthRouterOptions): Router {
  const router = Router();
  const now = options.now ?? (() => Date.now());
  const kdf = options.kdf ?? createScryptKdf();
  const tokenFactory = options.tokenFactory ?? generateSessionToken;
  const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

  /** 把 async handler 的异常交给路由器自己的错误中间件（不依赖框架版本行为）。 */
  function handle(handler: (req: Request, res: Response) => Promise<void>) {
    return (req: Request, res: Response, next: NextFunction): void => {
      handler(req, res).catch(next);
    };
  }

  /** 严格解析请求体（`.strict()`）：形状不对 ⇒ `VALIDATION_FAILED`(400)，字段名进消息、**值不进**。 */
  function parseStrict<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const path = first ? first.path.join('.') : '';
      throw new AddonError('VALIDATION_FAILED', path ? `字段 ${path} 不合法：${first.message}` : '请求体不合法');
    }
    return parsed.data as z.infer<T>;
  }

  // —— 注册（**不签发 token**；注册与登录是两个可分别取证的步骤）——
  router.post(
    '/v1/auth/register',
    handle(async (req, res) => {
      // 第一道闸门：快照不可用 ⇒ 503。**绝不**让损坏退化成"账号不存在/口令错误"。
      options.store.assertUsable();
      const parsed = parseStrict(registerRequestSchema, req.body);
      const name = normalizeUsername(parsed.username);
      if (!name.ok) throw new AddonError('AUTH_USERNAME_INVALID', name.message);
      const password = checkPassword(parsed.password, name.username);
      if (!password.ok) throw new AddonError(password.code, password.message);

      // 快路径：已存在 ⇒ 立刻 409（省一次 scrypt）。409 本身就暴露"被占用"，故无新增泄露。
      if (options.store.findUser(name.key) !== null) {
        throw new AddonError('AUTH_USERNAME_TAKEN', `账号名 ${name.username} 已被使用`);
      }
      // 慢活（scrypt）**落在临界区之外**：不占坑、不阻塞其它请求。
      const record = await kdf.hash(parsed.password);
      // 临界区：纯同步；内部**再查一次**唯一性 ⇒ 并发注册恰好一个成功。
      const user = options.store.insertUser({ username: name.username, key: name.key, record });
      const ack: RegisterAck = {
        schemaVersion: AUTH_REGISTER_ACK_SCHEMA_VERSION,
        created: true,
        username: user.username,
        createdAt: user.createdAt,
        serverSeq: user.serverSeq,
        sessionIssued: false,
        notice: AUTH_HONEST_NOTICE,
      };
      res.status(201).json(ack);
    }),
  );

  // —— 登录（发会话 token）——
  router.post(
    '/v1/auth/login',
    handle(async (req, res) => {
      // 第一道闸门：快照不可用 ⇒ 503（**不是**"账号或密码不正确"）。
      options.store.assertUsable();
      const parsed = parseStrict(loginRequestSchema, req.body);
      const name = normalizeUsername(parsed.username);
      if (!name.ok) throw new AddonError('AUTH_USERNAME_INVALID', name.message);

      const user = options.store.findUser(name.key);
      if (user === null) {
        // ★ 反枚举：账号不存在时**照跑**一次同代价的 scrypt（结果恒 false），
        //   让"账号不存在"与"口令错误"在响应体与耗时上都不可区分。
        await kdf.verify(parsed.password, AUTH_DUMMY_PASSWORD_RECORD);
        throw new AddonError('AUTH_INVALID_CREDENTIALS', INVALID_CREDENTIALS_MESSAGE);
      }
      const ok = await kdf.verify(parsed.password, {
        kdf: 'scrypt',
        N: user.N,
        r: user.r,
        p: user.p,
        keylen: user.keylen,
        salt: user.salt,
        hash: user.hash,
      });
      if (!ok) throw new AddonError('AUTH_INVALID_CREDENTIALS', INVALID_CREDENTIALS_MESSAGE);

      const issuedAt = now();
      const expiresAt = issuedAt + AUTH_SESSION_TTL_MS;
      const token = tokenFactory();
      options.store.insertSession({ tokenHash: sha256(token), key: user.key, issuedAt, expiresAt });
      const ack: SessionAck = {
        schemaVersion: AUTH_SESSION_SCHEMA_VERSION,
        authenticated: true,
        token,
        username: user.username,
        issuedAt,
        expiresAt,
        ttlMs: AUTH_SESSION_TTL_MS,
        notice: AUTH_HONEST_NOTICE,
      };
      res.json(ack);
    }),
  );

  // —— 会话校验（不回显 token）——
  router.get(
    '/v1/auth/session',
    handle(async (req, res) => {
      options.store.assertUsable();
      const bearer = bearerTokenFrom(req.headers as Record<string, unknown>);
      if (!bearer.ok) throw new AddonError(bearer.code, bearer.message);
      const session = options.store.findSession(sha256(bearer.token));
      if (session === null) throw new AddonError('AUTH_TOKEN_INVALID', '会话不存在或已失效');
      // 顺序：**先判撤销再看过期** —— 用户点过登出就应看到"已登出"，而不是"已过期"。
      if (session.revokedAt !== null) throw new AddonError('AUTH_TOKEN_REVOKED', '该会话已登出');
      const at = now();
      if (session.expiresAt <= at) throw new AddonError('AUTH_TOKEN_EXPIRED', '该会话已过期，请重新登录');
      const user = options.store.findUser(session.key);
      if (user === null) throw new AddonError('AUTH_TOKEN_INVALID', '会话对应的账号已不存在');
      const view: SessionView = {
        schemaVersion: AUTH_SESSION_SCHEMA_VERSION,
        authenticated: true,
        username: user.username,
        issuedAt: session.issuedAt,
        expiresAt: session.expiresAt,
        remainingMs: Math.max(0, session.expiresAt - at),
        notice: AUTH_HONEST_NOTICE,
      };
      res.json(view);
    }),
  );

  // —— 登出（幂等：同一个 token 再来一次是 200 + alreadyRevoked，不是错误）——
  router.post(
    '/v1/auth/logout',
    handle(async (req, res) => {
      options.store.assertUsable();
      const bearer = bearerTokenFrom(req.headers as Record<string, unknown>);
      if (!bearer.ok) throw new AddonError(bearer.code, bearer.message);
      const tokenHash = sha256(bearer.token);
      if (options.store.findSession(tokenHash) === null) {
        throw new AddonError('AUTH_TOKEN_INVALID', '会话不存在或已失效');
      }
      const result = options.store.revokeSession(tokenHash, now());
      const ack: LogoutAck = {
        schemaVersion: AUTH_LOGOUT_SCHEMA_VERSION,
        revoked: result === 'revoked',
        alreadyRevoked: result === 'already',
      };
      res.json(ack);
    }),
  );

  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const addon = translate(err);
    res.status(addon.status).json(errorBody(addon));
  });

  return router;
}
