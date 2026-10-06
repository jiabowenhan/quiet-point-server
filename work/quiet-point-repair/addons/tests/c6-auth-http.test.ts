/**
 * C-6 注册 / 登录 · **真实 HTTP 端到端**（真实 express + 真实 fetch + 真实 scrypt + 真实独立有界 JSON）。
 *
 * ★ 本文件把主人点名的**七条必做反例**逐条钉死（一条不少）：
 *   ① 重放 token ② 篡改 token ③ 弱口令 ④ 重复账号名 ⑤ 并发注册幂等
 *   ⑥ 错误密码不泄露账号是否存在 ⑦ 过期 token 被拒 ⑧ 登出后 token 失效
 * 外加：落盘反证（无明文口令 / 无明文 token）、运行时日志反证（token 不进 stdout/stderr）、
 * 边界（**不要求 `X-Study-Key`** ⇒ 与既有鉴权是两条独立轴；损坏 ⇒ 503 而不是 401；容量 ⇒ 507）。
 *
 * 纪律：测试里用的都是**一次性假凭据**，且**任何断言都不打印口令或 token**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

import { createAddonApp } from '../main.js';
import { createAuthRouter } from '../auth/routes.js';
import { AuthStore } from '../auth/store.js';
import { createScryptKdf, type PasswordRecord } from '../auth/passwords.js';
import { AUTH_SESSION_TTL_MS } from '../auth/contract.js';

/** 2026-10-05 12:00 +08（固定基准时钟）。 */
const T0 = Date.UTC(2026, 9, 5, 4, 0, 0);

/** 一次性测试口令（**不是**任何真实凭据）。 */
const PWD_A = 'quiet-point-2026';
const PWD_B = 'still-water-7788';

type Reply = { status: number; json: any };

interface Booted {
  base: string;
  close: () => Promise<void>;
  authFile: string;
  store: AuthStore;
}

let clock = T0;
const now = (): number => clock;

async function listen(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** 走**真实装配**（`createAddonApp`）⇒ 同时验证"路由确实挂在 3002 那个 app 上"。 */
async function bootAddons(): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), 'c6-auth-http-'));
  const authFile = join(dir, 'auth-v1.json');
  const { app, authStore } = createAddonApp({
    dbPath: join(dir, 'quiet.sqlite'),
    roomIndexFile: join(dir, 'room-index-v1.json'),
    checkinFile: join(dir, 'checkin-v1.json'),
    presenceFile: join(dir, 'presence-v1.json'),
    authFile,
    now,
  });
  const server = await listen(app);
  return { ...server, authFile, store: authStore };
}

