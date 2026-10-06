/**
 * F2 资格 / 分组最小测试（Sol §1A⑤ 第 3–6 行）：
 *  · fixture/demo/replay/污染/unknown 混入 **不能增加 N**；
 *  · processing 空/unknown ⇒ `blocked_unknown_processing`（不靠 flags=[] 放行）；
 *  · 可信但不同 profile **分别成组**，不池化凑 10；
 *  · 一 session 100 桶仍只产生**一对**；C/V 正确；零 V ⇒ `no_valid_inference`；
 *  · 跨配置/桶版本不匹配 ⇒ 阻断；零方差 ⇒ 无数值。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORY_IDS } from '../../shared/study-model.js';
import {
  acceptSession,
  geometryAndTotals,
  groupedCategoryPearson,
  parseCategoryMs,
  type BucketShape,
  type Passport,
  type SessionShape,
} from '../f2/eligibility.js';

const VERIFIED_PROCESSING = 'qp-proc-v1;agc=off;ch=1;ec=off;fs=16000;ns=off';
const OTHER_PROCESSING = 'qp-proc-v1;agc=on;ch=1;ec=off;fs=16000;ns=off';

function makeSession(over: Partial<SessionShape> = {}): SessionShape {
  return {
    sessionId: over.sessionId ?? '11111111-1111-4111-8111-111111111111',
    startTime: 1_760_000_000_000,
    durationMs: 300_000,
    status: 'ended',
    scoreRevision: 1,
    aggregateRevision: 1,
    userFocusScore: 4,
    userEfficiencyScore: 3,
    quietDuration: 100,
    noisyDuration: 100,
    interruptionCount: 1,
    coverageRatio: 1,
    sampleCount: 60,
    sampleClippedCount: 0,
    qualityFlags: '[]',
    expectedBucketCount: 60,
    modelHash: 'a'.repeat(64),
    runtimeVersion: 'tflite-2.16.1',
    preprocessVersion: 'preproc-v2',
    mapVersion: 'map-v1',
    decisionVersion: 'decision-v1',
    processing: VERIFIED_PROCESSING,
    ...over,
  };
}

/** 生成 count 个连续 5 s 桶；conversationMs 是每桶的 conversation 暴露。 */
function makeBuckets(session: SessionShape, count: number, conversationMs: number, over: Partial<BucketShape> = {}): BucketShape[] {
  const out: BucketShape[] = [];
  for (let i = 0; i < count; i += 1) {
    const width = i === count - 1 ? (session.durationMs ?? 0) - i * 5000 : 5000;
    const categoryMs = Object.fromEntries(CATEGORY_IDS.map((id) => [id, id === 'conversation' ? conversationMs : 0]));
    out.push({
      bucketIndex: i,
      startOffsetMs: i * 5000,
      endOffsetMs: i * 5000 + width,
      quietMs: 0,
      noisyMs: width,
      unknownMs: 0,
      validInferenceMs: width,
      classifiedMs: width,
      categoryUnknownMs: 0,
      categoryMs: JSON.stringify(categoryMs),
      modelHash: session.modelHash,
      runtimeVersion: session.runtimeVersion,
      preprocessVersion: session.preprocessVersion,
      mapVersion: session.mapVersion,
      decisionVersion: session.decisionVersion,
      ...over,
    });
  }
  return out;
}

function passportFor(session: SessionShape, over: Partial<Passport> = {}): Passport {
  return {
    sessionId: session.sessionId,
    scoreRevision: session.scoreRevision,
    provenance: 'real',
    scoreAckObserved: true,
    ...over,
  };
}

test('F2-8 合格 session 被接受：分母 validInferenceMs、暴露 = ΣcategoryMs/ΣvalidInferenceMs', () => {
  const session = makeSession();
  const buckets = makeBuckets(session, 60, 1000);
  const out = acceptSession(session, buckets, passportFor(session));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.pair.exposure.conversation, 1000 / 5000);
  assert.equal(out.pair.exposure.paper, 0);
  assert.equal(out.pair.focus, 4);
  assert.equal(out.pair.efficiency, 3);
});

