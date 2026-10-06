/**
 * C-6 注册/登录 · **纯规则 + 存储单元**（无 HTTP、无网络）。
 *
 * 覆盖：账号名规则（含全角/CJK/大小写折叠）、口令规则（逐条弱口令）、Bearer 解析、
 * scrypt 口令材料（随机盐 / 参数随记录 / 定时安全比较 / 反枚举假记录），以及
 * 独立有界存储的容量、损坏纪律、会话上限与撤销幂等。
 *
 * 这里的所有断言都**不打印**任何口令或 token（测试里也用一次性假凭据）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AUTH_HONEST_NOTICE,
  AUTH_MAX_SESSIONS_PER_USER,
  AUTH_TOKEN_PATTERN,
  bearerTokenFrom,
  checkPassword,
  normalizeUsername,
  usernameKeyOrNull,
} from '../auth/contract.js';
import {
  AUTH_DUMMY_PASSWORD_RECORD,
  SCRYPT_PARAMS,
  createScryptKdf,
  generateSessionToken,
} from '../auth/passwords.js';
import { AuthStore } from '../auth/store.js';

const T0 = Date.UTC(2026, 9, 5, 4, 0, 0);

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'c6-auth-')), name);
}

// ---------------------------------------------------------------------------
// 账号名
// ---------------------------------------------------------------------------

test('C6-U1 账号名：合法形态（ASCII / 中文 / 下划线 / 连字符）', () => {
  const cases = ['alice', 'Bob_2026', 'a-b-c', '小明同学', '安静的猫_7'];
  for (const raw of cases) {
    const result = normalizeUsername(raw);
    assert.equal(result.ok, true, `应当接受：${raw}`);
    if (result.ok) {
      assert.equal(result.username, raw);
      assert.equal(result.key, raw.toLowerCase());
    }
  }
});

test('C6-U2 账号名：长度 / 首字符 / 非法字符 / 非字符串 一律 AUTH_USERNAME_INVALID', () => {
  const bad = ['ab', '', 'a'.repeat(25), '_abc', '-abc', 'a b', 'a\tb', 'a@b', 'a.b', 123, null, undefined, {}];
  for (const raw of bad) {
    const result = normalizeUsername(raw);
    assert.equal(result.ok, false, `应当拒绝：${String(raw)}`);
    if (!result.ok) assert.equal(result.code, 'AUTH_USERNAME_INVALID');
  }
});

test('C6-U3 账号名：全角/兼容字符被拒（不做静默折叠 ⇒ 不产生"看起来一样"的两个账号）', () => {
  const result = normalizeUsername('ＡＬＩＣＥ');
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /全角|兼容/);
});

test('C6-U4 账号名：唯一性键做小写折叠 ⇒ alice / ALICE / Alice 是同一个账号', () => {
  const keys = (['alice', 'ALICE', 'Alice'] as const).map((u) => usernameKeyOrNull(u));
  assert.deepEqual(keys, ['alice', 'alice', 'alice']);
  assert.equal(usernameKeyOrNull('ab'), null);
});

// ---------------------------------------------------------------------------
// 口令
// ---------------------------------------------------------------------------

test('C6-U5 口令：太短 ⇒ AUTH_PASSWORD_TOO_SHORT；太长 ⇒ AUTH_PASSWORD_TOO_LONG', () => {
  const short = checkPassword('a1b2c3');
  assert.equal(short.ok, false);
  if (!short.ok) assert.equal(short.code, 'AUTH_PASSWORD_TOO_SHORT');
  const long = checkPassword('Zx9'.repeat(50)); // 150 位
  assert.equal(long.ok, false);
  if (!long.ok) assert.equal(long.code, 'AUTH_PASSWORD_TOO_LONG');
});

test('C6-U6 口令：常见弱口令 / 单字符重复 / 纯数字 / 连号 / 含账号名 ⇒ AUTH_PASSWORD_WEAK（逐条）', () => {
  const weak: Array<[string, RegExp]> = [
    ['password', /常见弱口令/],
    ['24680135', /纯数字/],
    ['aaaaaaaa', /同一个字符/],
    ['abcdefgh', /连续/],
    ['alice-is-here', /包含账号名/],
  ];
  for (const [pwd, pattern] of weak) {
    const result = checkPassword(pwd, 'alice');
    assert.equal(result.ok, false, `应当拒绝：${pwd}`);
    if (!result.ok) {
      assert.equal(result.code, 'AUTH_PASSWORD_WEAK');
      assert.match(result.message, pattern);
      // ★ 口令本身绝不能回显在错误消息里。
      assert.equal(result.message.includes(pwd), false, '错误消息里不得出现口令');
    }
  }
});

test('C6-U7 口令：控制字符被拒；正常口令被接受（不能误伤）', () => {
  const control = checkPassword('abc\ndef1234');
  assert.equal(control.ok, false);
  if (!control.ok) assert.equal(control.code, 'AUTH_PASSWORD_WEAK');
  for (const good of ['quiet-point-2026', '面包和安静y7Q', 'A1b2-c3d4-e5f6']) {
    assert.equal(checkPassword(good, 'alice').ok, true, `应当接受：${good}`);
  }
  // 账号名长度 < 3 时不做"包含账号名"判定（避免过度拒绝）。
  assert.equal(checkPassword('quietpoint2026', 'ab').ok, true);
});

// ---------------------------------------------------------------------------
// Bearer
// ---------------------------------------------------------------------------

test('C6-U8 Bearer 解析：缺头 ⇒ MISSING；非 Bearer / 形状非法 ⇒ INVALID；合法 ⇒ ok', () => {
  const missing = bearerTokenFrom({});
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, 'AUTH_TOKEN_MISSING');

  const token = generateSessionToken();
  assert.equal(AUTH_TOKEN_PATTERN.test(token), true);
  assert.equal(token.length, 43);

  const badScheme = bearerTokenFrom({ authorization: `Token ${token}` });
  assert.equal(badScheme.ok, false);
  if (!badScheme.ok) assert.equal(badScheme.code, 'AUTH_TOKEN_INVALID');

  // 拿既有匿名凭据冒充 Bearer（形状也对不上 43 字符 base64url）。
  const studyKey = 'A'.repeat(24);
  const impostor = bearerTokenFrom({ authorization: `Bearer ${studyKey}` });
  assert.equal(impostor.ok, false);
  if (!impostor.ok) assert.equal(impostor.code, 'AUTH_TOKEN_INVALID');

  const ok = bearerTokenFrom({ authorization: `Bearer ${token}` });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.token, token);

  // 大小写不敏感 scheme + 数组型头（Node 会这样给重复头）。
  assert.equal(bearerTokenFrom({ authorization: [`bearer ${token}`] }).ok, true);
});

// ---------------------------------------------------------------------------
// scrypt 口令材料
// ---------------------------------------------------------------------------

test('C6-U9 scrypt：随机盐 ⇒ 同口令两次派生盐与 hash 都不同；verify 真/假都对', async () => {
  const kdf = createScryptKdf();
  const a = await kdf.hash('quiet-point-2026');
  const b = await kdf.hash('quiet-point-2026');
  assert.notEqual(a.salt, b.salt, '每用户盐必须随机');
  assert.notEqual(a.hash, b.hash);
  assert.equal(a.salt.length, 32);
  assert.equal(a.hash.length, 128);
  assert.equal(a.kdf, 'scrypt');
  assert.deepEqual({ N: a.N, r: a.r, p: a.p, keylen: a.keylen }, SCRYPT_PARAMS);

  assert.equal(await kdf.verify('quiet-point-2026', a), true);
  assert.equal(await kdf.verify('quiet-point-2027', a), false);
  // 长度不等时**不抛异常**（timingSafeEqual 会抛）⇒ 返回 false。
  assert.equal(await kdf.verify('quiet-point-2026', { ...a, hash: 'ab' }), false);
});

test('C6-U10 scrypt：校验参数取自**记录**（不是当前默认值）⇒ 调参后旧口令仍可验证', async () => {
  const legacy = createScryptKdf({ N: 1024, r: 8, p: 1, keylen: 64 });
  const record = await legacy.hash('quiet-point-2026');
  const current = createScryptKdf();
  assert.equal(await current.verify('quiet-point-2026', record), true, '默认参数变了也要能验旧记录');
});

test('C6-U11 反枚举假记录：verify 恒 false（但它是一次**真实**的 scrypt 运算）', async () => {
  const kdf = createScryptKdf();
  const started = Date.now();
  assert.equal(await kdf.verify('anything-at-all', AUTH_DUMMY_PASSWORD_RECORD), false);
  assert.equal(await kdf.verify('', AUTH_DUMMY_PASSWORD_RECORD), false);
  // 不掐具体毫秒（会 flaky），只要求"确实跑了一次真运算"：默认参数下单次至少 ~5 ms。
  assert.ok(Date.now() - started >= 5, '假记录校验也必须真的跑 scrypt');
});

// ---------------------------------------------------------------------------
// 存储：容量 / 损坏 / 会话上限 / 撤销幂等
// ---------------------------------------------------------------------------

function insertFakeUser(store: AuthStore, username: string, at = T0): void {
  store.insertUser({
    username,
    key: username.toLowerCase(),
    record: {
      kdf: 'scrypt',
      ...SCRYPT_PARAMS,
      salt: 'a'.repeat(32),
      hash: 'b'.repeat(128),
    },
  });
  void at;
}

test('C6-U12 存储：用户数上限 ⇒ STORE_CAPACITY（不静默淘汰已有账号）', () => {
  const store = new AuthStore({ filePath: tempFile('auth-v1.json'), now: () => T0, maxUsers: 2 });
  insertFakeUser(store, 'alice');
  insertFakeUser(store, 'bob');
  assert.throws(() => insertFakeUser(store, 'carol'), (err: unknown) => {
    const e = err as { code?: string };
    assert.equal(e.code, 'STORE_CAPACITY');
    return true;
  });
  assert.equal(store.status().userCount, 2);
});

test('C6-U13 存储：快照损坏 ⇒ STORE_UNAVAILABLE，且**不写回空快照**（内容原样保留）', () => {
  const file = tempFile('auth-v1.json');
  writeFileSync(file, '{ this is not json', 'utf8');
  const before = readFileSync(file, 'utf8');
  const store = new AuthStore({ filePath: file, now: () => T0 });
  assert.throws(() => insertFakeUser(store, 'alice'), (err: unknown) => {
    const e = err as { code?: string };
    assert.equal(e.code, 'STORE_UNAVAILABLE');
    return true;
  });
  assert.equal(store.isCorrupted(), true);
  assert.equal(readFileSync(file, 'utf8'), before, '损坏时绝不能改写文件');
  assert.equal(store.status().userCount, 0);
});

test('C6-U14 存储：同账号会话上限 8 条，超出的淘汰**最旧**；过期记录被裁掉', () => {
  let clock = T0;
  const store = new AuthStore({ filePath: tempFile('auth-v1.json'), now: () => clock });
  insertFakeUser(store, 'alice');
  const hashes: string[] = [];
  for (let i = 0; i < AUTH_MAX_SESSIONS_PER_USER + 2; i += 1) {
    clock = T0 + i * 1000;
    const hash = `h${String(i).padStart(63, '0')}`;
    hashes.push(hash);
    store.insertSession({ tokenHash: hash, key: 'alice', issuedAt: clock, expiresAt: clock + 3_600_000 });
  }
  assert.equal(store.status().sessionCount, AUTH_MAX_SESSIONS_PER_USER, '超过上限必须淘汰');
  assert.equal(store.findSession(hashes[0] as string), null, '被淘汰的应当是最旧的');
  assert.notEqual(store.findSession(hashes[hashes.length - 1] as string), null);

  // 过期记录在下一次写入前被裁掉。
  clock = T0 + 10_000_000;
  store.insertSession({ tokenHash: 'z'.repeat(64), key: 'alice', issuedAt: clock, expiresAt: clock + 3_600_000 });
  assert.equal(store.status().sessionCount, 1, '过期会话必须被裁掉');
});

test('C6-U15 存储：撤销幂等（revoked → already → 未知 ⇒ null），且撤销后记录仍在（可回答"已登出"）', () => {
  const store = new AuthStore({ filePath: tempFile('auth-v1.json'), now: () => T0 });
  insertFakeUser(store, 'alice');
  const hash = 'q'.repeat(64);
  store.insertSession({ tokenHash: hash, key: 'alice', issuedAt: T0, expiresAt: T0 + 3_600_000 });
  assert.equal(store.revokeSession(hash), 'revoked');
  assert.equal(store.revokeSession(hash), 'already');
  assert.equal(store.revokeSession('n'.repeat(64)), null);
  assert.notEqual(store.findSession(hash), null);
  assert.equal(store.findSession(hash)?.revokedAt, T0);
  assert.equal(store.status().activeSessionCount, 0);
});

test('C6-U16 诚实口径常量：含"演示级"，不含"企业级"', () => {
  assert.match(AUTH_HONEST_NOTICE, /演示级/);
  assert.equal(AUTH_HONEST_NOTICE.includes('企业级'), false);
});
