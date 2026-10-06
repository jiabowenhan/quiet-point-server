// 阶段三：关联分析与建议（CODEX_DECISION_AI.md §6）
// 全部为确定性统计与模板文案：不调用云模型、不做显著性检验、不从常识编造洞察。
// 本文件保持纯函数（无 DB、无 IO），以便用构造数据验算具体数值。
import {
  CATEGORY_IDS,
  ELIGIBILITY,
  GROUP_THRESHOLDS,
  SUGGESTION_GATES,
  StudyError,
  TIER_PRELIMINARY_MIN,
  TIER_STATISTICAL_MIN,
  type StudySessionView,
} from '../shared/study-model.js';
import { median } from './core.js';

type Row = Record<string, any>;

// ---------------------------------------------------------------------------
// 时区与区间（§7 日期归属：按选定 IANA timezone 求本地日/周边界）
// ---------------------------------------------------------------------------

const ZONE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = ZONE_FORMATTERS.get(timezone);
  if (cached) return cached;
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmt.format(new Date(0));
  } catch {
    throw new StudyError('VALIDATION_FAILED', `未知的 IANA 时区：${timezone}`);
  }
  ZONE_FORMATTERS.set(timezone, fmt);
  return fmt;
}

export function resolveZone(timezone: string): string {
  formatterFor(timezone);
  return timezone;
}

export interface LocalParts { year: number; month: number; day: number; hour: number; minute: number }

export function localParts(epoch: number, timezone: string): LocalParts {
  const fmt = formatterFor(timezone);
  const parts = fmt.formatToParts(new Date(epoch));
  const pick = (type: string): number => Number(parts.find((p: Intl.DateTimeFormatPart) => p.type === type)?.value ?? '0');
  return { year: pick('year'), month: pick('month'), day: pick('day'), hour: pick('hour'), minute: pick('minute') };
}

/** 该时刻的时区偏移（毫秒）。 */
export function zoneOffsetMs(epoch: number, timezone: string): number {
  const p = localParts(epoch, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, Math.floor(epoch / 1000) % 60);
  return asUtc - Math.floor(epoch / 1000) * 1000;
}

function midnightOf(year: number, month: number, day: number, timezone: string): number {
  const wall = Date.UTC(year, month - 1, day);
  let guess = wall;
  for (let i = 0; i < 4; i += 1) guess = wall - zoneOffsetMs(guess, timezone);
  // §4.1「本地日历」边界：DST 切换在本地 00:00 时，这一天的 00:00 **并不存在**
  // （时钟直接跳到 01:00，偏移迭代会把 guess 落在前一天 23:00，出现「重复一天」）。
  // 此时取该本地日期第一个真实存在的时刻（分钟粒度，时区偏移都是整分钟）。
  for (let i = 0; i < 180 && !isLocalDate(guess, year, month, day, timezone); i += 1) guess += 60_000;
  return guess;
}

function isLocalDate(epoch: number, year: number, month: number, day: number, timezone: string): boolean {
  const p = localParts(epoch, timezone);
  return p.year === year && p.month === month && p.day === day;
}

/** 本地日 0 点。 */
export function zoneDayStart(epoch: number, timezone: string): number {
  const p = localParts(epoch, timezone);
  return midnightOf(p.year, p.month, p.day, timezone);
}

function shiftDate(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const t = new Date(Date.UTC(year, month - 1, day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

export function zoneDayEnd(epoch: number, timezone: string): number {
  const p = localParts(epoch, timezone);
  const next = shiftDate(p.year, p.month, p.day, 1);
  return midnightOf(next.year, next.month, next.day, timezone);
}

/** 本地日字符串 YYYY-MM-DD（不得用 UTC substring 代替）。 */
export function zoneDateString(epoch: number, timezone: string): string {
  const p = localParts(epoch, timezone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** 本地周一 0 点（ISO 周：周一为一周之始）。 */
export function zoneWeekStart(epoch: number, timezone: string): number {
  const p = localParts(epoch, timezone);
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  const back = (dow + 6) % 7;
  const monday = shiftDate(p.year, p.month, p.day, -back);
  return midnightOf(monday.year, monday.month, monday.day, timezone);
}

export function zoneWeekEnd(epoch: number, timezone: string): number {
  const start = zoneWeekStart(epoch, timezone);
  const p = localParts(start, timezone);
  const next = shiftDate(p.year, p.month, p.day, 7);
  return midnightOf(next.year, next.month, next.day, timezone);
}

/** [startA,endA) ∩ [startB,endB) 的长度（跨午夜时长按交集分配）。 */
export function allocateIntersection(startA: number, endA: number, startB: number, endB: number): number {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

// ---------------------------------------------------------------------------
// Spearman（§6.157：并列值平均秩，再对秩算 Pearson；零方差 → null）
// ---------------------------------------------------------------------------

export type SpearmanStatus = 'OK' | 'NO_VARIATION' | 'NO_PAIR';

export function averageRanks(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => (a.v === b.v ? a.i - b.i : a.v - b.v));
  const ranks = new Array<number>(values.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].v === order[i].v) j += 1;
    // 1-based 平均秩
    const avg = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k += 1) ranks[order[k].i] = avg;
    i = j + 1;
  }
  return ranks;
}

export interface SpearmanResult { rho: number | null; status: SpearmanStatus; n: number }

/**
 * rho = Σ(Rx−meanRx)(Ry−meanRy) / sqrt(Σdx²·Σdy²)
 * 任一方零方差（或配对不足 2）→ rho=null，状态 NO_VARIATION / NO_PAIR。
 * 注意：rho=0 是合法的「无单调关联」，与零方差的 null 语义严格区分。
 */
export function spearman(xs: readonly number[], ys: readonly number[]): SpearmanResult {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return { rho: null, status: 'NO_PAIR', n };
  const rx = averageRanks(xs.slice(0, n));
  const ry = averageRanks(ys.slice(0, n));
  const meanX = rx.reduce((a, b) => a + b, 0) / n;
  const meanY = ry.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = rx[i] - meanX;
    const dy = ry[i] - meanY;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return { rho: null, status: 'NO_VARIATION', n };
  return { rho: sxy / Math.sqrt(sxx * syy), status: 'OK', n };
}

// ---------------------------------------------------------------------------
// 样本量分档（§6.163）
// ---------------------------------------------------------------------------

export type Tier = 'insufficient' | 'preliminary' | 'statistical';

export function tierFor(n: number): Tier {
  if (n < TIER_PRELIMINARY_MIN) return 'insufficient';
  if (n < TIER_STATISTICAL_MIN) return 'preliminary';
  return 'statistical';
}

// ---------------------------------------------------------------------------
// 入选门槛（§6.161）
// ---------------------------------------------------------------------------

export const ANOMALY_FLAGS = ['clock_anomaly', 'samplerate_anomaly', 'processing_anomaly', 'processing_settings_changed'];
export const EXCLUSION_REASONS: Record<string, string> = {
  not_ended: '尚未结束或仍有待补传桶',
  too_short: `时长不足 ${ELIGIBILITY.minDurationMs / 1000} 秒`,
  low_coverage: `AI 覆盖率低于 ${ELIGIBILITY.minCoverageRatio}`,
  insufficient_samples: '数字样本不足',
  clipped: '削波样本过多',
  quality_anomaly: '时钟/采样率/处理设置异常',
};

export interface Ratios { quietRatio: number; noisyRatio: number; interruptionRate: number }

export interface StudyPoint {
  view: StudySessionView;
  bucketRows: Row[];
  /**
   * 采集处理条件证据（TASK B §3）：来自既有 `sessions.processing`（不新增 DB 列）。
   *  · `undefined` → 旧路径（纯函数调用方未提供证据），保持既有行为；
   *  · `null`/空串 → 未报告 ⇒ 未知处理条件，不发布个人结论；
   *  · 非空串 → 规范化摘要（verified）或历史说明文本（legacy_reported）。
   */
  processing?: string | null;
}

export function ratiosOf(view: StudySessionView): Ratios | null {
  if (view.duration === null || view.duration <= 0) return null;
  const q = view.quietDuration;
  const n = view.noisyDuration;
  const i = view.interruptionCount;
  if (q === null || n === null || i === null) return null;
  return { quietRatio: q / view.duration, noisyRatio: n / view.duration, interruptionRate: i / (view.duration / 60) };
}

export interface Eligibility {
  eligible: boolean;
  reason: string | null;
  ratios: Ratios | null;
}

export function sessionEligibility(view: StudySessionView): Eligibility {
  const flags = view.qualityFlags ?? [];
  const fail = (reason: string): Eligibility => ({ eligible: false, reason, ratios: ratiosOf(view) });
  if (view.status === 'open') return fail('not_ended');
  if ((view.missingBucketCount ?? 0) > 0) return fail('not_ended');
  if (view.duration === null || view.duration * 1000 < ELIGIBILITY.minDurationMs) return fail('too_short');
  if (view.coverageRatio === null || view.coverageRatio < ELIGIBILITY.minCoverageRatio) return fail('low_coverage');
  const need = Math.floor(view.duration / 5) * ELIGIBILITY.minSampleFraction;
  if ((view.sampleCount ?? 0) < need) return fail('insufficient_samples');
  const clipped = view.sampleClippedCount ?? 0;
  if ((view.sampleCount ?? 0) > 0 && clipped / (view.sampleCount as number) > ELIGIBILITY.maxClippedRatio) return fail('clipped');
  if (flags.some((f) => ANOMALY_FLAGS.includes(f))) return fail('quality_anomaly');
  if (view.userFocusScore === null && view.userEfficiencyScore === null) return fail('not_ended');
  return { eligible: true, reason: null, ratios: ratiosOf(view) };
}

// ---------------------------------------------------------------------------
// 文案模板（§6.171–177）：限定语必须同时出现；禁止因果句式
// ---------------------------------------------------------------------------

export const REQUIRED_QUALIFIERS = ['在你的这些记录中', '样本量N', '仅为关联，不代表因果', '其他因素可能影响结果'] as const;

const NEGATIONS = ['不能', '不再', '无法', '不会', '并非', '不代表', '没有', '不足以', '不'];
const CAUSAL_VERBS = ['导致', '引起', '造成', '使得', '让'];

/**
 * 检出「因果断言」（而非否定式说明）。
 * §6.174 的 5–10 模板含「不能说明声音导致评分变化」——这是**否定**，不算违规。
 */
export function findCausalClaim(text: string): string | null {
  for (const verb of CAUSAL_VERBS) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(verb, from);
      if (at < 0) break;
      const before = text.slice(Math.max(0, at - 8), at);
      if (NEGATIONS.some((neg) => before.includes(neg))) {
        from = at + verb.length;
        continue;
      }
      return `${verb}（位置 ${at}）`;
    }
  }
  if (/因为[^。]{0,30}所以/.test(text)) return '因为…所以';
  if (/(效率|专注|分数)[^。]{0,6}(下降|降低|提升|提高|上升)[^。]{0,4}\d+\s*%/.test(text)) return '数值化效率涨跌';
  if (/换(个)?(座位|位置|空间)[^。]{0,6}(能|可以|会)[^。]{0,6}(提升|提高|改善)/.test(text)) return '空间承诺';
  if (/(噪声|声音|干扰)[^。]{0,8}(导致|造成|使得)[^。]{0,12}(下降|降低)/.test(text)) return '噪声致下降';
  return null;
}

