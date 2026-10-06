/**
 * YAMNet 类别映射源文本生成器（确定性、可校验、可 --check）。
 *
 * 依据 Sol 裁决 §2：
 *  - 唯一主线：构建前从**已核实身份**的本地 CSV 生成 `shared/generated/acoustic-map-source.ts`，
 *    Vite 与 tsc/node 两条路径都 import 同一个生成模块；**不用** vite define、不做运行时 fetch、
 *    不读 work 目录、不新增 API。
 *  - 源身份不符（字节数/SHA256/表头/521 行/index 连续唯一/mid 唯一/RFC4180 语法）→ **显式失败**，
 *    绝不"重算 hash 并自动信任"。
 *  - `--check` 只读：重新生成期望字节并与磁盘文件逐字节比较，源码缺失/hash 错/生成文件缺失或陈旧
 *    一律非零退出（供 CI/门禁调用）。
 *  - 输出确定性：无时间戳、稳定 LF；内容相同则不重写（原子替换）。
 *
 * 用法：
 *   node scripts/generate-acoustic-map.mjs            # 生成/更新
 *   node scripts/generate-acoustic-map.mjs --check    # 只校验（不改文件）
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/** 可选的 --source/--out 覆盖：**仅供测试**构造负例（真实运行一律用下面的默认路径）。 */
function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

/** 唯一源文件：相对脚本位置解析，不依赖启动 cwd。 */
const SOURCE_CSV = argValue('--source') ? resolve(argValue('--source')) : resolve(HERE, '../../models/yamnet-class-map.csv');
/** 生成产物（Vite 与 node 共用）。 */
const OUT_TS = argValue('--out')
  ? resolve(argValue('--out'))
  : join(REPO_ROOT, 'shared', 'generated', 'acoustic-map-source.ts');

/** 已核实的源身份（原始磁盘字节，含 CRLF 与末尾换行）。 */
const SOURCE_BYTES_EXPECTED = 14_096;
const SOURCE_FILE_SHA256_EXPECTED = 'CDF24D193E196D9E95912A2667051AE203E92A2BA09449218CCB40EF787C6DF2';
/** 规范化（去 BOM、CRLF→LF、去末尾换行）后的身份。 */
const NORMALIZED_BYTES_EXPECTED = 13_573;
const NORMALIZED_SHA256_EXPECTED = '5102B30793D8F5E53F8261C3FF1FBB65966C4C012805BEDB5A2382403FAC4097';
const EXPECTED_CLASS_COUNT = 521;
const HEADER = ['index', 'mid', 'display_name'];

const sha256Upper = (buf) => createHash('sha256').update(buf).digest('hex').toUpperCase();

/** RFC4180 解析（引号包裹、字段内逗号/换行、"" 转义）；拒绝未闭合引号与多余字段。 */
function parseCsvStrict(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (inQuotes) throw new Error('CSV 语法错误：存在未闭合的引号字段');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function readSource() {
  if (!existsSync(SOURCE_CSV)) {
    throw new Error(`源 CSV 不存在：${SOURCE_CSV}`);
  }
  const raw = readFileSync(SOURCE_CSV);
  if (raw.length !== SOURCE_BYTES_EXPECTED) {
    throw new Error(`源 CSV 字节数不符：${raw.length} ≠ ${SOURCE_BYTES_EXPECTED}`);
  }
  const rawSha = sha256Upper(raw);
  if (rawSha !== SOURCE_FILE_SHA256_EXPECTED) {
    throw new Error(`源 CSV SHA256 不符：${rawSha} ≠ ${SOURCE_FILE_SHA256_EXPECTED}`);
  }

  let text = raw.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去 BOM
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (text.endsWith('\n')) text = text.slice(0, -1); // 去末尾换行

  const normalized = Buffer.from(text, 'utf8');
  if (normalized.length !== NORMALIZED_BYTES_EXPECTED) {
    throw new Error(`规范化字节数不符：${normalized.length} ≠ ${NORMALIZED_BYTES_EXPECTED}`);
  }
  const normalizedSha = sha256Upper(normalized);
  if (normalizedSha !== NORMALIZED_SHA256_EXPECTED) {
    throw new Error(`规范化 SHA256 不符：${normalizedSha} ≠ ${NORMALIZED_SHA256_EXPECTED}`);
  }

  const rows = parseCsvStrict(text);
  if (rows.length !== EXPECTED_CLASS_COUNT + 1) {
    throw new Error(`CSV 行数不符：${rows.length} ≠ ${EXPECTED_CLASS_COUNT}+1`);
  }
  const header = rows[0];
  if (header.length !== HEADER.length || header.some((h, idx) => h !== HEADER[idx])) {
    throw new Error(`CSV 表头不符：${JSON.stringify(header)} ≠ ${JSON.stringify(HEADER)}`);
  }

  const seenIndex = new Set();
  const seenMid = new Set();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length !== HEADER.length) {
      throw new Error(`第 ${r} 行字段数不是 ${HEADER.length}：${JSON.stringify(row)}`);
    }
    const indexValue = Number(row[0]);
    if (!Number.isInteger(indexValue) || indexValue < 0 || indexValue >= EXPECTED_CLASS_COUNT) {
      throw new Error(`第 ${r} 行 index 非法：${JSON.stringify(row[0])}`);
    }
    if (seenIndex.has(indexValue)) throw new Error(`index 重复：${indexValue}`);
    seenIndex.add(indexValue);
    const mid = row[1];
    // AudioSet 的 mid 有三种真实前缀（本文件实测分布：/m/ 489、/t/ 31、/g/ 1）。
    if (!/^\/(m|t|g)\/[0-9a-zA-Z_]+$/.test(mid)) throw new Error(`第 ${r} 行 mid 非法：${mid}`);
    if (seenMid.has(mid)) throw new Error(`mid 重复：${mid}`);
    seenMid.add(mid);
  }
  for (let expect = 0; expect < EXPECTED_CLASS_COUNT; expect++) {
    if (!seenIndex.has(expect)) throw new Error(`index 缺号：${expect}`);
  }
  return { text, normalizedSha, rawSha };
}

