/**
 * F3 指数公式 / 新鲜度 / 多端聚合与排序最小测试（Sol §1D⑤ 第 1–4 行）。
 *  · 30 s、known ≥80%、AI ≥80% 的边界；全 unknown 或 quiet=noisy=0 ⇒ null，**不能给 100**；
 *  · dBFS 完全不进入公式（换 dBFS 不影响指数）；
 *  · 45 / 300 s 边界、时钟回拨不装 fresh；
 *  · 两个 terminal / 两房间：加权结果与手算一致；异 profile 不排名（mixed_config）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FRESH_MAX_AGE_S,
  QUIET_INDEX_VERSION,
  STALE_MAX_AGE_S,
  compareFreshSameConfigThenValueThenStableRoomId,
  quietIndex,
  strictAccountingPass,
  viewForRoom,
  type RoomAggregate,
  type RoomViewV1,
  type StoredReport,
} from '../f3/contract.js';

/** 默认 = 一个合格的 30 s 窗口（6 × 5 s 桶），quiet=24 s / noisy=6 s ⇒ 指数 80。 */
const span = 30_000;

function agg(over: Partial<RoomAggregate> = {}): RoomAggregate {
  const quietMs = over.quietMs ?? 24_000;
  const noisyMs = over.noisyMs ?? 6_000;
  const unknownMs = over.unknownMs ?? 0;
  return { spanMs: over.spanMs ?? span, quietMs, noisyMs, unknownMs, validInferenceMs: over.validInferenceMs ?? span };
}

function report(over: Partial<StoredReport> = {}): StoredReport {
  const aggregate = over.aggregate ?? agg();
  return {
    reportId: 'r-1',
    roomId: 'study-201',
    terminalId: 't-1',
    terminalSeq: 1,
    sessionId: 's-1',
    generation: 0,
    firstBucket: 0,
    lastBucket: 5,
    indexVersion: QUIET_INDEX_VERSION,
    configKey: 'preproc-v2|tflite-2.16.1|map-v1|decision-v1',
    processingKey: 'qp-proc-v1;agc=off;ch=1;ec=off;fs=16000;ns=off',
    aggregate,
    quietIndex: quietIndex(aggregate).value,
    quietReason: null,
    serverSeq: 1,
    serverReceivedAt: 1_760_000_000_000,
    evidenceReceivedAt: 1_760_000_000_000,
    evidenceEndAt: 1_760_000_000_000,
    bodyHash: 'h',
    ...over,
  };
}

test('F3-1 严格记账：三段必须精确等于 span，否则抛 AGGREGATE_CONTRACT', () => {
  assert.equal(strictAccountingPass(agg()), true);
  assert.equal(strictAccountingPass(agg({ spanMs: 4999 })), false);
  assert.throws(() => quietIndex(agg({ spanMs: 4999 })), /AGGREGATE_CONTRACT/);
});

test('F3-2 30 s 边界：<30 s ⇒ short_window（不补值）', () => {
  assert.deepEqual(quietIndex(agg({ spanMs: 29_999, quietMs: 24_000, noisyMs: 5_999 })), { value: null, reason: 'short_window' });
  const at30 = quietIndex(agg({ spanMs: 30_000, quietMs: 24_000, noisyMs: 6_000, validInferenceMs: 30_000 }));
  assert.equal(at30.reason, null);
  assert.equal(at30.value, 80);
});

test('F3-3 状态未知覆盖：known/span < 80% ⇒ unknown_state_coverage；known=0 ⇒ 同样 null（绝不给 100）', () => {
  const mostlyUnknown = quietIndex(agg({ spanMs: 30_000, quietMs: 12_000, noisyMs: 3_000, unknownMs: 15_000, validInferenceMs: 30_000 }));
  assert.deepEqual(mostlyUnknown, { value: null, reason: 'unknown_state_coverage' });
  const allUnknown = quietIndex(agg({ spanMs: 30_000, quietMs: 0, noisyMs: 0, unknownMs: 30_000, validInferenceMs: 30_000 }));
  assert.deepEqual(allUnknown, { value: null, reason: 'unknown_state_coverage' });
  // 恰好 80% 已知 ⇒ 允许算值
  const boundary = quietIndex(agg({ spanMs: 30_000, quietMs: 24_000, noisyMs: 0, unknownMs: 6_000, validInferenceMs: 30_000 }));
  assert.equal(boundary.value, 100);
});