export function assertNoCausalClaim(text: string): string {
  const hit = findCausalClaim(text);
  if (hit) throw new Error(`洞察文案出现因果断言：${hit}｜${text}`);
  return text;
}

export function assertQualifiers(text: string): string {
  const missing = REQUIRED_QUALIFIERS.filter((q) => !text.includes(q));
  if (missing.length) throw new Error(`洞察文案缺少限定语：${missing.join('、')}`);
  return text;
}

/**
 * TASK B §4：**全部**面向用户文本不得含因果断言。
 *
 * 只检查含中日韩字符的字符串（机器码如 VERSION_MIXED / OK、纯数字与日期不涉及措辞）。
 * 递归覆盖整个洞察分析对象，因此以后新增的任何中文说明都会自动纳入断言，不需要逐个登记。
 */
export function assertNoCausalClaimInTexts(value: unknown, path = 'analysis'): void {
  if (typeof value === 'string') {
    if (/[\u3400-\u9fff]/.test(value)) assertNoCausalClaim(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCausalClaimInTexts(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      assertNoCausalClaimInTexts(item, `${path}.${key}`);
    }
  }
}

export const template = {
  insufficient: (n: number): string =>
    `你有${n}次符合条件的记录。继续记录并完成专注、目标完成度自评后，再查看趋势。`,
  preliminary: (n: number, a: number | null, b: number | null): string =>
    `在这${n}次记录中，较安静组的专注自评中位数为${a === null ? '—' : a}/5，另一组为${b === null ? '—' : b}/5。` +
    `这是初步记录趋势，样本较少，不能说明声音导致评分变化。`,
  statistical: (args: { from: string; to: string; n: number; direction: '正' | '负' | '未见明显'; rho: number | null; label: string }): string =>
    assertQualifiers(
      `在你的这些记录中，${args.from}至${args.to}共${args.n}次有效记录（样本量N=${args.n}）：` +
      `${args.label}呈${args.direction}关联（Spearman rho=${args.rho === null ? '—' : args.rho.toFixed(3)}）。` +
      `这仅为关联，不代表因果；其他因素可能影响结果，任务难度、睡眠、时段和空间等都可能影响结果。`,
    ),
  noTrend: '当前没有稳定的记录趋势',
  /**
   * §4.2 保守模式：`versions.consistent=false` 时**不得**发布跨配置的个人关联与建议。
   * 这是待审技术模板（显示措辞仍需设计定稿），只陈述「为什么不给结论」。
   */
  mixedConfig: (n: number): string =>
    `你当前${n}次合格记录来自多种模型/预处理/映射配置。跨配置不能直接比较，` +
    `因此本次只保留明细与版本信息，不发布个人关联系数与建议；请按同一配置继续记录后再查看。`,
  /**
   * 增强 B §3：处理条件（采集条件）未报告或不一致 → 同样只给不足态。
   * 这是待审技术模板；只陈述「为什么不给结论」，不断言任何因果。
   */
  processingInsufficient: (n: number, detail: string): string =>
    `你当前${n}次合格记录的处理条件未报告或不一致（${detail}）。处理条件不同的记录不能直接比较，` +
    `因此本次只保留明细与处理条件信息，不发布个人关联系数与建议；请在同一采集条件下继续记录后再查看。`,
} as const;

// ---------------------------------------------------------------------------
// 处理条件证据（TASK B §3：按配置分组，并纳入真实 processing 证据）
//
// 现存字段：`sessions.processing`（NOT NULL，≤80 字符，`shared/model.ts` 禁改）。
//  · 规范化摘要（首版落点）：`qp-proc-v1;agc=on;ch=1;fs=48000;ns=off`，逐字段可核验；
//  · 旧文案（历史行/旧 harness）保持原样：同一分组内**文本完全相同**才算「已报告且一致」；
//  · 出现「未报告」标记或字段值 unknown → 该条件根本没被真实测量 ⇒ **未知处理条件**，
//    不得发布个人关联系数与建议（只给不足态）；
//  · 点未带该字段（纯函数调用方/旧路径）→ `not_supplied`，保持原路径，但生产读取路径
//    永远显式提供（见 study-store.buildInsights），因此 HTTP 出口不可能走这条路。
// ---------------------------------------------------------------------------

/** 规范化采集处理条件摘要的前缀。 */
export const PROCESSING_PROFILE_PREFIX = 'qp-proc-v1';
/** 规范化摘要允许出现的字段（未列入的键一律不视为 verified，防止未知键冒充证据）。 */
export const PROCESSING_PROFILE_FIELDS = ['fs', 'ch', 'agc', 'ns', 'ec'] as const;
/** 「未报告」标记：命中即视为该条件未被真实测量。 */
export const PROCESSING_UNREPORTED_MARKERS = ['未报告', '未上报', 'unknown', 'not reported', 'n/a'] as const;

export type ProcessingEvidence = 'not_supplied' | 'unknown' | 'verified' | 'legacy_reported';

export interface ProcessingProfile {
  evidence: ProcessingEvidence;
  /** 可比较用的规范化键：verified → 规范化 k=v 串；legacy_reported → 去空白后的原文；否则 null。 */
  profileKey: string | null;
  fields: Record<string, string>;
  /** 声明为 unknown 的字段（有任一字段未测量即不足以证实条件一致）。 */
  unreportedFields: string[];
  raw: string | null;
}

const PROCESSING_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const PROCESSING_VALUE_PATTERN = /^[A-Za-z0-9._+-]+$/;

/** 解析处理条件证据（纯函数，无 IO）。 */
export function parseProcessingProfile(raw: string | null | undefined): ProcessingProfile {
  const base = { fields: {} as Record<string, string>, unreportedFields: [] as string[], raw: null as string | null };
  if (raw === undefined) return { ...base, evidence: 'not_supplied', profileKey: null };
  if (raw === null) return { ...base, evidence: 'unknown', profileKey: null };
  const text = String(raw).replace(/\s+/g, ' ').trim();
  if (!text) return { ...base, evidence: 'unknown', profileKey: null };
  const parts = text.split(';').map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1 && parts[0] === PROCESSING_PROFILE_PREFIX) {
    const fields: Record<string, string> = {};
    const unreported: string[] = [];
    let valid = true;
    for (const part of parts.slice(1)) {
      const eq = part.indexOf('=');
      if (eq <= 0) { valid = false; break; }
      const key = part.slice(0, eq);
      const value = part.slice(eq + 1);
      if (!PROCESSING_KEY_PATTERN.test(key) || !PROCESSING_VALUE_PATTERN.test(value)) { valid = false; break; }
      if (!(PROCESSING_PROFILE_FIELDS as readonly string[]).includes(key)) { valid = false; break; }
      if (fields[key] !== undefined) { valid = false; break; }
      fields[key] = value;
      const lower = value.toLowerCase();
      if (PROCESSING_UNREPORTED_MARKERS.some((m) => lower.includes(m.toLowerCase()))) unreported.push(key);
    }
    if (valid) {
      const profileKey = `${PROCESSING_PROFILE_PREFIX};${Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join(';')}`;
      // 任一必需字段声明为未测量 → 无法证实条件一致 → 归入 unknown（不发布个人结论）。
      if (unreported.length > 0) {
        return { evidence: 'unknown', profileKey: null, fields, unreportedFields: unreported, raw: text };
      }
      return { evidence: 'verified', profileKey, fields, unreportedFields: [], raw: text };
    }
  }
  if (PROCESSING_UNREPORTED_MARKERS.some((m) => text.includes(m))) {
    return { evidence: 'unknown', profileKey: null, fields: {}, unreportedFields: [], raw: text };
  }
  // 声明了规范化前缀却解析失败（未知键/重复键/语法错误）：损坏的摘要不可信，不得降级当历史文本用。
  if (parts[0] === PROCESSING_PROFILE_PREFIX) {
    return { evidence: 'unknown', profileKey: null, fields: {}, unreportedFields: [], raw: text };
  }
  return { evidence: 'legacy_reported', profileKey: text, fields: {}, unreportedFields: [], raw: text };
}

export type ProcessingState = ProcessingEvidence | 'mixed';

export interface ProcessingEvidenceSummary {
  state: ProcessingState;
  /** 处理条件是否可比较（not_supplied = 旧路径；verified/legacy_reported = 已证实一致）。 */
  comparable: boolean;
  /** 每个观测到的处理条件的出现次数（按证据种类分开计数，便于解释）。 */
  profiles: { evidence: ProcessingEvidence; profileKey: string | null; count: number }[];
  note: string;
}