/** 只挂 auth 路由（用于注入假 KDF / 特定容量 / token 工厂）。 */
async function bootAuthOnly(options: { kdf?: ReturnType<typeof createScryptKdf>; store?: AuthStore; maxUsers?: number } = {}): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), 'c6-auth-only-'));
  const authFile = join(dir, 'auth-v1.json');
  const store = options.store ?? new AuthStore({ filePath: authFile, now, maxUsers: options.maxUsers });
  const app = express();
  app.use(express.json({ limit: '8kb' }));
  app.use(createAuthRouter({ store, now, kdf: options.kdf }));
  const server = await listen(app);
  return { ...server, authFile, store };
}

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function get(base: string, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const registerBody = (username: string, password: string): unknown => ({ schemaVersion: 'auth-register-v1', username, password });
const loginBody = (username: string, password: string): unknown => ({ schemaVersion: 'auth-login-v1', username, password });

const register = (base: string, username: string, password: string) => post(base, '/v1/auth/register', registerBody(username, password));
const login = (base: string, username: string, password: string) => post(base, '/v1/auth/login', loginBody(username, password));
const session = (base: string, token: string) => get(base, '/v1/auth/session', bearer(token));
const logout = (base: string, token: string) => post(base, '/v1/auth/logout', {}, bearer(token));

/** 注册 + 登录，返回 token（多数用例的公共前奏）。 */
async function signUp(base: string, username: string, password: string): Promise<string> {
  const created = await register(base, username, password);
  assert.equal(created.status, 201, `注册应当成功：${JSON.stringify(created.json)}`);
  const signed = await login(base, username, password);
  assert.equal(signed.status, 200, `登录应当成功：${JSON.stringify(signed.json)}`);
  return signed.json.token as string;
}

// ---------------------------------------------------------------------------
// 正向：注册 → 登录 → 会话校验 → 登出
// ---------------------------------------------------------------------------

test('C6H-1 正向全链：注册 201 → 登录 200 → 会话 200 → 登出 200 → 会话 401（已登出）', async () => {
  clock = T0;
  const booted = await bootAddons();
  try {
    const created = await register(booted.base, 'alice', PWD_A);
    assert.equal(created.status, 201);
    assert.equal(created.json.created, true);
    assert.equal(created.json.username, 'alice');
    assert.equal(created.json.sessionIssued, false, '注册不签发 token（注册与登录是两个步骤）');
    assert.match(String(created.json.notice), /演示级/);
    assert.equal(String(created.json.notice).includes('企业级'), false);

    const signed = await login(booted.base, 'alice', PWD_A);
    assert.equal(signed.status, 200);
    assert.equal(signed.json.authenticated, true);
    assert.equal(signed.json.username, 'alice');
    assert.equal(signed.json.ttlMs, AUTH_SESSION_TTL_MS);
    assert.equal((signed.json.token as string).length, 43);
    assert.equal(signed.json.expiresAt - signed.json.issuedAt, AUTH_SESSION_TTL_MS);

    const view = await session(booted.base, signed.json.token);
    assert.equal(view.status, 200);
    assert.equal(view.json.authenticated, true);
    assert.equal(view.json.username, 'alice');
    assert.ok(view.json.remainingMs > 0);
    assert.equal('token' in view.json, false, '会话校验不回显 token');

    const out = await logout(booted.base, signed.json.token);
    assert.equal(out.status, 200);
    assert.deepEqual(out.json, { schemaVersion: 'auth-logout-v1', revoked: true, alreadyRevoked: false });

    const after = await session(booted.base, signed.json.token);
    assert.equal(after.status, 401);
    assert.equal(after.json.error.code, 'AUTH_TOKEN_REVOKED');
  } finally {
    await booted.close();
  }
});

test('C6H-2 注册后**没有**任何会话（会话只在登录时建立）', async () => {
  clock = T0;
  const booted = await bootAddons();
  try {
    await register(booted.base, 'alice', PWD_A);
    assert.equal(booted.store.status().sessionCount, 0);
    assert.equal(booted.store.status().userCount, 1);
  } finally {
    await booted.close();
  }
});

// ---------------------------------------------------------------------------
// ★反例①：重放 token
// ---------------------------------------------------------------------------

test('C6H-3 ★反例·重放（撤销后）：登出过的 token 一律 AUTH_TOKEN_REVOKED，且**不能再被"登回"**', async () => {
  clock = T0;
  const booted = await bootAddons();
  try {
    const token = await signUp(booted.base, 'alice', PWD_A);
    assert.equal((await session(booted.base, token)).status, 200);
    await logout(booted.base, token);
    for (let i = 0; i < 3; i += 1) {
      const replay = await session(booted.base, token);
      assert.equal(replay.status, 401);
      assert.equal(replay.json.error.code, 'AUTH_TOKEN_REVOKED');
    }
    // 撤销是**服务端状态**：换个客户端、换个路径重新发同样的请求也没用。
    const again = await logout(booted.base, token);
    assert.equal(again.status, 200);
    assert.equal(again.json.alreadyRevoked, true);
    assert.equal((await session(booted.base, token)).json.error.code, 'AUTH_TOKEN_REVOKED');
  } finally {
    await booted.close();
  }
});

test('C6H-4 ★反例·重放（过期后）：跨过 TTL ⇒ AUTH_TOKEN_EXPIRED；边界 now===expiresAt 也算过期', async () => {
  clock = T0;
  const booted = await bootAddons();
  try {
    const token = await signUp(booted.base, 'alice', PWD_A);
    clock = T0 + AUTH_SESSION_TTL_MS - 1;
    assert.equal((await session(booted.base, token)).status, 200, 'TTL 内仍有效');
    clock = T0 + AUTH_SESSION_TTL_MS;
    const boundary = await session(booted.base, token);
    assert.equal(boundary.status, 401);
    assert.equal(boundary.json.error.code, 'AUTH_TOKEN_EXPIRED');
    clock = T0 + AUTH_SESSION_TTL_MS * 10;
    const late = await session(booted.base, token);
    assert.equal(late.status, 401);
    assert.equal(late.json.error.code, 'AUTH_TOKEN_EXPIRED');
  } finally {
    await booted.close();
    clock = T0;
  }
});

test('C6H-5 ★反例·重放（请求体）：同一登录请求体提交两次 ⇒ 两个**不同** token，且各自独立有效', async () => {
  clock = T0;
  const booted = await bootAddons();
  try {
    await register(booted.base, 'alice', PWD_A);
    const first = await login(booted.base, 'alice', PWD_A);
    const second = await login(booted.base, 'alice', PWD_A);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.notEqual(first.json.token, second.json.token, 'token 不能由请求体/时间推导出来');
    assert.equal((await session(booted.base, first.json.token)).status, 200);
    assert.equal((await session(booted.base, second.json.token)).status, 200);
    // 登出其中一个**不影响**另一个（会话彼此独立）。
    await logout(booted.base, first.json.token);
    assert.equal((await session(booted.base, first.json.token)).json.error.code, 'AUTH_TOKEN_REVOKED');
    assert.equal((await session(booted.base, second.json.token)).status, 200);
  } finally {
    await booted.close();
  }
});

// ---------------------------------------------------------------------------
// ★反例②：篡改 token
// ---------------------------------------------------------------------------

test('C6H-6 ★反例·篡改：改字符 / 截断 / 非 base64url / 换 scheme / 拿 X-Study-Key 冒充 ⇒ 全 401', async () => {
  clock = T0;
  const booted = await bootAddons();
  try {
    const token = await signUp(booted.base, 'alice', PWD_A);
    const flip = (s: string): string => `${s[0] === 'A' ? 'B' : 'A'}${s.slice(1)}`;

    const cases: Array<[string, string, string]> = [
      ['改一个字符', `Bearer ${flip(token)}`, 'AUTH_TOKEN_INVALID'],
      ['截断', `Bearer ${token.slice(0, 20)}`, 'AUTH_TOKEN_INVALID'],
      ['多一位', `Bearer ${token}x`, 'AUTH_TOKEN_INVALID'],
      ['换字符集', `Bearer ${'!'.repeat(43)}`, 'AUTH_TOKEN_INVALID'],
      ['空 token', 'Bearer ', 'AUTH_TOKEN_INVALID'],
      ['缺头', '', 'AUTH_TOKEN_MISSING'],
      ['非 Bearer 方案', `Token ${token}`, 'AUTH_TOKEN_INVALID'],
      // 既有匿名鉴权凭据的形状（24 字符）冒充 Bearer：形状就不对。
      ['X-Study-Key 冒充', `Bearer ${'A'.repeat(24)}`, 'AUTH_TOKEN_INVALID'],
    ];
    for (const [label, value, code] of cases) {
      const res = await get(booted.base, '/v1/auth/session', value === '' ? {} : { Authorization: value });
      assert.equal(res.status, 401, `${label} 应当 401`);
      assert.equal(res.json.error.code, code, `${label} 的错误码`);
    }
    // 篡改后的 token 仍能登出？不行 —— 它本来就查不到，**不能**返回"登出成功"。
    const bogus = await logout(booted.base, flip(token));
    assert.equal(bogus.status, 401);
    assert.equal(bogus.json.error.code, 'AUTH_TOKEN_INVALID');
    // 原 token 完全没被影响。
    assert.equal((await session(booted.base, token)).status, 200);
  } finally {
    await booted.close();
  }
});

// ---------------------------------------------------------------------------
// ★反例③：弱口令
// ---------------------------------------------------------------------------

test('C6H-7 ★反例·弱口令：逐条拒绝并给出可区分的码；强口令不被误拒', async () => {
  clock = T0;
  const booted = await bootAddons();
  try {
    const weak: Array<[string, string]> = [
      ['abc123', 'AUTH_PASSWORD_TOO_SHORT'],
      ['password', 'AUTH_PASSWORD_WEAK'],
      ['aaaaaaaa', 'AUTH_PASSWORD_WEAK'],
      ['24680135', 'AUTH_PASSWORD_WEAK'],
      ['abcdefgh', 'AUTH_PASSWORD_WEAK'],
      ['alice-quiet-point', 'AUTH_PASSWORD_WEAK'],
      ['bad\npassword1', 'AUTH_PASSWORD_WEAK'],
      ['Zx9'.repeat(50), 'AUTH_PASSWORD_TOO_LONG'],
    ];
    for (const [password, code] of weak) {
      const res = await register(booted.base, 'alice', password);
      assert.equal(res.status, 400, `应当拒绝：${code}`);
      assert.equal(res.json.error.code, code);
      assert.equal(res.json.error.message.includes(password), false, '错误消息不得回显口令');
    }
    assert.equal(booted.store.status().userCount, 0, '弱口令一个都不许建号');

    const good = await register(booted.base, 'alice', PWD_A);
    assert.equal(good.status, 201);
  } finally {
    await booted.close();
  }
});

// ---------------------------------------------------------------------------
// ★反例④：重复账号名
// ---------------------------------------------------------------------------

test('C6H-8 ★反例·重复账号名：二次 409；大小写变体 409；**绝不覆盖原口令**；库里恰好 1 条', async () => {
  clock = T0;
  const booted = await bootAddons();
  try {
    assert.equal((await register(booted.base, 'Alice', PWD_A)).status, 201);
    const record = booted.store.userRecord('alice');
    assert.notEqual(record, null);
    const hashBefore = record?.hash;
    const saltBefore = record?.salt;

    const duplicate = await register(booted.base, 'Alice', PWD_B);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.json.error.code, 'AUTH_USERNAME_TAKEN');

    const caseVariant = await register(booted.base, 'ALICE', PWD_B);
    assert.equal(caseVariant.status, 409, '大小写变体视为同一账号');
    assert.equal(caseVariant.json.error.code, 'AUTH_USERNAME_TAKEN');

    // ★ 关键安全断言：重注册**绝不**修改既有账号的口令材料。
    assert.equal(booted.store.userRecord('alice')?.hash, hashBefore);
    assert.equal(booted.store.userRecord('alice')?.salt, saltBefore);
    assert.equal(booted.store.status().userCount, 1);
    assert.equal(booted.store.usernames().filter((n) => n.toLowerCase() === 'alice').length, 1);

    // 原口令照常能登录；攻击者用来"重注册"的那个口令**不能**登录。
    assert.equal((await login(booted.base, 'Alice', PWD_A)).status, 200);
    const hijack = await login(booted.base, 'Alice', PWD_B);
    assert.equal(hijack.status, 401);
    assert.equal(hijack.json.error.code, 'AUTH_INVALID_CREDENTIALS');
  } finally {
    await booted.close();
  }
});