function renderTs(text) {
  return `/**
 * ⚠️ 本文件由 scripts/generate-acoustic-map.mjs 生成，请勿手改。
 *
 * 源：work/models/yamnet-class-map.csv（原始 ${SOURCE_BYTES_EXPECTED} B / SHA256 ${SOURCE_FILE_SHA256_EXPECTED}）
 * 规范化：去 BOM、CRLF→LF、去末尾换行 → ${NORMALIZED_BYTES_EXPECTED} B / SHA256 ${NORMALIZED_SHA256_EXPECTED}
 * 类别数：${EXPECTED_CLASS_COUNT}
 *
 * 重新生成：node scripts/generate-acoustic-map.mjs
 * 只校验：  node scripts/generate-acoustic-map.mjs --check
 */

export const MAP_SOURCE_BYTES = ${SOURCE_BYTES_EXPECTED};
export const MAP_SOURCE_FILE_SHA256 = '${SOURCE_FILE_SHA256_EXPECTED}';
export const MAP_SOURCE_NORMALIZED_BYTES = ${NORMALIZED_BYTES_EXPECTED};
export const MAP_SOURCE_SHA256 = '${NORMALIZED_SHA256_EXPECTED}';
export const EXPECTED_CLASS_COUNT = ${EXPECTED_CLASS_COUNT};

/** 内嵌 CSV 文本（RFC4180；生成时用 JSON.stringify，避免反引号/插值破坏数据）。 */
export const MAP_CSV_TEXT = ${JSON.stringify(text)};
`;
}

function writeAtomicIfChanged(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (current === content) return { changed: false };
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content, { encoding: 'utf8' });
    renameSync(tmp, path);
  } catch (err) {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
    throw err;
  }
  return { changed: true };
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const { text, normalizedSha, rawSha } = readSource();
  const expected = renderTs(text);

  if (checkOnly) {
    if (!existsSync(OUT_TS)) {
      console.error(`[acoustic-map] CHECK FAILED：生成文件缺失 ${OUT_TS}`);
      process.exit(2);
    }
    const actual = readFileSync(OUT_TS, 'utf8');
    if (actual !== expected) {
      console.error('[acoustic-map] CHECK FAILED：生成文件与源不一致（陈旧或手工改动）');
      process.exit(3);
    }
    console.log(
      `[acoustic-map] CHECK OK classes=${EXPECTED_CLASS_COUNT} raw=${rawSha.slice(0, 12)}… normalized=${normalizedSha.slice(0, 12)}…`,
    );
    return;
  }

  const { changed } = writeAtomicIfChanged(OUT_TS, expected);
  console.log(
    `[acoustic-map] ${changed ? 'GENERATED' : 'UNCHANGED'} classes=${EXPECTED_CLASS_COUNT} ` +
      `bytes=${Buffer.byteLength(text, 'utf8')} sha=${normalizedSha.slice(0, 12)}… → ${OUT_TS}`,
  );
}

try {
  main();
} catch (err) {
  console.error(`[acoustic-map] FAILED：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