test('F2-9 一 session 100 桶仍然只产生一对样本（绝不把桶当样本）', () => {
  const session = makeSession({ durationMs: 500_000, expectedBucketCount: 100, sampleCount: 100 });
  const buckets = makeBuckets(session, 100, 500);
  const pairs: ReturnType<typeof acceptSession>[] = [acceptSession(session, buckets, passportFor(session))];
  const accepted = pairs.filter((p) => p.ok);
  assert.equal(accepted.length, 1);
  const groups = groupedCategoryPearson(accepted.map((p) => (p.ok ? p.pair : null)).filter((p): p is NonNullable<typeof p> => p !== null));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].sessionN, 1);
  const conv = groups[0].pairs.find((p) => p.category === 'conversation' && p.score === 'focus');
  assert.equal(conv?.n, 1);
  assert.equal(conv?.r, null);
  assert.equal(conv?.reason, 'insufficient_n');
});

test('F2-10 来源不是 real / 缺 ACK / revision 不匹配 ⇒ 明确排除，且理由可区分', () => {
  const session = makeSession();
  const buckets = makeBuckets(session, 60, 1000);
  assert.deepEqual(acceptSession(session, buckets, undefined), { ok: false, reason: 'no_passport' });
  assert.equal(acceptSession(session, buckets, passportFor(session, { provenance: 'fixture' })).ok, false);
  assert.equal(acceptSession(session, buckets, passportFor(session, { provenance: 'demo' })).ok, false);
  assert.equal(acceptSession(session, buckets, passportFor(session, { provenance: 'replay' })).ok, false);
  assert.equal(acceptSession(session, buckets, passportFor(session, { provenance: 'unknown' })).ok, false);
  assert.equal(acceptSession(session, buckets, passportFor(session, { provenance: 'measurement' })).ok, false);
  assert.equal(acceptSession(session, buckets, passportFor(session, { scoreAckObserved: false })).ok, false);
  const stale = acceptSession(session, buckets, passportFor(session, { scoreRevision: 0 }));
  assert.deepEqual(stale, { ok: false, reason: 'revision_stale' });
});

test('F2-11 非 real 来源混入不改变 N（真分组结果逐字不变）', () => {
  const good: SessionShape[] = [];
  const bucketsOf = new Map<string, BucketShape[]>();
  for (let i = 0; i < 12; i += 1) {
    const session = makeSession({
      sessionId: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`,
      userFocusScore: 1 + (i % 5),
    });
    good.push(session);
    bucketsOf.set(session.sessionId, makeBuckets(session, 60, 200 * i));
  }
  const acceptAll = (extraProvenanceFilter?: string): number => {
    const accepted = [];
    for (const session of good) {
      const travel = extraProvenanceFilter === undefined ? passportFor(session) : passportFor(session, { provenance: extraProvenanceFilter });
      const out = acceptSession(session, bucketsOf.get(session.sessionId) ?? [], travel);
      if (out.ok) accepted.push(out.pair);
    }
    const groups = groupedCategoryPearson(accepted);
    return groups.length === 0 ? 0 : groups[0].sessionN;
  };
  const baseline = acceptAll();
  assert.equal(baseline, 12);
  // 用 fixture/demo/replay 来源跑同一批：一条都不该进来。
  assert.equal(acceptAll('fixture'), 0);
  assert.equal(acceptAll('demo'), 0);
  assert.equal(acceptAll('replay'), 0);
});

test('F2-12 processing 为空 / unknown / 只有前缀 ⇒ blocked_unknown_processing（不靠 flags 放行）', () => {
  for (const processing of ['', 'unknown', '未报告', 'qp-proc-v1;fs=16000;agc=未报告']) {
    const session = makeSession({ processing });
    const out = acceptSession(session, makeBuckets(session, 60, 100), passportFor(session));
    assert.deepEqual(out, { ok: false, reason: 'blocked_unknown_processing' });
  }
});

test('F2-13 可信但不同 processing profile 分别成组，不池化凑 10', () => {
  const accepted = [];
  for (let i = 0; i < 6; i += 1) {
    const a = makeSession({ sessionId: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`, processing: VERIFIED_PROCESSING, userFocusScore: 1 + (i % 5) });
    const ra = acceptSession(a, makeBuckets(a, 60, 300 * i), passportFor(a));
    if (ra.ok) accepted.push(ra.pair);
    const b = makeSession({ sessionId: `${String(100 + i).padStart(8, '0')}-1111-4111-8111-111111111111`, processing: OTHER_PROCESSING, userFocusScore: 5 - (i % 5) });
    const rb = acceptSession(b, makeBuckets(b, 60, 300 * i), passportFor(b));
    if (rb.ok) accepted.push(rb.pair);
  }
  const groups = groupedCategoryPearson(accepted);
  assert.equal(groups.length, 2);
  for (const group of groups) {
    assert.equal(group.sessionN, 6);
    const conv = group.pairs.find((p) => p.category === 'conversation' && p.score === 'focus');
    assert.equal(conv?.n, 6);
    assert.equal(conv?.r, null);
    assert.equal(conv?.reason, 'insufficient_n');
  }
  assert.notEqual(groups[0].processingKey, groups[1].processingKey);
});