// ---------------------------------------------------------------------------
// ★反例⑤：并发注册幂等
// ---------------------------------------------------------------------------

test('C6H-9 ★反例·并发注册幂等：N 个同名同口令并发 ⇒ 恰好 1 个 201、其余 409，库里恰好 1 条', async () => {
  clock = T0;
  const booted = await bootAddons();
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => register(booted.base, 'racer', PWD_A)));
    const created = results.filter((r) => r.status === 201);
    const conflicted = results.filter((r) => r.status === 409);
    assert.equal(created.length, 1, `恰好一个成功，实际 ${created.length}`);
    assert.equal(conflicted.length, 7, `其余全部冲突，实际 ${conflicted.length}`);
    for (const c of conflicted) assert.equal(c.json.error.code, 'AUTH_USERNAME_TAKEN');
    assert.equal(booted.store.status().userCount, 1);
    assert.equal((await login(booted.base, 'racer', PWD_A)).status, 200);
  } finally {
    await booted.close();
  }
});

test('C6H-10 ★反例·并发注册（同名**不同**口令）⇒ 胜者唯一，且只有胜者的口令能登录', async () => {
  clock = T0;
  const booted = await bootAddons();
  try {
    const passwords = Array.from({ length: 6 }, (_, i) => `quiet-point-candidate-${i}-2026`);
    const results = await Promise.all(passwords.map((password) => register(booted.base, 'race2', password)));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal(results.filter((r) => r.status === 409).length, 5);
    assert.equal(booted.store.status().userCount, 1);

    let winners = 0;
    for (const password of passwords) {
      if ((await login(booted.base, 'race2', password)).status === 200) winners += 1;
    }
    assert.equal(winners, 1, '恰好一个口令（先到者）生效 —— 没有 last-writer-wins 劫持');
  } finally {
    await booted.close();
  }
});

