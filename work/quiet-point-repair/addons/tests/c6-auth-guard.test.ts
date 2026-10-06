/**
 * C-6 注册/登录 · **结构守卫**（扫描**编译产物**，不靠"我记得没写过"）。
 *
 * 钉住的四件事：
 *  ① `addons/auth/**` **零 `console.*`** ⇒ 明文口令与 token 在服务端**结构上不可能**被打印；
 *  ② 不反向依赖 `server/**` / `app/**` / 其它 addon 路由，也不碰采集/音频模块；
 *  ③ **不读 `X-Study-Key`** ⇒ 账号体系与既有匿名鉴权是两条互不干扰的轴；
 *  ④ 不引入任何新依赖（说明符只允许 `node:` 内置 / 相对路径 / 仓库已有依赖）；
 * 外加：新错误码的 HTTP 状态映射、诚实口径文案确实进了产物。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AddonError, type AddonErrorCode } from '../shared/owner.js';
import { AUTH_HONEST_NOTICE } from '../auth/contract.js';

const here = dirname(fileURLToPath(import.meta.url));
/** 编译产物根：`.runtime-addons/addons/`（本文件位于其 tests/ 下）。 */
const addonsRoot = dirname(here);

/** 采集/音频相关禁用词：出现在账号链路的任何一行都算违规。 */
const FORBIDDEN_WORDS = [
  'getUserMedia',
  'mediaDevices',
  'AudioContext',
  'webkitAudioContext',
  'MediaRecorder',
  'AudioWorklet',
  'createScriptProcessor',
  'sampling-intent',
  'acoustic-capture',
  'requestCaptureIntent',
  'YAMNet',
  'yamnet',
  'sqlite',
  'quiet.sqlite',
];

/** 反向依赖禁用词：auth 只准依赖 `shared/` 与自己的同目录模块。 */
const FORBIDDEN_IMPORTS = ['../f2/', '../f3/', '../f4/', '../f8/', '../../server/', '../../app/', 'study-store', 'study-routes'];

/** 允许的裸说明符（仓库**既有**依赖；加新依赖必须先改 package.json —— 本范围明确不加）。 */
const ALLOWED_BARE = new Set(['express', 'zod']);

function collectJs(root: string, out: string[] = []): string[] {
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    if (statSync(full).isDirectory()) collectJs(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function importSpecifiers(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/(?:from|require\()\s*['"]([^'"]+)['"]/g)) {
    if (match[1] !== undefined) out.push(match[1]);
  }
  return out;
}

const authFiles = collectJs(join(addonsRoot, 'auth'));
const authSources = authFiles.map((file) => ({ file, text: readFileSync(file, 'utf8') }));

test('C6G-1 addons/auth 编译产物存在且非空（守卫本身不能空跑）', () => {
  assert.ok(authFiles.length >= 4, `auth 产物文件数应当 ≥4，实际 ${authFiles.length}`);
  for (const { file, text } of authSources) {
    assert.ok(text.length > 200, `${file} 内容过短，守卫会空跑`);
  }
});

test('C6G-2 ★ 零 console：auth 链路**结构上**不可能把口令或 token 打进日志', () => {
  for (const { file, text } of authSources) {
    const code = stripComments(text);
    assert.equal(/\bconsole\s*\./.test(code), false, `${file} 里出现了 console.* —— 账号链路禁止任何控制台输出`);
  }
});

test('C6G-3 ★ 零采集/音频依赖 + 零反向依赖 + 零旧库访问', () => {
  for (const { file, text } of authSources) {
    const code = stripComments(text);
    for (const word of FORBIDDEN_WORDS) {
      assert.equal(code.includes(word), false, `${file} 命中禁用词 ${word}`);
    }
    for (const spec of importSpecifiers(text)) {
      for (const bad of FORBIDDEN_IMPORTS) {
        assert.equal(spec.includes(bad), false, `${file} 非法依赖 ${spec}`);
        // 'sqlite' 之类的词在 import 说明符里也不允许。
      }
    }
  }
});

test('C6G-4 ★ 不读 X-Study-Key：账号体系与既有匿名鉴权是两条独立的轴', () => {
  for (const { file, text } of authSources) {
    const code = stripComments(text).toLowerCase();
    assert.equal(code.includes('x-study-key'), false, `${file} 引用了 X-Study-Key —— 账号链路不得触碰既有鉴权`);
    assert.equal(code.includes('ownerhashfrom'), false, `${file} 引用了 ownerHashFrom`);
    assert.equal(code.includes('key_pattern'), false, `${file} 引用了既有 KEY_PATTERN`);
  }
});

test('C6G-5 ★ 零新依赖：说明符只允许 node 内置 / 相对路径 / 既有依赖', () => {
  for (const { file, text } of authSources) {
    for (const spec of importSpecifiers(text)) {
      const ok = spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../') || ALLOWED_BARE.has(spec);
      assert.ok(ok, `${file} 出现未批准依赖：${spec}`);
      if (spec.startsWith('../')) {
        // 只允许回到 addons/ 内部的 shared/。
        assert.ok(spec.startsWith('../shared/'), `${file} 的相对依赖越界：${spec}`);
      }
    }
  }
});

test('C6G-6 新增错误码的 HTTP 状态映射（不改任何既有码）', () => {
  const expected: Array<[AddonErrorCode, number]> = [
    ['AUTH_USERNAME_INVALID', 400],
    ['AUTH_PASSWORD_TOO_SHORT', 400],
    ['AUTH_PASSWORD_TOO_LONG', 400],
    ['AUTH_PASSWORD_WEAK', 400],
    ['AUTH_USERNAME_TAKEN', 409],
    ['AUTH_INVALID_CREDENTIALS', 401],
    ['AUTH_TOKEN_MISSING', 401],
    ['AUTH_TOKEN_INVALID', 401],
    ['AUTH_TOKEN_EXPIRED', 401],
    ['AUTH_TOKEN_REVOKED', 401],
  ];
  for (const [code, status] of expected) {
    assert.equal(new AddonError(code, 'x').status, status, `${code} 应当是 ${status}`);
  }
  // 既有码不受影响（抽样：STUDY_KEY_REQUIRED 仍是 401，STORE_UNAVAILABLE 仍是 503）。
  assert.equal(new AddonError('STUDY_KEY_REQUIRED', 'x').status, 401);
  assert.equal(new AddonError('STORE_UNAVAILABLE', 'x').status, 503);
  assert.equal(new AddonError('STORE_UNAVAILABLE', 'x').retryable, true);
});

test('C6G-7 诚实口径文案确实进了产物，且代码里不含"企业级"（注释里的自我告诫不算）', () => {
  assert.match(AUTH_HONEST_NOTICE, /演示级/);
  const contract = readFileSync(join(addonsRoot, 'auth', 'contract.js'), 'utf8');
  assert.equal(contract.includes(AUTH_HONEST_NOTICE), true, '诚实口径必须随产物一起发布');
  assert.equal(stripComments(contract).includes('企业级'), false, '正式代码里不得出现"企业级"字样');
});
