/**
 * F2 统计契约最小测试（Sol §1A⑤ 第 1–2 行）：
 *  · 正/负/零三种 10 配对与**独立手算**一致；r ∈ [−1,1]；r=0 保持 0；
 *  · 两侧分别零方差、N=9 ⇒ r=null 且 reason 正确；无 NaN/Inf；N=10 才允许数值。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_PAIRS, pearsonPair } from '../f2/pearson.js';

/** 独立手算：用「原始定义式」再实现一遍，避免与被测实现共享同一份库代码。 */
function handPearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

const POS_X = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const POS_Y = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
const NEG_Y = [20, 18, 16, 14, 12, 10, 8, 6, 4, 2];
/** 精确零相关：xs 均值为 0，且 Σ x·y = 0（−35 + 35），手算 r 就是 0。 */
const ZERO_X = [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5];
const ZERO_Y = [1, 2, 3, 4, 5, 5, 4, 3, 2, 1];

test('F2-1 正相关：10 配对与独立手算一致，r 落在 [−1,1]', () => {
  const out = pearsonPair(POS_X, POS_Y);
  assert.equal(out.n, 10);
  assert.equal(out.reason, 'ok');
  assert.ok(out.r !== null);
  assert.ok(Math.abs((out.r as number) - handPearson(POS_X, POS_Y)) < 1e-12);
  assert.ok((out.r as number) > 0.999 && (out.r as number) <= 1);
});

test('F2-2 负相关：符号为负且与独立手算一致', () => {
  const out = pearsonPair(POS_X, NEG_Y);
  assert.equal(out.reason, 'ok');
  assert.ok((out.r as number) < -0.999);
  assert.ok(Math.abs((out.r as number) - handPearson(POS_X, NEG_Y)) < 1e-12);
});

test('F2-3 零相关：r 保持精确 0（不被写成 null，也不被补成非零）', () => {
  assert.equal(handPearson(ZERO_X, ZERO_Y), 0);
  const out = pearsonPair(ZERO_X, ZERO_Y);
  assert.equal(out.n, 10);
  assert.equal(out.reason, 'ok');
  assert.equal(out.r, 0);
});

test('F2-4 N=9 ⇒ insufficient_n 且 r=null（N=10 才允许数值）', () => {
  const out = pearsonPair(POS_X.slice(0, MIN_PAIRS - 1), POS_Y.slice(0, MIN_PAIRS - 1));
  assert.deepEqual(out, { n: 9, r: null, reason: 'insufficient_n' });
  const atThreshold = pearsonPair(POS_X, POS_Y);
  assert.equal(atThreshold.reason, 'ok');
});

test('F2-5 两侧分别零方差 ⇒ zero_variance，且无 NaN/Inf', () => {
  const constX = [3, 3, 3, 3, 3, 3, 3, 3, 3, 3];
  const constY = [7, 7, 7, 7, 7, 7, 7, 7, 7, 7];
  const a = pearsonPair(constX, POS_Y);
  assert.deepEqual(a, { n: 10, r: null, reason: 'zero_variance' });
  const b = pearsonPair(POS_X, constY);
  assert.deepEqual(b, { n: 10, r: null, reason: 'zero_variance' });
  const c = pearsonPair(constX, constY);
  assert.deepEqual(c, { n: 10, r: null, reason: 'zero_variance' });
  for (const out of [a, b, c]) {
    assert.equal(Number.isNaN(out.r as unknown as number), false);
  }
});

test('F2-6 契约错误与「样本不足」分开：长度不等/非有限数直接抛，不返回 null', () => {
  assert.throws(() => pearsonPair([1, 2, 3], [1, 2]), /PAIR_CONTRACT/);
  assert.throws(() => pearsonPair([...POS_X.slice(0, 9), Number.NaN], POS_Y), /PAIR_CONTRACT/);
  assert.throws(() => pearsonPair(POS_X, [...POS_Y.slice(0, 9), Number.POSITIVE_INFINITY]), /PAIR_CONTRACT/);
});

test('F2-7 极端但不退化的输入仍然 r∈[−1,1] 且有限', () => {
  const xs = [1e-9, 2e-9, 3e-9, 4e-9, 5e-9, 6e-9, 7e-9, 8e-9, 9e-9, 1e-8];
  const ys = [1, 1, 1, 1, 1, 1, 1, 1, 1, 2];
  const out = pearsonPair(xs, ys);
  assert.equal(out.reason, 'ok');
  assert.ok(Number.isFinite(out.r as number));
  assert.ok(Math.abs(out.r as number) <= 1);
});