// ---------------------------------------------------------------------------
// ★反例⑥：错误密码不泄露账号是否存在
// ---------------------------------------------------------------------------

test('C6H-11 ★反例·反枚举：账号不存在 vs 口令错误 ⇒ 状态码与响应体**逐字相同**，且都真跑了 scrypt', async () => {
  clock = T0;
  const real = createScryptKdf();
  let verifyCalls = 0;
  const countingKdf = {
    hash: (password: string): Promise<PasswordRecord> => real.hash(password),
    verify: (password: string, record: PasswordRecord): Promise<boolean> => {
      verifyCalls += 1;
      return real.verify(password, record);
    },
  };
  const booted = await bootAuthOnly({ kdf: countingKdf });
  try {
    await register(booted.base, 'alice', PWD_A);

    verifyCalls = 0;
    const startedWrong = Date.now();
    const wrongPassword = await login(booted.base, 'alice', PWD_B);
    const wrongMs = Date.now() - startedWrong;
    assert.equal(verifyCalls, 1, '口令错误路径必须真的做一次校验');

    verifyCalls = 0;
    const startedGhost = Date.now();
    const ghost = await login(booted.base, 'nobody-here', PWD_B);
    const ghostMs = Date.now() - startedGhost;
    assert.equal(verifyCalls, 1, '账号不存在路径也必须真的做一次同代价校验（假记录）');

    assert.equal(wrongPassword.status, ghost.status);
    assert.equal(wrongPassword.status, 401);
    assert.deepEqual(wrongPassword.json, ghost.json, '两条失败路径的响应体必须逐字相同');
    assert.equal(wrongPassword.json.error.code, 'AUTH_INVALID_CREDENTIALS');
    assert.equal(String(wrongPassword.json.error.message).includes('alice'), false, '不得回显账号名');
    // 不掐比例（会 flaky）：只要求两条路都**确实**跑了一次真运算（默认参数下单次 ≥ 5 ms）。
    assert.ok(wrongMs >= 5 && ghostMs >= 5, `两条路径都要真跑 scrypt（wrong=${wrongMs}ms ghost=${ghostMs}ms）`);
  } finally {
    await booted.close();
  }
});