test('F3-4 AI 有效覆盖：validInferenceMs/span < 80% ⇒ low_ai_coverage', () => {
  const low = quietIndex(agg({ spanMs: 30_000, quietMs: 24_000, noisyMs: 6_000, unknownMs: 0, validInferenceMs: 23_999 }));
  assert.deepEqual(low, { value: null, reason: 'low_ai_coverage' });
  const ok = quietIndex(agg({ spanMs: 30_000, quietMs: 24_000, noisyMs: 6_000, unknownMs: 0, validInferenceMs: 24_000 }));
  assert.equal(ok.value, 80);
});

test('F3-5 当前正式桶形态（unknownMs = 桶宽）⇒ 全部 null，这正是可信缺测结果', () => {
  const current = quietIndex(agg({ spanMs: 30_000, quietMs: 0, noisyMs: 0, unknownMs: 30_000, validInferenceMs: 30_000 }));
  assert.equal(current.value, null);
});

test('F3-6 dBFS 不进入公式：只改 dB 概念量不可能改动指数', () => {
  const a = quietIndex(agg({ spanMs: 30_000, quietMs: 15_000, noisyMs: 15_000, validInferenceMs: 30_000 }));
  const b = quietIndex(agg({ spanMs: 30_000, quietMs: 15_000, noisyMs: 15_000, validInferenceMs: 30_000 }));
  assert.deepEqual(a, b);
  assert.equal(a.value, 50);
});

test('F3-7 新鲜度边界：45 / 300 s；时钟回拨 ⇒ clock_anomaly 而不是 fresh', () => {
  const now = 1_760_000_000_000;
  const at = (ageS: number): RoomViewV1 => viewForRoom({
    roomId: 'study-201',
    reports: [report({ evidenceEndAt: now - ageS * 1000 })],
    terminalCount: 1,
    now,
  });
  assert.equal(at(FRESH_MAX_AGE_S).status, 'fresh');
  assert.equal(at(FRESH_MAX_AGE_S + 0.001).status, 'stale');
  assert.equal(at(STALE_MAX_AGE_S).status, 'stale');
  assert.equal(at(STALE_MAX_AGE_S + 0.001).status, 'unknown');
  assert.equal(at(STALE_MAX_AGE_S + 0.001).reason, 'expired');
  const future = at(-30);
  assert.equal(future.status, 'unknown');
  assert.equal(future.reason, 'clock_anomaly');
  assert.equal(future.quietIndex, null);
  const noEvidence = viewForRoom({ roomId: 'study-201', reports: [report({ evidenceEndAt: null })], terminalCount: 1, now });
  assert.equal(noEvidence.status, 'unknown');
  assert.equal(noEvidence.reason, 'no_evidence_time');
});

test('F3-8 stale 保留旧时点与旧值用于解释，但不进 fresh 排名', () => {
  const now = 1_760_000_000_000;
  const stale = viewForRoom({ roomId: 'study-201', reports: [report({ evidenceEndAt: now - 120_000 })], terminalCount: 1, now });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.quietIndex, 80);
  assert.ok((stale.ageSeconds ?? 0) > 60);
});