const PROCESSING_NOTES: Record<ProcessingState, string> = {
  not_supplied: '本次分析未提供处理条件证据（旧路径），不因该项额外拦截',
  verified: '本组处理条件来自同一份规范化采集条件摘要，可比较',
  legacy_reported: '本组处理条件为同一份历史采集说明文本，未发现「未报告」标记',
  unknown: '本组处理条件未报告或不完整（缺失/未测量），不能证实一致，不发布个人结论',
  mixed: '本组包含多种未证实一致的处理条件，不能证实一致，不发布个人结论',
};

/** 汇总一组记录的处理条件证据（纯函数）。 */
export function summarizeProcessing(points: readonly StudyPoint[]): ProcessingEvidenceSummary {
  const parsed = points.map((p) => parseProcessingProfile(p.processing));
  const counts = new Map<string, { evidence: ProcessingEvidence; profileKey: string | null; count: number }>();
  for (const item of parsed) {
    const key = `${item.evidence}|${item.profileKey ?? ''}`;
    const seen = counts.get(key);
    if (seen) seen.count += 1;
    else counts.set(key, { evidence: item.evidence, profileKey: item.profileKey, count: 1 });
  }
  const profiles = [...counts.values()];
  const anyUnknown = parsed.some((p) => p.evidence === 'unknown');
  const supplied = parsed.filter((p) => p.evidence !== 'not_supplied');
  let state: ProcessingState;
  if (points.length === 0 || supplied.length === 0) {
    state = anyUnknown ? 'unknown' : 'not_supplied';
  } else if (anyUnknown) {
    state = 'unknown';
  } else if (supplied.length !== parsed.length || counts.size > 1) {
    state = 'mixed';
  } else {
    state = supplied[0].evidence;
  }
  return {
    state,
    comparable: state === 'not_supplied' || state === 'verified' || state === 'legacy_reported',
    profiles: profiles.sort((a, b) => b.count - a.count),
    note: PROCESSING_NOTES[state],
  };
}

export function directionOf(rho: number | null): '正' | '负' | '未见明显' {
  if (rho === null || rho === 0) return '未见明显';
  return rho > 0 ? '正' : '负';
}

// ---------------------------------------------------------------------------
// 分析主体
// ---------------------------------------------------------------------------

export interface StudyPointRatios extends Ratios { point: StudyPoint; view: StudySessionView }

export interface PairDef { id: string; label: string; x: 'quietRatio' | 'noisyRatio' | 'interruptionRate'; y: 'userFocusScore' | 'userEfficiencyScore' }

export const PAIRS: readonly PairDef[] = [
  { id: 'quietRatio-focus', label: '安静占比与专注自评', x: 'quietRatio', y: 'userFocusScore' },
  { id: 'noisyRatio-focus', label: '声级较高时长占比与专注自评', x: 'noisyRatio', y: 'userFocusScore' },
  { id: 'interruptionRate-focus', label: '疑似干扰片段频率与专注自评', x: 'interruptionRate', y: 'userFocusScore' },
  { id: 'noisyRatio-efficiency', label: '声级较高时长占比与目标完成度自评', x: 'noisyRatio', y: 'userEfficiencyScore' },
] as const;

interface GroupStats {
  N: number;
  medianFocus: number | null;
  medianEfficiency: number | null;
  medianRatio: number | null;
  /** 该组自评非 null 的真实条数（缺评分不得用组总 N 撑过门槛）。 */
  focusN: number;
  efficiencyN: number;
  dates: number;
  /** 与 dates 同义，§9 step 9 要求的显式字段名。 */
  distinctDays: number;
  from: number | null;
  to: number | null;
  fromDate: string | null;
  toDate: string | null;
}

function groupStats(rows: StudyPointRatios[], ratioKey: 'quietRatio' | 'noisyRatio', zone: string): GroupStats {
  const focus = rows.map((r) => r.view.userFocusScore).filter((v): v is number => v !== null);
  const eff = rows.map((r) => r.view.userEfficiencyScore).filter((v): v is number => v !== null);
  const ratios = rows.map((r) => r[ratioKey]);
  // §9 step 9：日期必须按选定本地时区求，不能用 UTC substring（UTC 与本地日会错位）。
  const days = new Set(rows.map((r) => zoneDateString(r.view.startTime, zone)));
  const times = rows.map((r) => r.view.startTime);
  const from = times.length ? Math.min(...times) : null;
  const to = times.length ? Math.max(...times) : null;
  return {
    N: rows.length,
    medianFocus: median(focus),
    medianEfficiency: median(eff),
    medianRatio: median(ratios),
    focusN: focus.length,
    efficiencyN: eff.length,
    dates: days.size,
    distinctDays: days.size,
    from,
    to,
    fromDate: from === null ? null : zoneDateString(from, zone),
    toDate: to === null ? null : zoneDateString(to, zone),
  };
}

export interface AnalysisInput {
  now: number;
  zone: string;
  windowStart: number;
}

/** 关联对不可发布的原因码（机器可读；说明文本另给）。 */
export type CorrelationStatus =
  | SpearmanStatus
  | 'TIER_INSUFFICIENT'
  | 'TIER_PRELIMINARY'
  | 'VERSION_MIXED'
  | 'MODEL_MIXED'
  | 'PROCESSING_UNKNOWN'
  | 'PROCESSING_MIXED';

export interface CorrelationOut {
  pairId: string;
  label: string;
  x: string;
  y: string;
  N: number;
  /** 该对配对记录中「该评分非 null」的真实条数（与 N 同源，显式暴露防误用）。 */
  focusN: number;
  efficiencyN: number;
  /** 该对配对记录涉及的本地日期数（§9：跨 ≥3 本地日期是通用建议门槛之一）。 */
  distinctDays: number;
  rho: number | null;
  /** §4.2：跨配置时固定为 VERSION_MIXED —— 服务端不给出可比较的池化系数。 */
  status: CorrelationStatus;
  /** rho 为 null 时的明确原因（可解释，不静默）。 */
  reason: string | null;
  pairTier: Tier;
  from: string | null;
  to: string | null;
}