test('F2-14 零 validInferenceMs ⇒ no_valid_inference；不是"零相关"', () => {
  const session = makeSession();
  const buckets = makeBuckets(session, 60, 0, { validInferenceMs: 0, quietMs: 0, noisyMs: 5000, unknownMs: 0 });
  const out = acceptSession(session, buckets, passportFor(session));
  assert.deepEqual(out, { ok: false, reason: 'no_valid_inference' });
});

test('F2-15 桶版本与 session 不一致 / 桶号有洞 / 末桶被补足 ⇒ geometry 阻断', () => {
  const session = makeSession();
  const mismatched = makeBuckets(session, 60, 100, { mapVersion: 'map-v0' });
  assert.equal(acceptSession(session, mismatched, passportFor(session)).ok, false);

  const holed = makeBuckets(session, 60, 100).filter((b) => b.bucketIndex !== 30);
  assert.equal(acceptSession(session, holed, passportFor(session)).ok, false);

  const padded = makeBuckets(session, 60, 100);
  padded[padded.length - 1] = { ...padded[padded.length - 1], endOffsetMs: 300_000 + 5000 };
  const geometry = geometryAndTotals(session, padded);
  assert.equal(geometry.ok, false);
});

test('F2-16 categoryMs 白名单：未知键 / 负数 / 非法 JSON 一律拒绝（不静默丢键）', () => {
  assert.equal(parseCategoryMs('{"conversation":100}')?.conversation, 100);
  assert.equal(parseCategoryMs('{"not_a_category":100}'), null);
  assert.equal(parseCategoryMs('{"conversation":-1}'), null);
  assert.equal(parseCategoryMs('{'), null);
  assert.equal(parseCategoryMs('[]'), null);
});

test('F2-17 零方差：同一暴露 10 段 ⇒ r=null + zero_variance（不得 0）', () => {
  const accepted = [];
  for (let i = 0; i < 10; i += 1) {
    const session = makeSession({
      sessionId: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`,
      userFocusScore: 1 + (i % 5),
    });
    const out = acceptSession(session, makeBuckets(session, 60, 500), passportFor(session));
    if (out.ok) accepted.push(out.pair);
  }
  const groups = groupedCategoryPearson(accepted);
  assert.equal(groups.length, 1);
  const conv = groups[0].pairs.find((p) => p.category === 'conversation' && p.score === 'focus');
  assert.equal(conv?.n, 10);
  assert.equal(conv?.r, null);
  assert.equal(conv?.reason, 'zero_variance');
});