test('F3-9 两个 terminal 同 profile：按 knownMs 加权，与手算一致', () => {
  const now = 1_760_000_000_000;
  const end = now - 10_000;
  const a = report({ reportId: 'a', terminalId: 't-a', serverSeq: 1, evidenceEndAt: end, aggregate: agg({ spanMs: 30_000, quietMs: 22_500, noisyMs: 7_500, unknownMs: 0, validInferenceMs: 30_000 }) });
  const b = report({ reportId: 'b', terminalId: 't-b', serverSeq: 2, evidenceEndAt: end, aggregate: agg({ spanMs: 30_000, quietMs: 9_000, noisyMs: 21_000, unknownMs: 0, validInferenceMs: 30_000 }) });
  const view = viewForRoom({ roomId: 'study-201', reports: [a, b], terminalCount: 2, now });
  assert.equal(view.status, 'fresh');
  // (22500+9000)/(30000+30000) = 0.525 → 52.5
  assert.ok(Math.abs((view.quietIndex as number) - 52.5) < 1e-9);
  assert.equal(view.terminalCount, 2);
});

test('F3-9b 报告级指数为 null 的记录不参与房间加权（有可比有效指数才排序）', () => {
  const now = 1_760_000_000_000;
  const end = now - 10_000;
  const good = report({ reportId: 'a', terminalId: 't-a', serverSeq: 1, evidenceEndAt: end });
  // 桶宽全 unknown：报告级 quietIndex=null（unknown_state_coverage），不得进入加权分子。
  const allUnknown = report({
    reportId: 'b',
    terminalId: 't-b',
    serverSeq: 2,
    evidenceEndAt: end,
    aggregate: agg({ spanMs: 30_000, quietMs: 0, noisyMs: 0, unknownMs: 30_000, validInferenceMs: 30_000 }),
  });
  const view = viewForRoom({ roomId: 'study-201', reports: [good, allUnknown], terminalCount: 2, now });
  assert.equal(view.status, 'fresh');
  assert.equal(view.quietIndex, 80);
});

test('F3-10 异 profile（configKey 不同）⇒ 不生成单一房间指数（mixed_config）', () => {
  const now = 1_760_000_000_000;
  const a = report({ reportId: 'a', terminalId: 't-a', evidenceEndAt: now - 5_000 });
  const b = report({ reportId: 'b', terminalId: 't-b', evidenceEndAt: now - 5_000, configKey: 'other|conf|set|x' });
  const view = viewForRoom({ roomId: 'study-201', reports: [a, b], terminalCount: 2, now });
  assert.equal(view.status, 'unknown');
  assert.equal(view.reason, 'mixed_config');
  assert.equal(view.quietIndex, null);
  assert.equal(view.terminalCount, 2);
});

test('F3-11 排序：可比 fresh 按指数降序 → stale → unknown → 稳定 roomId', () => {
  const rows: RoomViewV1[] = [
    { roomId: 'reading-101', indexVersion: QUIET_INDEX_VERSION, quietIndex: 40, status: 'fresh', reason: null, serverReceivedAt: 1, evidenceReceivedAt: 1, evidenceEndAt: 1, serverSeq: 1, ageSeconds: 1, terminalCount: 1, configKey: 'x', processingKey: null },
    { roomId: 'study-201', indexVersion: QUIET_INDEX_VERSION, quietIndex: null, status: 'unknown', reason: 'no_report', serverReceivedAt: null, evidenceReceivedAt: null, evidenceEndAt: null, serverSeq: null, ageSeconds: null, terminalCount: 0, configKey: null, processingKey: null },
    { roomId: 'discussion-302', indexVersion: QUIET_INDEX_VERSION, quietIndex: 90, status: 'fresh', reason: null, serverReceivedAt: 1, evidenceReceivedAt: 1, evidenceEndAt: 1, serverSeq: 1, ageSeconds: 1, terminalCount: 1, configKey: 'x', processingKey: null },
  ];
  const sorted = [...rows].sort(compareFreshSameConfigThenValueThenStableRoomId).map((r) => r.roomId);
  assert.deepEqual(sorted, ['discussion-302', 'reading-101', 'study-201']);
});

test('F3-12 无报告的房间是 unknown/no_report，且值为 null（不假绿）', () => {
  const view = viewForRoom({ roomId: 'discussion-302', reports: [], terminalCount: 0, now: 1_760_000_000_000 });
  assert.equal(view.status, 'unknown');
  assert.equal(view.reason, 'no_report');
  assert.equal(view.quietIndex, null);
});