export function correlationReasonFor(status: CorrelationStatus): string | null {
  switch (status) {
    case 'OK': return null;
    case 'NO_VARIATION': return '变量或评分变化不足，暂不能计算关联';
    case 'NO_PAIR': return '可用配对记录不足 2 条';
    case 'TIER_INSUFFICIENT': return `每对有效记录不足 ${TIER_PRELIMINARY_MIN} 次，仅给有效次数与继续记录指导`;
    case 'TIER_PRELIMINARY': return `每对有效记录 ${TIER_PRELIMINARY_MIN}–${TIER_STATISTICAL_MIN - 1} 次，只给初步分组与中位数，不给系数`;
    case 'VERSION_MIXED': return '存在多种模型/预处理/映射/决策版本，跨配置不能合并计算';
    case 'MODEL_MIXED': return '同一分组内出现多个模型哈希，无法证实为同一模型';
    case 'PROCESSING_UNKNOWN': return '采集处理条件未报告或不完整，无法证实一致，不发布个人结论';
    case 'PROCESSING_MIXED': return '同一分组内出现多种采集处理条件，无法证实一致，不发布个人结论';
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// 按配置分组（TASK B §1：先按 (preprocessVersion, runtimeVersion, mapVersion,
// decisionVersion) 分组，再在组内做处理条件/质量/样本量门禁；不得用池化结果替代）
// ---------------------------------------------------------------------------

/** 配置分组键（§9 TASK B：四项版本；modelHash 单独作为组内证据）。 */
export interface ConfigurationVersions {
  preprocessVersion: string;
  runtimeVersion: string;
  mapVersion: string;
  decisionVersion: string;
}

/** 分组用的四个版本维度（顺序固定，报告与测试都按此顺序）。 */
export const CONFIGURATION_DIMENSIONS = ['preprocessVersion', 'runtimeVersion', 'mapVersion', 'decisionVersion'] as const;

export function configurationKeyOf(view: Pick<StudySessionView, 'preprocessVersion' | 'runtimeVersion' | 'mapVersion' | 'decisionVersion'>): string {
  return CONFIGURATION_DIMENSIONS.map((dim) => String(view[dim])).join('|');
}

export interface RuleGateCheck { id: string; passed: boolean; actual: number | string | null; required: string }

export interface RuleGateOut {
  ruleId: string;
  /** 规则检测数学（原有门槛）是否触发；未触发时给出检查项的真实值。 */
  detected: boolean;
  /** 通用发布门槛 + 规则门槛是否全部通过（通过才可能进入 suggestions）。 */
  publishable: boolean;
  reason: string | null;
  checks: RuleGateCheck[];
}

interface RuleCandidate { text: string; evidence: Record<string, unknown> }
interface RuleEvaluation { gate: RuleGateOut; candidate: RuleCandidate | null }

export interface ConfigurationStat {
  key: string;
  versions: ConfigurationVersions;
  /** 组内出现的模型哈希（>1 即不可比较，不冒充同一模型）。 */
  modelHash: string[];
  N: number;
  focusN: number;
  efficiencyN: number;
  tier: Tier;
  distinctDays: number;
  fromDate: string | null;
  toDate: string | null;
  rooms: { roomId: string; N: number }[];
  /** 该配置分组在窗口内的全部记录（含被剔除的）出现的质量标记。 */
  qualityFlags: { flag: string; count: number }[];
  qualityFlaggedN: number;
  /** 该配置分组被「质量/削波」类原因剔除的逐条计数（质量不足的显式证据）。 */
  qualityExcluded: { reason: string; count: number }[];
  processing: ProcessingEvidenceSummary;
  comparable: boolean;
  comparableReason: string | null;
  comparableNote: string;
  correlations: CorrelationOut[];
  groups: { quiet: { high: GroupStats; low: GroupStats; middle: GroupStats }; noisy: { high: GroupStats; low: GroupStats; middle: GroupStats } };
  suggestionGates: RuleGateOut[];
}

function qualityFlagSummary(views: StudySessionView[]): { qualityFlags: { flag: string; count: number }[]; qualityFlaggedN: number } {
  const counts = new Map<string, number>();
  let flagged = 0;
  for (const view of views) {
    const flags = view.qualityFlags ?? [];
    if (flags.length > 0) flagged += 1;
    for (const flag of flags) counts.set(flag, (counts.get(flag) ?? 0) + 1);
  }
  return {
    qualityFlags: [...counts.entries()].map(([flag, count]) => ({ flag, count })).sort((a, b) => b.count - a.count),
    qualityFlaggedN: flagged,
  };
}

/** 参与统计的记录里带质量异常标记的条数（入选门槛已剔除；发布门槛再显式断言一次）。 */
function flaggedRowsOf(rows: StudyPointRatios[]): number {
  return rows.filter((r) => (r.view.qualityFlags ?? []).some((flag) => ANOMALY_FLAGS.includes(flag))).length;
}

interface EvaluatedPoint { point: StudyPoint; view: StudySessionView; eligibility: Eligibility }

function correlationsFor(
  rows: StudyPointRatios[],
  zone: string,
  publishBlock: CorrelationStatus | null,
  qualityFlags: { flag: string; count: number }[],
): CorrelationOut[] {
  return PAIRS.map((pair) => {
    const xs: number[] = [];
    const ys: number[] = [];
    let from = Number.POSITIVE_INFINITY;
    let to = 0;
    const days = new Set<string>();
    for (const e of rows) {
      const y = e.view[pair.y];
      if (y === null) continue;
      xs.push(e[pair.x]);
      ys.push(y);
      days.add(zoneDateString(e.view.startTime, zone));
      from = Math.min(from, e.view.startTime);
      to = Math.max(to, e.view.startTime);
    }
    // §9 step 9：评分 N 必须与「自己的非 null 评分」配对，缺评分不得用别的 N 撑过去。
    // 这里给的是**该合格集合**里两种自评的真实非 null 条数（对照每对 N，一眼看出是哪一侧缺评分）。
    const focusN = rows.filter((e) => e.view.userFocusScore !== null).length;
    const efficiencyN = rows.filter((e) => e.view.userEfficiencyScore !== null).length;
    // §6.163：阈值按「每对变量的有效 N」分别判定，不用总会话数掩盖缺失自评。
    const pairTier = tierFor(xs.length);
    const base = {
      pairId: pair.id,
      label: pair.label,
      x: pair.x,
      y: pair.y,
      N: xs.length,
      focusN,
      efficiencyN,
      distinctDays: days.size,
      qualityFlags,
      pairTier,
      from: xs.length ? zoneDateString(from, zone) : null,
      to: xs.length ? zoneDateString(to, zone) : null,
    };
    if (publishBlock !== null) {
      // §4.2 / §9.3：配置或处理条件不可比时**服务端**就不发布系数；N/日期/分档仍如实返回。
      return { ...base, rho: null, status: publishBlock, reason: correlationReasonFor(publishBlock) };
    }
    if (pairTier !== 'statistical') {
      const status: CorrelationStatus = pairTier === 'preliminary' ? 'TIER_PRELIMINARY' : 'TIER_INSUFFICIENT';
      return { ...base, rho: null, status, reason: correlationReasonFor(status) };
    }
    const result = spearman(xs, ys);
    return { ...base, rho: result.rho, status: result.status, reason: correlationReasonFor(result.status) };
  });
}

// ---------------------------------------------------------------------------
// 三条建议的通用发布门槛（TASK B §3：每条规则各自引用这些门槛，不得只加一个全局布尔）
// ---------------------------------------------------------------------------

export const SUGGESTION_GATE_CHECKS = {
  comparable: 'config-comparable',
  qualityEligible: 'quality-eligible',
  pairN: 'pair-n',
  rhoMagnitude: 'rho-magnitude',
  groupScoreN: 'group-score-n',
  distinctDays: 'distinct-days',
  medianDelta: 'median-delta',
  signConsistent: 'sign-consistent',
  slotCount: 'slot-count',
  totalScoreN: 'total-score-n',
  badSoundSessions: 'bad-sound-sessions',
} as const;

interface CommonGateInput {
  comparable: boolean;
  comparableReason: string | null;
  /** 参与统计的合格记录中带质量异常标记的条数（入选门槛已剔除；此处显式再断言一次）。 */
  flaggedRows: number;
  pair: CorrelationOut | null;
  high: GroupStats;
  low: GroupStats;
  score: 'focus' | 'efficiency';
  requireRho: boolean;
}

function commonGateChecks(input: CommonGateInput): { checks: RuleGateCheck[]; passed: boolean; reason: string | null } {
  const checks: RuleGateCheck[] = [];
  const push = (id: string, passed: boolean, actual: number | string | null, required: string): void => {
    checks.push({ id, passed, actual, required });
  };
  push(
    SUGGESTION_GATE_CHECKS.comparable,
    input.comparable,
    input.comparable ? 'comparable' : (input.comparableReason ?? 'not-comparable'),
    '配置与处理条件可比较',
  );
  // 质量不足（时钟/采样率/处理设置异常、削波等）一律先被入选门槛剔除；
  // 这里把「质量门槛」显式并入每条规则的发布门槛，任何一条带异常标记的记录进入统计都不得发布。
  push(
    SUGGESTION_GATE_CHECKS.qualityEligible,
    input.flaggedRows === 0,
    input.flaggedRows,
    '参与统计的记录无质量异常（不足者已在入选门槛剔除）',
  );
  const highN = input.score === 'focus' ? input.high.focusN : input.high.efficiencyN;
  const lowN = input.score === 'focus' ? input.low.focusN : input.low.efficiencyN;
  if (input.pair) {
    push(SUGGESTION_GATE_CHECKS.pairN, input.pair.N >= SUGGESTION_GATES.minTotalN, input.pair.N, `≥${SUGGESTION_GATES.minTotalN}`);
    if (input.requireRho) {
      const rho = input.pair.rho;
      push(
        SUGGESTION_GATE_CHECKS.rhoMagnitude,
        input.pair.status === 'OK' && rho !== null && Number.isFinite(rho) && Math.abs(rho) >= SUGGESTION_GATES.minAbsRho,
        rho === null ? null : Math.abs(rho) >= SUGGESTION_GATES.minAbsRho ? Number(rho.toFixed(6)) : Number(Math.abs(rho).toFixed(6)),
        `status=OK 且 |rho|≥${SUGGESTION_GATES.minAbsRho}`,
      );
    }
  }
  push(SUGGESTION_GATE_CHECKS.groupScoreN, highN >= SUGGESTION_GATES.minPerGroup, highN, `较高组该评分 N≥${SUGGESTION_GATES.minPerGroup}`);
  push(SUGGESTION_GATE_CHECKS.groupScoreN, lowN >= SUGGESTION_GATES.minPerGroup, lowN, `较低组该评分 N≥${SUGGESTION_GATES.minPerGroup}`);
  const days = input.high.distinctDays < input.low.distinctDays ? input.high.distinctDays : input.low.distinctDays;
  push(SUGGESTION_GATE_CHECKS.distinctDays, days >= SUGGESTION_GATES.minDistinctDays, days, `每组跨 ≥${SUGGESTION_GATES.minDistinctDays} 个本地日`);
  const medianDelta = input.high.medianFocus !== null && input.low.medianFocus !== null
    ? (input.score === 'focus' ? input.high.medianFocus - input.low.medianFocus : (input.high.medianEfficiency as number) - (input.low.medianEfficiency as number))
    : null;
  push(
    SUGGESTION_GATE_CHECKS.medianDelta,
    medianDelta !== null && Math.abs(medianDelta) >= SUGGESTION_GATES.minMedianDelta,
    medianDelta,
    `两侧该评分中位数差 ≥${SUGGESTION_GATES.minMedianDelta} 且方向一致`,
  );
  if (input.requireRho && input.pair) {
    const rho = input.pair.rho;
    push(
      SUGGESTION_GATE_CHECKS.signConsistent,
      rho !== null && medianDelta !== null && Math.sign(rho) === Math.sign(medianDelta),
      medianDelta === null || rho === null ? null : `${rho > 0 ? '+' : '-'}/${medianDelta > 0 ? '+' : '-'}`,
      '系数符号与中位数差方向一致',
    );
  }
  const failed = checks.find((c) => !c.passed);
  return {
    checks,
    passed: failed === undefined,
    reason: failed === undefined ? null : `${failed.id}：${failed.required}（实际 ${String(failed.actual)}）`,
  };
}

export interface RuleScope {
  comparable: boolean;
  comparableReason: string | null;
  /** 池化/分组是否允许产出**个人**建议：跨配置时整体关闭（§4.2）。 */
  suggestionsAllowed: boolean;
  zone: string;
  rows: StudyPointRatios[];
  /** rows 中带质量异常标记的条数（入选门槛已剔除；发布门槛再断言一次）。 */
  flaggedRows: number;
  correlations: CorrelationOut[];
  groups: { quiet: { high: GroupStats; low: GroupStats }; noisy: { high: GroupStats; low: GroupStats } };
  /** conversation+ring 累计 ≥60 秒的合格会话数（规则2 的类别证据）。 */
  withBadSoundN: number;
  strata: { roomId: string; N: number }[];
}

export function evaluateRuleGates(scope: RuleScope): { gates: RuleGateOut[]; candidates: (RuleCandidate | null)[] } {
  const gates: RuleGateOut[] = [];
  const candidates: (RuleCandidate | null)[] = [];
  const pairOf = (id: string): CorrelationOut | null => scope.correlations.find((c) => c.pairId === id) ?? null;

  // 规则 1：安静占比–专注（§6.181 + TASK B §10）
  const quietPair = pairOf('quietRatio-focus');
  const quietHigh = scope.groups.quiet.high;
  const quietLow = scope.groups.quiet.low;
  const quietDetected = quietPair !== null && quietPair.pairTier === 'statistical' && quietPair.rho !== null &&
    Math.abs(quietPair.rho) >= SUGGESTION_GATES.minAbsRho &&
    quietPair.N >= SUGGESTION_GATES.minTotalN;
  const quietCommon = commonGateChecks({
    comparable: scope.comparable,
    comparableReason: scope.comparableReason,
    flaggedRows: scope.flaggedRows,
    pair: quietPair,
    high: quietHigh,
    low: quietLow,
    score: 'focus',
    requireRho: true,
  });
  const quietPublishable = scope.suggestionsAllowed && quietDetected && quietCommon.passed;
  gates.push({
    ruleId: 'quiet-ratio-focus',
    detected: quietDetected,
    publishable: quietPublishable,
    reason: quietPublishable
      ? null
      : (!scope.suggestionsAllowed ? 'CROSS_CONFIG：跨配置/不可比时服务端不发布个人建议' : quietCommon.reason),
    checks: quietCommon.checks,
  });
  candidates.push(quietPublishable && quietPair !== null && quietPair.rho !== null && quietHigh.medianFocus !== null && quietLow.medianFocus !== null
    ? {
      text: assertQualifiers(assertNoCausalClaim(
        `在你的这些记录中，安静占比与专注自评呈${directionOf(quietPair.rho)}关联（Spearman rho=${quietPair.rho.toFixed(3)}，样本量N=${quietPair.N}）。` +
        // §6.181：必须列出两组中位数与日期范围，并明确「不承诺提升」。
        `较安静组专注自评中位数 ${quietHigh.medianFocus}/5（N=${quietHigh.focusN}），较少安静组中位数 ${quietLow.medianFocus}/5（N=${quietLow.focusN}），日期范围 ${quietPair.from} 至 ${quietPair.to}。` +
        `在下一次相近任务中，尝试选择你记录中较安静的时段/位置，并继续自评比较；不承诺提升。这仅为关联，不代表因果，其他因素可能影响结果。`,
      )),
      evidence: {
        N: quietPair.N,
        rho: quietPair.rho,
        highN: quietHigh.N,
        lowN: quietLow.N,
        highFocusN: quietHigh.focusN,
        lowFocusN: quietLow.focusN,
        highMedianFocus: quietHigh.medianFocus,
        lowMedianFocus: quietLow.medianFocus,
        medianDelta: quietHigh.medianFocus - quietLow.medianFocus,
        from: quietPair.from,
        to: quietPair.to,
        dates: quietPair.distinctDays,
      },
    }
    : null);

  // 规则 2：交谈/铃声累计 ≥60s 且 ≥3 个合格会话出现；桶只保留总量 → 只能说「同段出现」（§6.182 + TASK B §11）
  const noisyPair = pairOf('noisyRatio-focus');
  const noisyHigh = scope.groups.noisy.high;
  const noisyLow = scope.groups.noisy.low;
  const noisyDetected = scope.withBadSoundN >= SUGGESTION_GATES.minPerGroup && noisyPair !== null &&
    noisyPair.pairTier === 'statistical' && noisyPair.rho !== null && Math.abs(noisyPair.rho) >= SUGGESTION_GATES.minAbsRho;
  const noisyCommon = commonGateChecks({
    comparable: scope.comparable,
    comparableReason: scope.comparableReason,
    flaggedRows: scope.flaggedRows,
    pair: noisyPair,
    high: noisyHigh,
    low: noisyLow,
    score: 'focus',
    requireRho: true,
  });
  noisyCommon.checks.unshift({
    id: SUGGESTION_GATE_CHECKS.badSoundSessions,
    passed: scope.withBadSoundN >= SUGGESTION_GATES.minPerGroup,
    actual: scope.withBadSoundN,
    required: `同类片段合计 ≥60 秒的会话数 ≥${SUGGESTION_GATES.minPerGroup}`,
  });
  const noisyFailed = noisyCommon.checks.find((c) => !c.passed);
  const noisyPublishable = scope.suggestionsAllowed && noisyDetected && noisyCommon.passed;
  gates.push({
    ruleId: 'noisy-events-focus',
    detected: noisyDetected,
    publishable: noisyPublishable,
    reason: noisyPublishable
      ? null
      : (!scope.suggestionsAllowed ? 'CROSS_CONFIG：跨配置/不可比时服务端不发布个人建议' : (noisyFailed ? `${noisyFailed.id}：${noisyFailed.required}（实际 ${String(noisyFailed.actual)}）` : null)),
    checks: noisyCommon.checks,
  });
  candidates.push(noisyPublishable && noisyPair !== null && noisyPair.rho !== null
    ? {
      text: assertQualifiers(assertNoCausalClaim(
        `在你的这些记录中，声级较高时长占比与专注自评呈${directionOf(noisyPair.rho)}关联（Spearman rho=${noisyPair.rho.toFixed(3)}，样本量N=${noisyPair.N}）。` +
        `可尝试讨论区/调整手机铃声设置后继续记录；交谈与铃声类合计已超过 60 秒的会话共 ${scope.withBadSoundN} 次，它们与声级上升时段同段出现（桶只保留总量，未计算逐类交集）。` +
        `这仅为关联，不代表因果，其他因素可能影响结果。`,
      )),
      evidence: {
        N: noisyPair.N,
        rho: noisyPair.rho,
        sessionsWithBadSound: scope.withBadSoundN,
        overlapScope: 'same-session',
        highN: noisyHigh.N,
        lowN: noisyLow.N,
        highFocusN: noisyHigh.focusN,
        lowFocusN: noisyLow.focusN,
        highMedianFocus: noisyHigh.medianFocus,
        lowMedianFocus: noisyLow.medianFocus,
        from: noisyPair.from,
        to: noisyPair.to,
        dates: noisyPair.distinctDays,
      },
    }
    : null);

  // 规则 3：同一空间两种时段各 ≥3 次、跨 ≥3 天、总 N ≥11（§6.183 + TASK B §12；不依赖 rho，必须显式受总开关约束）
  const slotChecks: RuleGateCheck[] = [];
  const slots: { slot: string; N: number; focusN: number; medianFocus: number | null; dates: number }[] = [];
  let roomId: string | null = scope.strata[0]?.roomId ?? null;
  let slotsComparable = false;
  let slotTotalN = 0;
  let slotDelta: number | null = null;
  const slotComparableCheck: RuleGateCheck = {
    id: SUGGESTION_GATE_CHECKS.comparable,
    passed: scope.comparable,
    actual: scope.comparable ? 'comparable' : (scope.comparableReason ?? 'not-comparable'),
    required: '配置与处理条件可比较',
  };
  for (const stratum of scope.strata) {
    const rows = scope.rows.filter((r) => r.view.roomId === stratum.roomId);
    const bySlot = new Map<string, StudyPointRatios[]>();
    for (const r of rows) {
      const hour = localParts(r.view.startTime, scope.zone).hour;
      const slotName = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
      const list = bySlot.get(slotName) ?? [];
      list.push(r);
      bySlot.set(slotName, list);
    }
    const usable = [...bySlot.entries()].map(([slot, list]) => {
      const focus = list.map((r) => r.view.userFocusScore).filter((v): v is number => v !== null);
      return {
        slot,
        N: list.length,
        focusN: focus.length,
        medianFocus: median(focus),
        dates: new Set(list.map((r) => zoneDateString(r.view.startTime, scope.zone))).size,
      };
    }).filter((s) => s.focusN >= SUGGESTION_GATES.minPerGroup && s.medianFocus !== null && s.dates >= SUGGESTION_GATES.minDistinctDays);
    if (usable.length >= 2) {
      const sorted = [...usable].sort((a, b) => (a.medianFocus as number) - (b.medianFocus as number));
      slotsComparable = true;
      slots.push(...usable);
      slotTotalN = usable.reduce((sum, s) => sum + s.focusN, 0);
      slotDelta = (sorted[sorted.length - 1].medianFocus as number) - (sorted[0].medianFocus as number);
      roomId = stratum.roomId;
    }
  }
  const slotFocusTotal = scope.rows.filter((r) => r.view.userFocusScore !== null).length;
  slotChecks.push(slotComparableCheck);
  slotChecks.push({
    id: SUGGESTION_GATE_CHECKS.qualityEligible,
    passed: scope.flaggedRows === 0,
    actual: scope.flaggedRows,
    required: '参与统计的记录无质量异常（不足者已在入选门槛剔除）',
  });
  slotChecks.push({ id: SUGGESTION_GATE_CHECKS.slotCount, passed: slotsComparable, actual: slots.length, required: '至少两个时段各有足够的该评分记录与日期' });
  slotChecks.push({ id: SUGGESTION_GATE_CHECKS.totalScoreN, passed: slotFocusTotal >= SUGGESTION_GATES.minTotalN, actual: slotFocusTotal, required: `该空间总评分 N≥${SUGGESTION_GATES.minTotalN}` });
  slotChecks.push({
    id: SUGGESTION_GATE_CHECKS.medianDelta,
    passed: slotDelta !== null && Math.abs(slotDelta) >= SUGGESTION_GATES.minMedianDelta,
    actual: slotDelta,
    required: `最差/最好时段该评分中位数差 ≥${SUGGESTION_GATES.minMedianDelta}`,
  });
  const slotDetected = slotsComparable;
  const slotFailed = slotChecks.find((c) => !c.passed);
  const slotPublishable = scope.suggestionsAllowed && slotDetected && slotFailed === undefined;
  gates.push({
    ruleId: 'room-time-slot',
    detected: slotDetected,
    publishable: slotPublishable,
    reason: slotPublishable
      ? null
      : (!scope.suggestionsAllowed ? 'CROSS_CONFIG：跨配置/不可比时服务端不发布个人建议' : (slotFailed ? `${slotFailed.id}：${slotFailed.required}（实际 ${String(slotFailed.actual)}）` : null)),
    checks: slotChecks,
  });
  const sortedSlots = [...slots].sort((a, b) => (a.medianFocus as number) - (b.medianFocus as number));
  candidates.push(slotPublishable && roomId !== null && sortedSlots.length >= 2
    ? {
      text: assertQualifiers(assertNoCausalClaim(
        `在你的这些记录中，${roomId} 的「${sortedSlots[0].slot}」时段专注自评中位数较低（样本量N=${sortedSlots[0].focusN}，中位数 ${sortedSlots[0].medianFocus}/5）。` +
        `可尝试继续对照该时段与其他时段，不保证该空间任何时段都安静。这仅为关联，不代表因果，其他因素可能影响结果。`,
      )),
      evidence: { roomId, slots, totalN: slotTotalN, focusTotalN: slotFocusTotal, medianDelta: slotDelta },
    }
    : null);

  return { gates, candidates };
}

export function buildAnalysis(points: StudyPoint[], input: AnalysisInput): Record<string, unknown> {
  // §7/§5：时区必须先校验 —— 未知 IANA 时区一律 VALIDATION_FAILED，
  // 不得因「无数据点」而静默跳过校验、更不得回退到 UTC。
  resolveZone(input.zone);
  const evaluated: EvaluatedPoint[] = points.map((point) => ({ point, view: point.view, eligibility: sessionEligibility(point.view) }));
  const exclusions = new Map<string, number>();
  for (const e of evaluated) {
    if (!e.eligibility.eligible) {
      const key = e.eligibility.reason ?? 'not_ended';
      exclusions.set(key, (exclusions.get(key) ?? 0) + 1);
    }
  }
  const eligible = evaluated.filter((e) => e.eligibility.eligible && e.eligibility.ratios)
    .map((e) => ({ ...(e.eligibility.ratios as Ratios), point: e.point, view: e.view })) as StudyPointRatios[];
  const eligibleN = eligible.length;
  const tier = tierFor(eligibleN);

  const windowN = eligible.length;
  const windowTier = tier;
  // §4.2 / §0#4：先判定配置一致性。跨配置（含混模型/映射/预处理/决策/runtime）时
  // **服务端**就不再发布池化 rho 与个人建议——前端遮罩不能代替服务端修复。
  const versions = {
    modelHash: [...new Set(eligible.map((e) => e.view.modelHash))],
    runtimeVersion: [...new Set(eligible.map((e) => e.view.runtimeVersion))],
    preprocessVersion: [...new Set(eligible.map((e) => e.view.preprocessVersion))],
    mapVersion: [...new Set(eligible.map((e) => e.view.mapVersion))],
    decisionVersion: [...new Set(eligible.map((e) => e.view.decisionVersion))],
    consistent: false,
    note: '',
  };
  versions.consistent = versions.modelHash.length <= 1 && versions.mapVersion.length <= 1 &&
    versions.preprocessVersion.length <= 1 && versions.decisionVersion.length <= 1 && versions.runtimeVersion.length <= 1;
  versions.note = versions.consistent ? '配置一致，可直接比较' : '存在多种模型/映射/预处理配置，跨配置不能直接比较';

  // ---------------------------------------------------------------
  // 按 (preprocessVersion, runtimeVersion, mapVersion, decisionVersion) 分组
  // ---------------------------------------------------------------
  const buckets = new Map<string, { versions: ConfigurationVersions; rows: StudyPointRatios[]; allViews: StudySessionView[] }>();
  for (const e of eligible) {
    const key = configurationKeyOf(e.view);
    const bucket = buckets.get(key) ?? {
      versions: {
        preprocessVersion: e.view.preprocessVersion,
        runtimeVersion: e.view.runtimeVersion,
        mapVersion: e.view.mapVersion,
        decisionVersion: e.view.decisionVersion,
      },
      rows: [],
      allViews: [],
    };
    bucket.rows.push(e);
    buckets.set(key, bucket);
  }
  for (const e of evaluated) {
    const bucket = buckets.get(configurationKeyOf(e.view));
    if (bucket) bucket.allViews.push(e.view);
  }

  const badBuckets = (point: StudyPoint): { conversationMs: number; ringMs: number } => {
    let conversation = 0;
    let ring = 0;
    for (const b of point.bucketRows) {
      let cats: Record<string, number> = {};
      try {
        cats = JSON.parse(String(b.categoryMs)) as Record<string, number>;
      } catch {
        cats = {};
      }
      conversation += Number(cats.conversation ?? 0);
      ring += Number(cats.ring ?? 0);
    }
    return { conversationMs: conversation, ringMs: ring };
  };

  const groupsFor = (rows: StudyPointRatios[], ratioKey: 'quietRatio' | 'noisyRatio') => {
    const hi = rows.filter((e) => e[ratioKey] >= (ratioKey === 'quietRatio' ? GROUP_THRESHOLDS.quietHigh : GROUP_THRESHOLDS.noisyHigh));
    const lo = rows.filter((e) => e[ratioKey] <= (ratioKey === 'quietRatio' ? GROUP_THRESHOLDS.quietLow : GROUP_THRESHOLDS.noisyLow));
    const mid = rows.filter((e) => e[ratioKey] < (ratioKey === 'quietRatio' ? GROUP_THRESHOLDS.quietHigh : GROUP_THRESHOLDS.noisyHigh) &&
      e[ratioKey] > (ratioKey === 'quietRatio' ? GROUP_THRESHOLDS.quietLow : GROUP_THRESHOLDS.noisyLow));
    return { high: groupStats(hi, ratioKey, input.zone), low: groupStats(lo, ratioKey, input.zone), middle: groupStats(mid, ratioKey, input.zone) };
  };

  const configurations: ConfigurationStat[] = [];
  for (const [key, bucket] of buckets) {
    const modelHash = [...new Set(bucket.rows.map((e) => e.view.modelHash))];
    const processing = summarizeProcessing(bucket.rows.map((e) => e.point));
    // §9.3 保守边界：无法证实处理条件一致（未报告/多条件）或模型不唯一 → 该组不发布个人结论。
    const processingBlock: CorrelationStatus | null = processing.comparable ? null
      : processing.state === 'mixed' ? 'PROCESSING_MIXED' : 'PROCESSING_UNKNOWN';
    const block: CorrelationStatus | null = modelHash.length > 1 ? 'MODEL_MIXED' : processingBlock;
    const comparable = block === null;
    const comparableReason = block === null ? null : `${block}：${correlationReasonFor(block)}`;
    const flags = qualityFlagSummary(bucket.allViews);
    const correlations = correlationsFor(bucket.rows, input.zone, block, flags.qualityFlags);
    const groups = { quiet: groupsFor(bucket.rows, 'quietRatio'), noisy: groupsFor(bucket.rows, 'noisyRatio') };
    const dueRows = bucket.rows.filter((e) => badBuckets(e.point).conversationMs + badBuckets(e.point).ringMs >= 60_000);
    const strata = [...new Set(bucket.rows.map((e) => e.view.roomId))].map((roomId) => ({ roomId, N: bucket.rows.filter((e) => e.view.roomId === roomId).length }));
    const days = new Set(bucket.rows.map((e) => zoneDateString(e.view.startTime, input.zone)));
    const times = bucket.rows.map((e) => e.view.startTime);
    // 该配置分组在窗口内被「质量/削波」类原因剔除的逐条计数 ——「质量不足」的可见证据。
    // 注意：剔除原因码是 quality_anomaly / clipped（ANOMALY_FLAGS 是**标记名**，逐条计数见 qualityFlags）。
    const qualityExcluded = [...exclusions.entries()]
      .filter(([reason]) => reason === 'quality_anomaly' || reason === 'clipped')
      .map(([reason, count]) => ({ reason, count }));
    const scope: RuleScope = {
      comparable,
      comparableReason,
      // 组内可比较时允许该组自己的建议门槛判定；是否最终进入 suggestions 由池化层决定。
      suggestionsAllowed: comparable,
      zone: input.zone,
      rows: bucket.rows,
      flaggedRows: flaggedRowsOf(bucket.rows),
      correlations,
      groups,
      withBadSoundN: dueRows.length,
      strata,
    };
    const evaluatedRules = evaluateRuleGates(scope);
    configurations.push({
      key,
      versions: bucket.versions,
      modelHash,
      N: bucket.rows.length,
      focusN: bucket.rows.filter((e) => e.view.userFocusScore !== null).length,
      efficiencyN: bucket.rows.filter((e) => e.view.userEfficiencyScore !== null).length,
      tier: tierFor(bucket.rows.length),
      distinctDays: days.size,
      fromDate: times.length ? zoneDateString(Math.min(...times), input.zone) : null,
      toDate: times.length ? zoneDateString(Math.max(...times), input.zone) : null,
      rooms: strata,
      qualityFlags: flags.qualityFlags,
      qualityFlaggedN: flags.qualityFlaggedN,
      qualityExcluded,
      processing,
      comparable,
      comparableReason,
      comparableNote: comparable ? '本组配置与处理条件可比较' : `${comparableReason ?? ''}`,
      correlations,
      groups,
      suggestionGates: evaluatedRules.gates,
    });
  }
  configurations.sort((a, b) => (b.N - a.N) || a.key.localeCompare(b.key));

  // 池化（跨全部合格记录）只在「恰好一个配置分组」时才有意义；否则整组结论一律不发布。
  // 0 组（没有任何合格记录）不是「混配置」：它走既有的「样本不足」路径，不得误报成跨配置。
  const pooledBlock: CorrelationStatus | null = !versions.consistent ? 'VERSION_MIXED'
    : configurations.length === 0 ? null
      : configurations.length === 1 ? (configurations[0].comparable ? null
        : (configurations[0].processing.comparable ? 'MODEL_MIXED'
          : (configurations[0].processing.state === 'mixed' ? 'PROCESSING_MIXED' : 'PROCESSING_UNKNOWN')))
        : 'VERSION_MIXED';
  const comparisonReady = pooledBlock === null;
  const pooledProcessing = summarizeProcessing(eligible.map((e) => e.point));
  const pooledFlags = qualityFlagSummary(evaluated.map((e) => e.view));

  const correlations: CorrelationOut[] = correlationsFor(eligible, input.zone, pooledBlock, pooledFlags.qualityFlags);

  const groups = {
    quiet: groupsFor(eligible, 'quietRatio'),
    noisy: groupsFor(eligible, 'noisyRatio'),
  };

  const strata = [...new Set(eligible.map((e) => e.view.roomId))].map((roomId) => {
    const rows = eligible.filter((e) => e.view.roomId === roomId);
    return { roomId, N: rows.length, tier: tierFor(rows.length) };
  });
  const stratified = strata.length > 1;

  let message: string;
  if (pooledBlock === null) {
    const statisticalPairs = correlations.filter((c) => c.pairTier === 'statistical');
    if (eligibleN < TIER_PRELIMINARY_MIN) {
      message = template.insufficient(eligibleN);
    } else if (!statisticalPairs.length) {
      message = template.preliminary(eligibleN, groups.quiet.high.medianFocus, groups.quiet.low.medianFocus);
    } else {
      const pick = statisticalPairs.find((c) => c.pairId === 'noisyRatio-focus')
        ?? statisticalPairs.find((c) => c.y === 'userFocusScore')
        ?? statisticalPairs[0];
      message = template.statistical({
        from: pick.from ?? zoneDateString(input.windowStart, input.zone),
        to: pick.to ?? zoneDateString(input.now, input.zone),
        n: pick.N,
        direction: directionOf(pick.rho),
        rho: pick.rho,
        label: pick.label,
      });
    }
  } else if (pooledBlock === 'VERSION_MIXED') {
    // 跨配置：不进入任何关联/建议分支，只说明为什么没有结论（§4.2）。
    message = template.mixedConfig(eligibleN);
  } else {
    // 处理条件/模型证据不足：同样只给不足态，不给个人结论（TASK B §3）。
    message = template.processingInsufficient(eligibleN, correlationReasonFor(pooledBlock as CorrelationStatus) ?? '处理条件证据不足');
  }
  assertNoCausalClaim(message);

  // §4.2 保守模式总开关：跨配置/不可比时**服务端**不产生任何个人建议。
  // 三条规则各自引用通用发布门槛；这里只决定「池化层是否允许建议」（单组且可比较）。
  const suggestionsAllowed = comparisonReady;
  const dueSessions = eligible.filter((e) => {
    const ms = badBuckets(e.point);
    return ms.conversationMs + ms.ringMs >= 60_000;
  });
  const pooledScope: RuleScope = {
    comparable: pooledBlock === null,
    comparableReason: pooledBlock === null ? null : correlationReasonFor(pooledBlock),
    suggestionsAllowed,
    zone: input.zone,
    rows: eligible,
    flaggedRows: flaggedRowsOf(eligible),
    correlations,
    groups: { quiet: { high: groups.quiet.high, low: groups.quiet.low }, noisy: { high: groups.noisy.high, low: groups.noisy.low } },
    withBadSoundN: dueSessions.length,
    strata,
  };
  const pooledRules = evaluateRuleGates(pooledScope);
  const suggestionGates = pooledRules.gates;
  const suggestions: Record<string, unknown>[] = [];
  pooledRules.candidates.forEach((candidate, index) => {
    // §6.169/§4.1：最多 2 条已满足门槛的建议，按固定规则顺序呈现（1→2→3）。
    if (candidate && suggestionGates[index].publishable && suggestions.length < 2) {
      suggestions.push({ ruleId: suggestionGates[index].ruleId, text: candidate.text, evidence: candidate.evidence });
    }
  });

  // §6.169：不满足门槛则明确「当前没有稳定的记录趋势」，suggestions=[]（不包装成 AI 建议）。
  // §4.2：配置不一致/处理条件不足时给的是对应「不足」说明，而不是「没有稳定趋势」。
  const suggestionsNote = !comparisonReady
    ? (pooledBlock === 'VERSION_MIXED'
      ? '存在多种配置，本次不发布跨配置关联与个人建议'
      : '处理条件未报告或不一致，本次不发布个人关联与建议')
    : (!suggestions.length && tier === 'statistical' ? template.noTrend : null);

  const analysis = {
    eligibleN,
    windowN,
    tier,
    windowTier,
    windowDays: 30,
    /** §4.2/§9.3：只有配置一致且处理条件可比较时才认为这批记录「可比较」，可比较才可能发布池化 rho 与建议。 */
    comparisonReady,
    /** 池化不可发布时的原因码（OK 之外都不得发布个人结论）。 */
    comparisonBlockReason: pooledBlock,
    comparisonBlockNote: pooledBlock === null ? null : correlationReasonFor(pooledBlock),
    correlations,
    configurations,
    groupings: {
      dimension: [...CONFIGURATION_DIMENSIONS],
      key: 'preprocessVersion|runtimeVersion|mapVersion|decisionVersion',
      note: '关联与建议先按配置分组；未知/不一致的处理条件不发布个人结论，组内门槛不通过不用池化结果替代',
    },
    processingEvidence: pooledProcessing,
    groups,
    suggestions,
    suggestionGates,
    suggestionsNote,
    exclusions: [...exclusions.entries()].map(([reason, count]) => ({ reason, description: EXCLUSION_REASONS[reason] ?? reason, count })),
    versions,
    strata,
    stratified,
    stratifiedNote: stratified ? '记录包含不同空间；各层不足阈值时只给全体描述' : null,
    definitions: {
      quietRatioHigh: GROUP_THRESHOLDS.quietHigh,
      quietRatioLow: GROUP_THRESHOLDS.quietLow,
      noisyRatioHigh: GROUP_THRESHOLDS.noisyHigh,
      noisyRatioLow: GROUP_THRESHOLDS.noisyLow,
      minCoverageRatio: ELIGIBILITY.minCoverageRatio,
      minDurationMs: ELIGIBILITY.minDurationMs,
      note: '安静/声音更高的定义为预注册阈值，可点开查看；覆盖率=有效推理时长/观察总时长',
    },
    message,
    eligibilityRule: '已结束、时长≥300s、AI覆盖率≥0.80、样本≥floor(时长/5)×0.80、削波≤1%、无配置异常、自评非null、桶已补齐',
  };
  // TASK B §4：整个分析对象的面向用户文本（含中文）一律过因果断言 —— 新增文案不可能绕过。
  assertNoCausalClaimInTexts(analysis);
  return analysis;
}

// ---------------------------------------------------------------------------
// 今日 / 本周聚合（§5 GET /api/study-insights、§7 日期归属）
// ---------------------------------------------------------------------------

/**
 * 桶行的时长字段必须是有限数。
 *
 * §4.1「数值有限性输出校验禁止 NaN→JSON null 伪装合法缺测」：缺列/undefined 若被
 * `Number(undefined)` 吞成 NaN，`JSON.stringify` 会输出 `null`，使「算错了/漏选了」看起来
 * 像「没有数据」。这里一律抛契约错误，由调用方（buildInsights 出口）暴露为失败而不是 null。
 */
function requireFiniteMs(value: unknown, field: string, sessionId: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(
      `洞察聚合发现非有限数值：session=${sessionId} field=${field} value=${String(value)}（禁止 NaN→JSON null 伪装缺测）`,
    );
  }
  return n;
}

/** 一个会话在一个窗口（本地日/周）内的真实时长账。 */
export interface BucketAccounting {
  quietMs: number;
  noisyMs: number;
  /** 只含已到达桶的 unknown；缺桶部分由调用方用 gap 补入（§4.1）。 */
  unknownMs: number;
  validMs: number;
  classifiedMs: number;
  /** 已到达桶与窗口的交集总时长，用于推算缺桶时长。 */
  bucketCoveredMs: number;
}

export function allocateBuckets(point: StudyPoint, windowStart: number, windowEnd: number): BucketAccounting {
  const sessionId = point.view.sessionId;
  const startTime = point.view.startTime;
  let quietMs = 0;
  let noisyMs = 0;
  let unknownMs = 0;
  let validMs = 0;
  let classifiedMs = 0;
  let bucketCoveredMs = 0;
  for (const b of point.bucketRows) {
    const startOffsetMs = requireFiniteMs(b.startOffsetMs, 'startOffsetMs', sessionId);
    const endOffsetMs = requireFiniteMs(b.endOffsetMs, 'endOffsetMs', sessionId);
    const width = endOffsetMs - startOffsetMs;
    if (width <= 0) continue;
    const bucketStart = startTime + startOffsetMs;
    const bucketEnd = startTime + endOffsetMs;
    const covered = allocateIntersection(bucketStart, bucketEnd, windowStart, windowEnd);
    if (covered <= 0) continue;
    // 5 秒声学桶跨边界时按交集比例分配（§7：5 秒摘要精度）。
    // 保留小数毫秒，不逐桶取整——取整会破坏 quiet+noisy+unknown=观察时长 的守恒。
    const share = covered / width;
    quietMs += requireFiniteMs(b.quietMs, 'quietMs', sessionId) * share;
    noisyMs += requireFiniteMs(b.noisyMs, 'noisyMs', sessionId) * share;
    unknownMs += requireFiniteMs(b.unknownMs, 'unknownMs', sessionId) * share;
    validMs += requireFiniteMs(b.validInferenceMs, 'validInferenceMs', sessionId) * share;
    classifiedMs += requireFiniteMs(b.classifiedMs, 'classifiedMs', sessionId) * share;
    bucketCoveredMs += covered;
  }
  return { quietMs, noisyMs, unknownMs, validMs, classifiedMs, bucketCoveredMs };
}

/**
 * §4.1 强制规则：
 *  · 缺桶（已结束会话在窗口内、但桶还没到达的时长）补进 unknownMs；
 *  · categoryUnknownMs = studyMs − classifiedMs（类别未知，不是 ΣcategoryMs 已分类时长）；
 *  · hasValidAi = 窗口内是否真有有效推理时长（false 时不得把状态时长解释成「观测到 0」）。
 */
function windowAccounting(studyMs: number, acc: BucketAccounting) {
  const missingBucketMs = Math.max(0, studyMs - acc.bucketCoveredMs);
  const classifiedMs = Math.max(0, Math.min(acc.classifiedMs, studyMs));
  return {
    studyMs,
    quietMs: acc.quietMs,
    noisyMs: acc.noisyMs,
    unknownMs: acc.unknownMs + missingBucketMs,
    validInferenceMs: acc.validMs,
    classifiedMs,
    categoryUnknownMs: Math.max(0, studyMs - classifiedMs),
    missingBucketMs,
    hasValidAi: acc.validMs > 0,
  };
}

/**
 * §4.1：数值有限性出口校验——响应里任何非有限数都在服务端抛出，
 * 不允许被 JSON.stringify 变成 null 冒充「没有数据」（FAILURE BRANCH：禁止显示该响应）。
 */
export function assertFiniteNumbers(value: unknown, path = 'insights'): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`洞察响应包含非有限数值：${path}=${String(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFiniteNumbers(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      assertFiniteNumbers(item, `${path}.${key}`);
    }
  }
}

export interface BlockContext { now: number; zone: string; allocate: typeof allocateIntersection }

export function buildTodayBlock(points: StudyPoint[], ctx: BlockContext): Record<string, unknown> {
  const dayStart = zoneDayStart(ctx.now, ctx.zone);
  const dayEnd = zoneDayEnd(ctx.now, ctx.zone);
  // 段数按开始日、评分点按结束日；时长/声学按 [startTime,endTime)∩日区间 分配（跨午夜各算各的）。
  const started = points.filter((p) => p.view.startTime >= dayStart && p.view.startTime < dayEnd);
  const running = points.filter((p) => p.view.status === 'open');
  const ended = points.filter((p) => p.view.status !== 'open' && p.view.endTime !== null &&
    allocateIntersection(p.view.startTime, p.view.endTime as number, dayStart, dayEnd) > 0);
  const endedToday = ended.filter((p) => (p.view.endTime as number) >= dayStart && (p.view.endTime as number) < dayEnd);
  let studyMs = 0;
  let quietMs = 0;
  let noisyMs = 0;
  let unknownMs = 0;
  let validMs = 0;
  let classifiedMs = 0;
  let missingBucketMs = 0;
  let sampleCount = 0;
  let dbSamples = 0;
  let weighted = 0;
  let maxDb: number | null = null;
  for (const p of ended) {
    const end = p.view.endTime as number;
    const sessionStudyMs = allocateIntersection(p.view.startTime, end, dayStart, dayEnd);
    studyMs += sessionStudyMs;
    const acc = windowAccounting(sessionStudyMs, allocateBuckets(p, dayStart, dayEnd));
    quietMs += acc.quietMs;
    noisyMs += acc.noisyMs;
    unknownMs += acc.unknownMs;
    validMs += acc.validInferenceMs;
    classifiedMs += acc.classifiedMs;
    missingBucketMs += acc.missingBucketMs;
    if (p.view.sampleCount) {
      sampleCount += p.view.sampleCount;
      if (p.view.averageDb !== null) {
        // 只有真的有片段均值时才参与加权；真实 0 dBFS 也要算出一个 0 的均值（不得变 null）。
        weighted += p.view.averageDb * p.view.sampleCount;
        dbSamples += p.view.sampleCount;
      }
    }
    if (p.view.maxDb !== null) maxDb = maxDb === null ? p.view.maxDb : Math.max(maxDb, p.view.maxDb);
  }
  const scored = endedToday.filter((p) => p.view.userFocusScore !== null || p.view.userEfficiencyScore !== null)
    .sort((a, b) => (b.view.endTime ?? b.view.startTime) - (a.view.endTime ?? a.view.startTime));
  const latest = scored[0] ?? null;
  return {
    date: zoneDateString(ctx.now, ctx.zone),
    dayStart,
    dayEnd,
    studyMs,
    studyMinutes: Math.round(studyMs / 60_000),
    startedCount: started.length,
    endedCount: endedToday.length,
    quietMs,
    noisyMs,
    unknownMs,
    validInferenceMs: validMs,
    classifiedMs,
    categoryUnknownMs: Math.max(0, studyMs - classifiedMs),
    missingBucketMs,
    hasValidAi: validMs > 0,
    coverageRatio: studyMs > 0 ? Math.round((validMs / studyMs) * 1000) / 1000 : null,
    averageDb: dbSamples > 0 ? Math.round((weighted / dbSamples) * 100) / 100 : null,
    maxDb,
    sampleCount,
    sampleScopeNote: '均值/最大值为今日相交会话的整段摘要；0 条为 null，不显示为 0',
    latestAssessment: latest
      ? {
        sessionId: latest.view.sessionId,
        userFocusScore: latest.view.userFocusScore,
        userEfficiencyScore: latest.view.userEfficiencyScore,
        optionalNote: latest.view.optionalNote,
        endTime: latest.view.endTime,
      }
      : null,
    running: running.filter((p) => p.view.startTime < dayEnd).map((p) => ({
      sessionId: p.view.sessionId,
      liveElapsedMs: Math.max(0, ctx.now - p.view.startTime),
      note: '进行中的学习段不计入已完成聚合',
    })),
    precisionNote: '跨午夜时长按 [startTime,endTime) 与日区间交集分配；声学桶按交集比例分配，精度 5 秒；unknownMs 含尚未到达的缺桶时长',
  };
}

export function buildWeekBlock(points: StudyPoint[], ctx: BlockContext): Record<string, unknown> {
  const weekStart = zoneWeekStart(ctx.now, ctx.zone);
  const weekEnd = zoneWeekEnd(ctx.now, ctx.zone);
  const started = points.filter((p) => p.view.startTime >= weekStart && p.view.startTime < weekEnd);
  // 跨周边界的学习段按交集计入本周（段数仍按开始日/结束日分别统计）。
  const ended = points.filter((p) => p.view.status !== 'open' && p.view.endTime !== null &&
    allocateIntersection(p.view.startTime, p.view.endTime as number, weekStart, weekEnd) > 0);
  const days: { date: string; minutes: number; studyMs: number }[] = [];
  // §4.1：每日轮换按**本地日历**递增。固定 +86,400,000ms 步进在 DST 时区会错位/重复一天。
  const firstLocalDay = localParts(weekStart, ctx.zone);
  for (let i = 0; i < 7; i += 1) {
    const day = shiftDate(firstLocalDay.year, firstLocalDay.month, firstLocalDay.day, i);
    const nextDay = shiftDate(day.year, day.month, day.day, 1);
    const dayStart = midnightOf(day.year, day.month, day.day, ctx.zone);
    const dayEnd = midnightOf(nextDay.year, nextDay.month, nextDay.day, ctx.zone);
    let ms = 0;
    for (const p of ended) ms += allocateIntersection(p.view.startTime, p.view.endTime as number, dayStart, dayEnd);
    days.push({ date: zoneDateString(dayStart, ctx.zone), minutes: Math.round(ms / 60_000), studyMs: ms });
  }
  let quietMs = 0;
  let noisyMs = 0;
  let unknownMs = 0;
  let validMs = 0;
  let classifiedMs = 0;
  let missingBucketMs = 0;
  let studyMs = 0;
  const perCategory = new Map<string, number>(CATEGORY_IDS.map((id) => [id, 0]));
  for (const p of ended) {
    const sessionStudyMs = allocateIntersection(p.view.startTime, p.view.endTime as number, weekStart, weekEnd);
    studyMs += sessionStudyMs;
    const acc = windowAccounting(sessionStudyMs, allocateBuckets(p, weekStart, weekEnd));
    quietMs += acc.quietMs;
    noisyMs += acc.noisyMs;
    unknownMs += acc.unknownMs;
    validMs += acc.validInferenceMs;
    classifiedMs += acc.classifiedMs;
    missingBucketMs += acc.missingBucketMs;
    for (const b of p.bucketRows) {
      const width = Number(b.endOffsetMs) - Number(b.startOffsetMs);
      if (width <= 0) continue;
      const bucketStart = p.view.startTime + Number(b.startOffsetMs);
      const bucketEnd = p.view.startTime + Number(b.endOffsetMs);
      const share = allocateIntersection(bucketStart, bucketEnd, weekStart, weekEnd) / width;
      if (share <= 0) continue;
      let cats: Record<string, number> = {};
      try {
        cats = JSON.parse(String(b.categoryMs)) as Record<string, number>;
      } catch {
        cats = {};
      }
      for (const id of CATEGORY_IDS) perCategory.set(id, (perCategory.get(id) ?? 0) + Number(cats[id] ?? 0) * share);
    }
  }
  // §7：评分点按结束日归属，故本周自评中位数取「结束于本周」的段。
  const endedInWeek = ended.filter((p) => (p.view.endTime as number) >= weekStart && (p.view.endTime as number) < weekEnd);
  const focus = endedInWeek.map((p) => p.view.userFocusScore).filter((v): v is number => v !== null);
  const efficiency = endedInWeek.map((p) => p.view.userEfficiencyScore).filter((v): v is number => v !== null);
  const categorySeconds = [...perCategory.entries()]
    .map(([categoryId, ms]) => ({ categoryId, ms, seconds: Math.round(ms / 1000) }))
    .sort((a, b) => b.ms - a.ms);
  return {
    weekStart,
    weekEnd,
    weekStartDate: zoneDateString(weekStart, ctx.zone),
    weekEndDate: zoneDateString(weekEnd - 1, ctx.zone),
    days,
    studyMs,
    studyMinutes: Math.round(studyMs / 60_000),
    endedCount: endedInWeek.length,
    intersectingCount: ended.length,
    startedCount: started.length,
    focusMedian: median(focus),
    focusN: focus.length,
    efficiencyMedian: median(efficiency),
    efficiencyN: efficiency.length,
    validInferenceMs: validMs,
    classifiedMs,
    quietMs,
    noisyMs,
    unknownMs,
    categoryUnknownMs: Math.max(0, studyMs - classifiedMs),
    missingBucketMs,
    hasValidAi: validMs > 0,
    missingRatio: studyMs > 0 ? Math.round((Math.max(0, studyMs - validMs) / studyMs) * 1000) / 1000 : null,
    categorySeconds,
    top3: categorySeconds.filter((c) => c.seconds > 0).slice(0, 3),
    note: '周一 0 点至下周一 0 点的本地时间；自评中位数与分钟柱不同轴；unknownMs 含尚未到达的缺桶时长，categoryUnknownMs=本周学习时长−已分类时长',
  };
}

export interface InsightsPayload {
  timezone: string;
  nowDate: string | null;
  range: 'today' | 'week';
  today: Record<string, unknown>;
  week: Record<string, unknown>;
  analysis: Record<string, unknown>;
  updatedAt: number;
}

export type AnalysisRow = StudyPointRow;
export interface StudyPointRow { sessionId: string }
