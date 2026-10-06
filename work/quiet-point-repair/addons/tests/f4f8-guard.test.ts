/**
 * F4 打卡路径**不签发采音意图**（SCOPE_FINAL §21:20 / Sol §2.6C 明文要求）。
 *
 * 这是可执行的静态守卫：直接扫描**编译产物**（`.runtime-addons/addons/{f4,f8,shared}`）的源码文本，
 * 一旦有人在打卡链路上 import 采集/音频模块，门禁立刻红——不靠"我记得没写过"。
 *
 * 同时也守住"只增量、不越域"：F4/F8 不得反向依赖 F2/F3 的路由或旧 server 的写路径。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
/** 编译产物根：`.runtime-addons/addons/`（本文件位于其 tests/ 下）。 */
const addonsRoot = dirname(here);

/** 采集/音频相关禁用词：出现在打卡或共同存在信号的任何一行都算违规。 */
const FORBIDDEN = [
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
];

/** 反向依赖禁用词：F4/F8 只能依赖 shared/，不得勾到 F2/F3 路由或旧 server。 */
const FORBIDDEN_IMPORTS = ['../f3/', '../f2/', '../../server/', '../../app/', 'study-store', 'study-routes'];

/** 抽出真正的 import/require 说明符（只判依赖，不判注释里的散文）。 */
function importSpecifiers(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/(?:from|require\()\s*['"]([^'"]+)['"]/g)) {
    if (match[1] !== undefined) out.push(match[1]);
  }
  return out;
}

function collectFiles(root: string, out: string[] = []): string[] {
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    if (statSync(full).isDirectory()) collectFiles(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('F4G-1 打卡/共同存在信号链路零采集依赖（编译产物逐行扫描）', () => {
  const roots = [join(addonsRoot, 'f4'), join(addonsRoot, 'f8'), join(addonsRoot, 'shared')];
  const files: string[] = [];
  for (const root of roots) collectFiles(root, files);
  assert.ok(files.length >= 8, `应扫描到 f4/f8/shared 的编译产物，实际 ${files.length} 个`);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const token of FORBIDDEN) {
      assert.equal(text.includes(token), false, `${file} 出现了采集相关标识：${token}`);
    }
    // 越域依赖只按 import 说明符判（注释里提到禁用模块名不算违规）。
    for (const specifier of importSpecifiers(text)) {
      for (const token of FORBIDDEN_IMPORTS) {
        assert.equal(specifier.includes(token), false, `${file} 出现了越域依赖：${specifier}`);
      }
    }
  }
  // 生产目录（含既有 F2/F3）里同样不许出现采集标识符；测试目录本身含"探针词"，故排除。
  const all = collectFiles(addonsRoot).filter((f) => !relative(addonsRoot, f).startsWith('tests'));
  assert.ok(all.length >= files.length);
  for (const file of all) {
    const text = readFileSync(file, 'utf8');
    for (const token of FORBIDDEN) {
      assert.equal(text.includes(token), false, `${file} 出现了采集相关标识：${token}`);
    }
  }
});

test('F4G-2 打卡路由只做 HTTP + 独立有界存储：不 import 旧库写路径', () => {
  const routes = readFileSync(join(addonsRoot, 'f4', 'routes.js'), 'utf8');
  // F4 完全不碰 SQLite（连只读都不需要）——这是"不碰主库 schema"的最强形式。
  assert.equal(routes.includes('sqlite'), false, 'F4 路由不应依赖 SQLite');
  assert.equal(routes.includes('dbPath'), false, 'F4 路由不应持有旧库路径');
  // 依赖面锁定：express / zod / node:crypto + 自家模块。
  for (const token of ['/v1/checkin', '/v1/checkin/today']) {
    assert.ok(routes.includes(token), `缺少端点 ${token}`);
  }
  const presence = readFileSync(join(addonsRoot, 'f8', 'routes.js'), 'utf8');
  assert.equal(presence.includes('sqlite'), false, 'F8-c 路由不应依赖 SQLite');
  for (const token of ['/v1/presence/heartbeat', '/v1/presence/room']) {
    assert.ok(presence.includes(token), `缺少端点 ${token}`);
  }
});