// ---------------------------------------------------------------------------
// ★反例⑦⑧：过期 / 登出（已在上文覆盖），这里补登出幂等与边界
// ---------------------------------------------------------------------------

test('C6H-12 登出幂等：二次登出 200 + alreadyRevoked；形状合法但查无此会话 ⇒ 401', async () => {
  clock = T0;
  const booted = await bootAddons();
  try {
    const token = await signUp(booted.base, 'alice', PWD_A);
    assert.deepEqual((await logout(booted.base, token)).json, { schemaVersion: 'auth-logout-v1', revoked: true, alreadyRevoked: false });
    assert.deepEqual((await logout(booted.base, token)).json, { schemaVersion: 'auth-logout-v1', revoked: false, alreadyRevoked: true });

    const unknownToken = 'z'.repeat(43);
    const unknown = await logout(booted.base, unknownToken);
    assert.equal(unknown.status, 401);
    assert.equal(unknown.json.error.code, 'AUTH_TOKEN_INVALID');

    const noHeader = await post(booted.base, '/v1/auth/logout', {});
    assert.equal(noHeader.status, 401);
    assert.equal(noHeader.json.error.code, 'AUTH_TOKEN_MISSING');
  } finally {
    await booted.close();
  }
});

test('C6H-13 边界：**不需要** X-Study-Key（与既有匿名鉴权是两条独立轴）；多余字段/错版本 ⇒ 400', async () => {
  clock = T0;
  const booted = await bootAddons();
  try {
    // 全程不带 X-Study-Key。
    const token = await signUp(booted.base, 'alice', PWD_A);
    assert.equal((await session(booted.base, token)).status, 200);
    assert.equal((await logout(booted.base, token)).status, 200);

    const extra = await post(booted.base, '/v1/auth/register', { schemaVersion: 'auth-register-v1', username: 'bob', password: PWD_A, deviceId: 'x' });
    assert.equal(extra.status, 400);
    assert.equal(extra.json.error.code, 'VALIDATION_FAILED');

    const wrongVersion = await post(booted.base, '/v1/auth/login', { schemaVersion: 'auth-login-v2', username: 'alice', password: PWD_A });
    assert.equal(wrongVersion.status, 400);
    assert.equal(wrongVersion.json.error.code, 'VALIDATION_FAILED');

    const empty = await post(booted.base, '/v1/auth/register', {});
    assert.equal(empty.status, 400);
    assert.equal(empty.json.error.code, 'VALIDATION_FAILED');

    // 坏 JSON：不要求具体码，只要求"干净地报错、不挂"。
    const badJson = await fetch(`${booted.base}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    assert.ok(badJson.status >= 400, '坏 JSON 必须是 4xx/5xx，不能装死');
    const parsed = await badJson.json().catch(() => null);
    assert.equal(typeof (parsed as { error?: unknown } | null)?.error, 'object');
  } finally {
    await booted.close();
  }
});

test('C6H-14 边界：存储损坏 ⇒ 503（**不是** 401 / 不是"口令错误"）', async () => {
  clock = T0;
  const booted = await bootAddons();
  try {
    // 在任何 auth 调用之前把快照写坏（store 懒加载 ⇒ 第一次调用才发现）。
    writeFileSync(booted.authFile, '{ corrupted', 'utf8');
    const res = await login(booted.base, 'alice', PWD_A);
    assert.equal(res.status, 503);
    assert.equal(res.json.error.code, 'STORE_UNAVAILABLE');
    assert.equal(res.json.error.retryable, true);
    const reg = await register(booted.base, 'alice', PWD_A);
    assert.equal(reg.status, 503);
    assert.equal(reg.json.error.code, 'STORE_UNAVAILABLE');
  } finally {
    await booted.close();
  }
});

test('C6H-15 边界：账号数上限 ⇒ 507 STORE_CAPACITY（不静默淘汰已有账号）', async () => {
  clock = T0;
  const booted = await bootAuthOnly({ maxUsers: 1 });
  try {
    assert.equal((await register(booted.base, 'alice', PWD_A)).status, 201);
    const full = await register(booted.base, 'bob', PWD_A);
    assert.equal(full.status, 507);
    assert.equal(full.json.error.code, 'STORE_CAPACITY');
    assert.equal(booted.store.status().userCount, 1);
    assert.equal((await login(booted.base, 'alice', PWD_A)).status, 200, '已有账号不受影响');
  } finally {
    await booted.close();
  }
});

test('C6H-16 双账号隔离：各自 token 只解析到自己；登出 A 不影响 B', async () => {
  clock = T0;
  const booted = await bootAddons();
  try {
    const tokenA = await signUp(booted.base, 'alice', PWD_A);
    const tokenB = await signUp(booted.base, 'bob', PWD_B);
    assert.equal((await session(booted.base, tokenA)).json.username, 'alice');
    assert.equal((await session(booted.base, tokenB)).json.username, 'bob');
    await logout(booted.base, tokenA);
    assert.equal((await session(booted.base, tokenA)).json.error.code, 'AUTH_TOKEN_REVOKED');
    assert.equal((await session(booted.base, tokenB)).status, 200);
  } finally {
    await booted.close();
  }
});

test('C6H-17 同账号第 9 次登录会淘汰最旧会话（每账号 8 条上限在 HTTP 层也生效）', async () => {
  clock = T0;
  const booted = await bootAddons();
  try {
    await register(booted.base, 'alice', PWD_A);
    const tokens: string[] = [];
    for (let i = 0; i < 9; i += 1) {
      clock = T0 + i * 1000;
      const res = await login(booted.base, 'alice', PWD_A);
      assert.equal(res.status, 200);
      tokens.push(res.json.token as string);
    }
    assert.equal(booted.store.status().sessionCount, 8);
    assert.equal((await session(booted.base, tokens[0] as string)).status, 401, '最旧的会话被淘汰');
    assert.equal((await session(booted.base, tokens[8] as string)).status, 200, '最新的会话可用');
  } finally {
    await booted.close();
    clock = T0;
  }
});

// ---------------------------------------------------------------------------
// 落盘反证 / 日志反证
// ---------------------------------------------------------------------------

test('C6H-18 落盘反证：快照里**没有明文口令、没有明文 token**，只有 salt/hash 与 sha256(token)', async () => {
  clock = T0;
  const booted = await bootAddons();
  try {
    const token = await signUp(booted.base, 'alice', PWD_A);
    const raw = readFileSync(booted.authFile, 'utf8');
    const parsed = JSON.parse(raw) as {
      schemaVersion: number;
      users: Record<string, { salt: string; hash: string; kdf: string; N: number }>;
      sessions: Record<string, unknown>;
    };
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(raw.includes(PWD_A), false, '明文口令绝不落盘');
    assert.equal(raw.includes(token), false, '明文 token 绝不落盘');
    assert.equal(raw.includes('quiet-point'), false, '口令的任何片段都不该出现');

    const tokenHash = createHash('sha256').update(token).digest('hex');
    assert.notEqual(parsed.sessions[tokenHash], undefined, '会话主键必须是 sha256(token)');
    assert.deepEqual(Object.keys(parsed.sessions), [tokenHash]);

    const user = parsed.users['alice'];
    assert.notEqual(user, undefined);
    assert.equal(user?.kdf, 'scrypt');
    assert.equal(user?.salt.length, 32);
    assert.equal(user?.hash.length, 128);
    assert.ok((user?.N ?? 0) >= 16384, 'scrypt 成本参数必须落盘（便于日后调参验证）');
  } finally {
    await booted.close();
  }
});

test('C6H-19 日志反证（运行时）：完整一轮注册/登录/会话/登出，stdout+stderr 里**不出现 token**', async () => {
  clock = T0;
  const booted = await bootAddons();
  const chunks: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  const patched = (original: (...args: unknown[]) => boolean) =>
    ((chunk: unknown, ...rest: unknown[]): boolean => {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return original(chunk, ...rest);
    }) as unknown as typeof process.stdout.write;
  try {
    process.stdout.write = patched(originalOut as unknown as (...args: unknown[]) => boolean);
    process.stderr.write = patched(originalErr as unknown as (...args: unknown[]) => boolean);
    const token = await signUp(booted.base, 'alice', PWD_A);
    await session(booted.base, token);
    await logout(booted.base, token);
    process.stdout.write = originalOut as unknown as typeof process.stdout.write;
    process.stderr.write = originalErr as unknown as typeof process.stderr.write;

    const text = chunks.join('');
    assert.equal(text.includes(token), false, 'token 绝不能进 stdout/stderr');
    assert.equal(text.includes(PWD_A), false, '口令绝不能进 stdout/stderr');
    assert.equal(text.includes(createHash('sha256').update(token).digest('hex')), false, 'token 的哈希也无需出现');
  } finally {
    process.stdout.write = originalOut as unknown as typeof process.stdout.write;
    process.stderr.write = originalErr as unknown as typeof process.stderr.write;
    await booted.close();
  }
});
