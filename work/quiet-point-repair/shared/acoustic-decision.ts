/**
 * 增强 A 决策管线（纯逻辑 + 状态机，Node 可单测）：
 * 「16 kHz 波形窗口（15,600 点 / hop 7,680 点）→ 12 类分数 → EMA/投票/迟滞 → 每窗末尾 480 ms 决策单元
 *  → 5 秒桶 tick 流」。
 *
 * 权威依据（逐条对齐，不得放宽）：
 * - `work/SOL_STAGE45_ENHANCEMENT_PLAN.md` §8 第 4/8/9/11/13 条与 `work/CODEX_DECISION_AI.md` §3 参数表：
 *   · 窗 15,600 点、起点每次 +7,680 点（480 ms）、16k 环 64,000 点、绝对 sample index；
 *   · EMA：首有效窗初始化，其后 `alpha = 1 − exp(−真实deltaT/1.2s)`；
 *   · 进入：`z ≥ 0.55` 且领先第二名 `≥ 0.10`，最近 3 个连续有效窗中同候选 ≥2 票；
 *   · 保持/退出：`z ≥ 0.35` 保持，连续 3 窗 < 0.35 才退出；新候选满足进入且连续占优 ≥0.96 s 才切换；
 *   · 稳定展示：最短驻留 1.44 s、最多每 960 ms 刷新；缺测/不可用立即显示状态（不受驻留保护）；
 *   · 短事件（咳嗽/碰撞/铃声）：原分数 ≥0.75 且下一有效窗 ≥0.45 确认；单窗尖峰只作候选、不计次数；
 *   · 缺测：连续缺测 ≥960 ms 清 EMA/投票；缺窗不参加多数、最短持续或退出证明，不沿用旧标签补时间；
 *   · 每成功窗只负责其**末尾 480 ms** 半开单元；跨桶按交集拆毫秒；桶最多等 500 ms 结果后封存，
 *     迟到结果只能计 unknown/drop，不改已发送桶；
 *   · 模型缺失/hash 错/张量不符/映射错 → 本段 AI 停止，后续全 unknown、top3 清空。
 * - 映射一律走 `shared/acoustic-map.ts` 的 `mapScoreVector`（组分数 = 组内 max，不归一化、不称概率）。
 *
 * 诚实性（本模块的硬边界）：
 * - **阈值不是"已调优"结果**：全部数值来自上述裁决表，本模块只把它们变成显式常量并标注出处；
 *   任何后续调参必须换版本号并留下真机误判计数（CODEX_DECISION_AI §3 首段）。
 * - 模型不可用 / 推理异常 / 分数越界 → 单元 `validInference=false`，**不产出任何类别**；
 *   绝不按声级阈值或旧标签伪造类别。
 * - 本模块不采音、不联网、不写文件；单元与 tick 只含数字与枚举。
 */

import { CATEGORY_IDS, type CategoryId } from './acoustic-categories.js';
import { mapScoreVector } from './acoustic-map.js';
import type { BucketTick } from './study-bucket.js';

/** 决策算法版本（Sol §5.2：决策算法未变保持 decision-v1）。 */
export const DECISION_VERSION = 'decision-v1';

// ---------------------------------------------------------------------------
// 窗口 / 时间常量（§8.4、§8.11）
// ---------------------------------------------------------------------------

/** YAMNet patch 波形长度：96 个 10 ms 谱帧 → (96−1)×160+400 = 15,600 点 = 0.975 s。 */
export const DECISION_WINDOW_SAMPLES = 15_600;
/** 窗口起点步进：7,680 点 = 480 ms。 */
export const DECISION_STRIDE_SAMPLES = 7_680;
/** 16 kHz 环容量：64,000 点 = 4 秒（§8.4）。 */
export const DECISION_RING_SAMPLES = 64_000;
/** 每个成功窗负责的时间单元 = hop = 480 ms。 */
export const DECISION_CELL_MS = 480;
/** 窗口跨度（毫秒）。 */
export const DECISION_WINDOW_MS = 975;
/** 首窗之前没有足够证据的时长：975 − 480 = 495 ms → unknown。 */
export const DECISION_LEAD_MS = DECISION_WINDOW_MS - DECISION_CELL_MS;
/** 5 秒桶宽（必须与 `shared/study-model.ts` 的 `BUCKET_WIDTH_MS` 一致；测试断言两者相等）。 */
export const DECISION_BUCKET_WIDTH_MS = 5_000;
/** 桶等待结果的预算（§8.11：最多 500 ms）。 */
export const DECISION_BUCKET_WAIT_MS = 500;
/** 期望分数维度（YAMNet/AudioSet 521 类）。 */
export const DECISION_SCORE_COUNT = 521;

/** 短事件类别（§8.9：咳嗽/碰撞/铃声）。 */
export const DECISION_SHORT_EVENT_CATEGORIES: readonly CategoryId[] = ['cough', 'impact', 'ring'];

/**
 * 可进入「稳定类别标签」的候选集合：**排除 quiet 与 background**。
 * 依据 `CODEX_DECISION_AI` §3 参数表「安静/普通背景使用下述状态规则」——
 * 它们的判定由声级门控（相对 15 s 基线的 dBFS 迟滞）驱动，不是分数驱动；
 * 声级门控在 app 采样层（不属本纯逻辑模块），此处只保留其候选分数供上层使用。
 */
export const DECISION_LABEL_CANDIDATES: readonly CategoryId[] = CATEGORY_IDS.filter(
  (id) => id !== 'quiet' && id !== 'background',
);

/** Top3 只排除 quiet（§8.9「quiet 不与实质类同列」）；background 是真实映射类，可列出。 */
export const DECISION_TOP3_EXCLUDED: readonly CategoryId[] = ['quiet'];

// ---------------------------------------------------------------------------
// 参数（显式常量 + 出处；**不声称已调优**）
// ---------------------------------------------------------------------------

export interface DecisionParams {
  /** EMA 时间常数（秒）。出处：CODEX_DECISION_AI §3 表「类目EMA tau=1.2s」。 */
  emaTauSeconds: number;
  /** 进入阈值。出处：同上「z≥0.55」。 */
  enterScore: number;
  /** 进入时领先第二名的差值。出处：同上「领先第二名≥0.10」。 */
  enterMargin: number;
  /** 进入所需票数。出处：同上「最近3个连续有效窗中同候选≥2票」。 */
  enterVotes: number;
  /** 投票窗口长度（窗）。出处：同上「最近3个连续有效窗」。 */
  voteWindow: number;
  /** 保持阈值。出处：同上「当前z≥0.35即保持」。 */
  holdScore: number;
  /** 退出所需的连续低于保持阈值窗数。出处：同上「连续3个窗低于0.35才退出」。 */
  exitBelowHoldCount: number;
  /** 新候选连续占优时长（毫秒）。出处：同上「连续占优≥0.96s才切换」。 */
  switchDominanceMs: number;
  /** 最短展示驻留（毫秒）。出处：同上「最短驻留1.44s」。 */
  minDwellMs: number;
  /** 界面最多刷新间隔（毫秒）。出处：同上「界面最多每960ms刷新」。 */
  maxRefreshMs: number;
  /** 连续缺测多少毫秒后清 EMA/投票。出处：同上「连续缺测≥960ms清EMA/投票」。 */
  missingResetMs: number;
  /** 短事件进入阈值（原分数）。出处：同上「原分数≥0.75」。 */
  shortEventScore: number;
  /** 短事件确认阈值（下一有效窗）。出处：同上「且下一有效窗≥0.45」。 */
  shortEventConfirmScore: number;
  /** Top3 分数门槛。出处：§8.9「每项≥0.35」。 */
  top3MinScore: number;
  /** Top3 票数门槛（最近 3 有效窗）。出处：§8.9「最近3有效窗≥2次过此门槛」。 */
  top3MinVotes: number;
  /**
   * 连续推理失败多少次后本段停 AI（后续全 unknown，直到显式新段 reset）。
   * 出处：§8.13「单次INFERENCE_FAILED当前单元unknown；无法证明可恢复则本段停AI」。具体次数未在
   * 裁决中给出，此处取 3 并**列入待 Sol 裁定项**；不重试风暴。
   */
  consecutiveFailureLimit: number;
}

export const DECISION_PARAMS: Readonly<DecisionParams> = Object.freeze({
  emaTauSeconds: 1.2,
  enterScore: 0.55,
  enterMargin: 0.1,
  enterVotes: 2,
  voteWindow: 3,
  holdScore: 0.35,
  exitBelowHoldCount: 3,
  switchDominanceMs: 960,
  minDwellMs: 1_440,
  maxRefreshMs: 960,
  missingResetMs: 960,
  shortEventScore: 0.75,
  shortEventConfirmScore: 0.45,
  top3MinScore: 0.35,
  top3MinVotes: 2,
  consecutiveFailureLimit: 3,
});

// ---------------------------------------------------------------------------
// 窗口提取（16 kHz 环 + 绝对 sample index）
// ---------------------------------------------------------------------------

export interface WindowPushMeta {
  sequence?: number;
  firstSourceFrame?: number;
  generation?: number;
  nowMs?: number;
  /** 只接受 16 kHz；其它速率必须先在 FIR 模块转成 16 kHz（显式失败，不静默当 16k）。 */
  inputRateHz?: number;
}

/** 一个完整的 15,600 点窗口；绝对索引均为 16 kHz 域。 */
export interface WindowSlice {
  /** 段内窗口序号（0 起；gap 后新段重新计数）。 */
  windowIndex: number;
  /** 窗口首样本的绝对 source frame 索引。 */
  firstSampleIndex: number;
  /** 窗口尾样本的绝对索引 +1。 */
  endSampleIndexExclusive: number;
  /** 该窗负责的末尾 480 ms 单元的绝对区间 `[cellStart, cellEnd)`。 */
  cellStartSampleIndex: number;
  cellEndSampleIndex: number;
  samples: Float32Array;
}

export interface WindowExtractorDiagnostics {
  windowsEmitted: number;
  gapCount: number;
  segmentsStarted: number;
  /** 因窗口起点被新数据越过（环溢出/迟到）而未产出的窗口数。 */
  droppedWindows: number;
  /** 内部保留的最大样本数（流式 1024 点投入时应 ≤ 64,000，即 4 秒环）。 */
  maxRetainedSamples: number;
}

export const WINDOW_EXTRACTOR_GAP_PAUSE_MS = 250;

/**
 * 16 kHz 环形窗口提取器：把连续 16 kHz 样本切成 15,600 点、hop 7,680 点的重叠窗。
 *
 * - 绝对 sample index 贯穿全部对外字段，便于与 sourceFrame/generation 对账；
 * - `sequence`/`firstSourceFrame` 不连续、`generation` 变化或块间停顿 >250 ms → 切断连续段
 *   （清环、窗口序号归零、下一个窗口从新块首样本开始），**绝不跨断点拼窗**；
 * - 输入必须是 16 kHz（本模块不做重采样；用了 `shared/acoustic-fir.ts` 才是 `preproc-v2`）。
 */
export class WindowExtractor16k {
  private buf: Float32Array = new Float32Array(0);
  private bufAbsStart = 0;
  private bufLen = 0;
  private nextWindowStart = 0;
  private windowIndex = 0;
  private lastSequence: number | null = null;
  private lastSourceFrameEnd: number | null = null;
  private lastGeneration: number | null = null;
  private lastNowMs: number | null = null;

  private windowsEmitted = 0;
  private gapCount = 0;
  private segmentsStarted = 0;
  private droppedWindows = 0;
  private maxRetained = 0;

  constructor(private readonly capacitySamples: number = DECISION_RING_SAMPLES) {
    if (!Number.isInteger(capacitySamples) || capacitySamples < DECISION_WINDOW_SAMPLES) {
      throw new Error(`WINDOW_EXTRACTOR_BAD_CAPACITY: ${String(capacitySamples)}`);
    }
  }

  get diagnostics(): WindowExtractorDiagnostics {
    return Object.freeze({
      windowsEmitted: this.windowsEmitted,
      gapCount: this.gapCount,
      segmentsStarted: this.segmentsStarted,
      droppedWindows: this.droppedWindows,
      maxRetainedSamples: this.maxRetained,
    });
  }

  /** 当前保留样本数（诊断）。 */
  get retainedSamples(): number {
    return this.bufLen;
  }

  /** 下一个窗口的绝对起点（诊断）。 */
  get nextWindowStartIndex(): number {
    return this.nextWindowStart;
  }

  /** 显式切断连续段（切后台、源停顿、处理设置变化等）。 */
  markGap(): void {
    this.cutSegment();
  }

  push(samples: Float32Array, meta: WindowPushMeta = {}): WindowSlice[] {
    if (!(samples instanceof Float32Array)) {
      throw new Error('WINDOW_INPUT_TYPE: push 只接受 Float32Array');
    }
    if (meta.inputRateHz !== undefined && meta.inputRateHz !== 16_000) {
      throw new Error(
        `WINDOW_RATE_UNSUPPORTED: 本提取器只接受 16 kHz，收到 ${meta.inputRateHz} Hz（须先经 FIR 重采样）`,
      );
    }
    if (samples.length === 0) return [];
    for (let i = 0; i < samples.length; i += 1) {
      if (!Number.isFinite(samples[i] as number)) {
        throw new Error(`WINDOW_INPUT_NOT_FINITE: 第 ${i} 个样本非有限数，拒绝把 NaN 当静音`);
      }
    }

    this.applyMeta(meta, samples.length);

    if (this.bufLen === 0) {
      this.bufAbsStart = meta.firstSourceFrame ?? this.nextWindowStart;
      this.nextWindowStart = this.bufAbsStart;
      if (this.segmentsStarted === 0) this.segmentsStarted = 1;
    }
    const merged = new Float32Array(this.bufLen + samples.length);
    if (this.bufLen > 0) merged.set(this.buf.subarray(0, this.bufLen), 0);
    merged.set(samples, this.bufLen);
    this.buf = merged;
    this.bufLen += samples.length;
    if (this.bufLen > this.maxRetained) this.maxRetained = this.bufLen;

    const out: WindowSlice[] = [];
    // 环容量：只保留最近 capacitySamples 个样本；被越过的窗口起点无法再拼出完整窗 → 计 dropped。
    const keepFrom = Math.max(0, this.bufLen - this.capacitySamples);
    if (keepFrom > 0) {
      const skipped = this.nextWindowStart - (this.bufAbsStart + keepFrom);
      if (skipped > 0) {
        this.droppedWindows += Math.max(1, Math.floor(skipped / DECISION_STRIDE_SAMPLES));
        this.nextWindowStart = this.bufAbsStart + keepFrom;
      }
    }

    while (this.nextWindowStart + DECISION_WINDOW_SAMPLES <= this.bufAbsStart + this.bufLen) {
      const offset = this.nextWindowStart - this.bufAbsStart;
      const samplesOut = this.buf.slice(offset, offset + DECISION_WINDOW_SAMPLES);
      out.push({
        windowIndex: this.windowIndex,
        firstSampleIndex: this.nextWindowStart,
        endSampleIndexExclusive: this.nextWindowStart + DECISION_WINDOW_SAMPLES,
        cellStartSampleIndex: this.nextWindowStart + DECISION_WINDOW_SAMPLES - DECISION_STRIDE_SAMPLES,
        cellEndSampleIndex: this.nextWindowStart + DECISION_WINDOW_SAMPLES,
        samples: samplesOut,
      });
      this.windowIndex += 1;
      this.windowsEmitted += 1;
      this.nextWindowStart += DECISION_STRIDE_SAMPLES;
    }

    // 裁掉下一个窗口起点之前的历史（环内存有界）。
    const drop = Math.max(0, Math.min(this.nextWindowStart - this.bufAbsStart, this.bufLen));
    if (drop > 0) {
      const keep = this.bufLen - drop;
      const fresh = new Float32Array(keep);
      if (keep > 0) fresh.set(this.buf.subarray(drop, drop + keep), 0);
      this.buf = fresh;
      this.bufLen = keep;
      this.bufAbsStart += drop;
    }
    return out;
  }

  private applyMeta(meta: WindowPushMeta, length: number): void {
    let gap = false;
    if (meta.generation !== undefined) {
      if (this.lastGeneration !== null && meta.generation !== this.lastGeneration) gap = true;
      this.lastGeneration = meta.generation;
    }
    if (meta.sequence !== undefined) {
      const expected = this.lastSequence === null ? null : (this.lastSequence + 1) >>> 0;
      if (expected !== null && meta.sequence !== expected) gap = true;
      this.lastSequence = meta.sequence;
    }
    if (meta.firstSourceFrame !== undefined) {
      if (this.lastSourceFrameEnd !== null && meta.firstSourceFrame !== this.lastSourceFrameEnd) gap = true;
      this.lastSourceFrameEnd = meta.firstSourceFrame + length;
    } else if (this.lastSourceFrameEnd !== null) {
      this.lastSourceFrameEnd += length;
    }
    if (meta.nowMs !== undefined) {
      if (this.lastNowMs !== null && meta.nowMs - this.lastNowMs > WINDOW_EXTRACTOR_GAP_PAUSE_MS) gap = true;
      this.lastNowMs = meta.nowMs;
    }
    if (gap) {
      this.gapCount += 1;
      this.cutSegment();
    }
  }

  private cutSegment(): void {
    this.buf = new Float32Array(0);
    this.bufLen = 0;
    this.windowIndex = 0;
    this.nextWindowStart = this.lastSourceFrameEnd ?? this.bufAbsStart;
    this.bufAbsStart = this.nextWindowStart;
    this.segmentsStarted += 1;
  }
}

// ---------------------------------------------------------------------------
// 管线
// ---------------------------------------------------------------------------

/** 推理函数契约：`(waveform: Float32Array) => Promise<{ scores: number[]; latencyMs: number }>`。 */
export type DecisionInferenceFn = (
  waveform: Float32Array,
) => Promise<{ scores: number[]; latencyMs: number }>;

/** 每窗末尾 480 ms 的决策单元（半开区间 `[startMs, endMs)`）。 */
export interface DecisionCell {
  cellIndex: number;
  windowIndex: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  /** 本单元是否有一次真实、有效的推理结果（false = 缺测，不产生 tick）。 */
  validInference: boolean;
  categoryId: CategoryId | null;
  /** 稳定标签的 EMA 分数（短事件确认时为该事件的原始分数）。 */
  score: number;
  /** true = 迟滞确认的稳定标签，或双窗确认的短事件。 */
  confirmed: boolean;
  /** 本窗的领先候选（未确认也保留，供 UI 区分"候选"与"确认"）。 */
  candidateId: CategoryId | null;
  /** 非有效单元的原因 / 未确认短事件标记。 */
  reason: string | null;
  /** 是否由短事件双窗确认得到。 */
  viaShortEvent: boolean;
}

export interface DecisionCounters {
  windows: number;
  validWindows: number;
  missingWindows: number;
  inferenceFailures: number;
  cells: number;
  classifiedCells: number;
  unknownCells: number;
  /** 单窗短事件候选数（原分数 ≥0.75）。 */
  shortEventCandidates: number;
  /** 双窗确认的短事件数。 */
  shortEventConfirmed: number;
  /** 未确认即被下一窗否掉的短事件候选数。 */
  shortEventUnconfirmed: number;
  /** 因缺测/不可用被清空状态机的次数。 */
  stateResets: number;
}

export interface DecisionState {
  version: string;
  status: 'ready' | 'unavailable';
  reason: string | null;
  label: CategoryId | null;
  labelScore: number;
  candidateId: CategoryId | null;
  top3: { categoryId: CategoryId; score: number }[];
  ema: Readonly<Partial<Record<CategoryId, number>>> | null;
  lastLatencyMs: number | null;
  counters: DecisionCounters;
}

export interface DecisionPipelineOptions {
  /** 注入的推理函数（唯一调用点；本模块不自己加载模型）。 */
  infer: DecisionInferenceFn;
  /** 参数覆盖（测试用；生产使用 DECISION_PARAMS）。 */
  params?: Partial<DecisionParams>;
}

const CATEGORY_INDEX = new Map<CategoryId, number>(CATEGORY_IDS.map((id, i) => [id, i]));
const LABEL_CANDIDATE_INDEX: readonly number[] = DECISION_LABEL_CANDIDATES.map(
  (id) => CATEGORY_INDEX.get(id) as number,
);
const TOP3_INDEX: readonly number[] = CATEGORY_IDS.map((id, i) => [id, i] as const)
  .filter(([id]) => !DECISION_TOP3_EXCLUDED.includes(id))
  .map(([, i]) => i);

/**
 * 声学决策管线。调用方必须**串行 await** `runWindow`（同一时刻只有一窗在飞；
 * 背压/在途窗口上限属 Worker 层 §8.6，本模块不并发执行两窗）。
 */
export class AcousticDecisionPipeline {
  private readonly params: DecisionParams;
  private readonly infer: DecisionInferenceFn;

  private status: 'ready' | 'unavailable' = 'ready';
  private unavailableReason: string | null = null;

  private ema: Float64Array | null = null;
  private voteRing: Float64Array[] = [];
  private labelIndex = -1;
  private belowHoldStreak = 0;
  private lastSwitchMs: number | null = null;
  private candidateIndex = -1;
  private candidateSinceMs: number | null = null;
  private lastValidEndMs: number | null = null;
  private missingRunMs = 0;
  private consecutiveFailures = 0;
  private lastLatencyMs: number | null = null;

  private cellIndex = 0;
  private windowIndex = 0;
  private held: { cell: DecisionCell; burstIndex: number; burstScore: number } | null = null;
  /** 因不可用/重置而提前释放的单元（必须回传给调用方，不能静默丢单元）。 */
  private pendingRelease: DecisionCell[] = [];

  private counters: DecisionCounters = {
    windows: 0,
    validWindows: 0,
    missingWindows: 0,
    inferenceFailures: 0,
    cells: 0,
    classifiedCells: 0,
    unknownCells: 0,
    shortEventCandidates: 0,
    shortEventConfirmed: 0,
    shortEventUnconfirmed: 0,
    stateResets: 0,
  };

  constructor(options: DecisionPipelineOptions) {
    if (typeof options?.infer !== 'function') {
      throw new Error('DECISION_INFER_REQUIRED: 必须注入推理函数（调用点唯一）');
    }
    this.infer = options.infer;
    this.params = { ...DECISION_PARAMS, ...(options.params ?? {}) };
  }

  get paramsSnapshot(): Readonly<DecisionParams> {
    return Object.freeze({ ...this.params });
  }

  get state(): DecisionState {
    const ema = this.ema;
    const map: Partial<Record<CategoryId, number>> = {};
    if (ema) {
      for (let i = 0; i < CATEGORY_IDS.length; i += 1) {
        map[CATEGORY_IDS[i] as CategoryId] = ema[i] as number;
      }
    }
    return Object.freeze({
      version: DECISION_VERSION,
      status: this.status,
      reason: this.unavailableReason,
      label: this.labelIndex >= 0 ? (CATEGORY_IDS[this.labelIndex] as CategoryId) : null,
      labelScore: this.labelIndex >= 0 && ema ? (ema[this.labelIndex] as number) : 0,
      candidateId: this.candidateIndex >= 0 ? (CATEGORY_IDS[this.candidateIndex] as CategoryId) : null,
      top3: this.top3(),
      ema: ema ? map : null,
      lastLatencyMs: this.lastLatencyMs,
      counters: Object.freeze({ ...this.counters }),
    });
  }

  /**
   * 声明模型/映射/张量不可用（§8.13）：立即清空标签与 EMA，后续窗口一律缺测（→ 全 unknown）。
   * 不信任何"自动恢复"；只有显式 `reset()`（用户新开始）才回到 ready。
   */
  markUnavailable(reason: string): void {
    this.status = 'unavailable';
    this.unavailableReason = reason;
    // 被短事件机制扣住的单元按"未确认"释放（绝不伪造确认），并随下次返回交还调用方。
    this.releaseHeld(this.pendingRelease, null);
    this.clearSmoothingState();
  }

  /** 显式重开（新学习段）：清状态、回到 ready。 */
  reset(): void {
    this.status = 'ready';
    this.unavailableReason = null;
    this.releaseHeld(this.pendingRelease, null);
    this.clearSmoothingState();
    this.lastValidEndMs = null;
    this.missingRunMs = 0;
    this.consecutiveFailures = 0;
    this.lastLatencyMs = null;
  }

  /**
   * 处理一个完整窗口：调用注入的推理函数并推进状态机。
   * 返回**已定稿**的单元（0 个或多个：上一窗被短事件确认机制扣住时会先补发）。
   * `endMs` = 该窗末尾对应的单调毫秒（相对学习段起点，必须为整数）。
   */
  async runWindow(input: {
    samples: Float32Array;
    endMs: number;
    windowIndex?: number;
  }): Promise<DecisionCell[]> {
    if (!Number.isInteger(input.endMs) || input.endMs < 0) {
      throw new Error(`DECISION_TIME_NOT_INTEGER: endMs=${String(input.endMs)}；单元→桶守恒必须整数毫秒`);
    }
    const windowIndex = input.windowIndex ?? this.windowIndex;
    this.windowIndex = Math.max(this.windowIndex, windowIndex + 1);
    this.counters.windows += 1;

    if (this.status === 'unavailable') {
      return this.drain(this.pushInvalid(input.endMs, windowIndex, this.unavailableReason ?? 'AI_UNAVAILABLE', false));
    }
    if (!(input.samples instanceof Float32Array) || input.samples.length !== DECISION_WINDOW_SAMPLES) {
      return this.drain(
        this.pushInvalid(
          input.endMs,
          windowIndex,
          `WINDOW_LENGTH_INVALID:${input.samples instanceof Float32Array ? input.samples.length : 'not-float32'}`,
          false,
        ),
      );
    }
    for (let i = 0; i < input.samples.length; i += 1) {
      if (!Number.isFinite(input.samples[i] as number)) {
        return this.drain(this.pushInvalid(input.endMs, windowIndex, `WINDOW_NOT_FINITE:${i}`, false));
      }
    }

    let raw: { scores: number[]; latencyMs: number };
    try {
      raw = await this.infer(input.samples);
    } catch (error) {
      this.counters.inferenceFailures += 1;
      this.consecutiveFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      const reason = `INFERENCE_FAILED:${message}`;
      if (this.consecutiveFailures >= this.params.consecutiveFailureLimit) {
        this.markUnavailable(reason);
      }
      return this.drain(this.pushInvalid(input.endMs, windowIndex, reason, false));
    }

    const invalid = this.validateScores(raw);
    if (invalid) {
      this.counters.inferenceFailures += 1;
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.params.consecutiveFailureLimit) {
        this.markUnavailable(invalid);
      }
      return this.drain(this.pushInvalid(input.endMs, windowIndex, invalid, false));
    }

    this.consecutiveFailures = 0;
    this.lastLatencyMs = raw.latencyMs;
    return this.drain(this.acceptValidWindow(input.endMs, windowIndex, raw.scores));
  }

  /**
   * 记录一个**没有推理结果**的窗口（缺测、背压丢弃、reduced 跳窗、Worklet 不可用等）。
   * `planned=true`（reduced 设计性跳窗）不累计"连续缺测"，但同样产出缺测单元（→ unknown），
   * 绝不沿用旧标签补时间。
   */
  pushUnavailableCell(endMs: number, reason: string, planned = false): DecisionCell[] {
    if (!Number.isInteger(endMs) || endMs < 0) {
      throw new Error(`DECISION_TIME_NOT_INTEGER: endMs=${String(endMs)}`);
    }
    const windowIndex = this.windowIndex;
    this.windowIndex += 1;
    this.counters.windows += 1;
    return this.drain(this.pushInvalid(endMs, windowIndex, reason, planned));
  }

  /** 段结束：把被短事件机制扣住的单元按未确认释放（不伪造确认）。 */
  flush(): DecisionCell[] {
    const released: DecisionCell[] = [];
    this.releaseHeld(released, null);
    return this.drain(released);
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  /** 取出因不可用/重置而提前释放的单元，前置到本次返回。 */
  private drain(cells: DecisionCell[]): DecisionCell[] {
    if (this.pendingRelease.length === 0) return cells;
    const pending = this.pendingRelease;
    this.pendingRelease = [];
    return [...pending, ...cells];
  }

  private validateScores(raw: { scores: number[]; latencyMs: number }): string | null {
    if (!raw || !Array.isArray(raw.scores)) return 'SCORES_NOT_ARRAY';
    if (raw.scores.length !== DECISION_SCORE_COUNT) {
      return `SCORES_LENGTH_INVALID:${raw.scores.length}`;
    }
    for (let i = 0; i < raw.scores.length; i += 1) {
      const v = raw.scores[i] as number;
      if (!Number.isFinite(v)) return `SCORES_NOT_FINITE:${i}`;
      if (v < 0 || v > 1) return `SCORES_OUT_OF_RANGE:${i}=${v}`;
    }
    if (typeof raw.latencyMs !== 'number' || !Number.isFinite(raw.latencyMs) || raw.latencyMs < 0) {
      return `LATENCY_INVALID:${String(raw.latencyMs)}`;
    }
    return null;
  }

  private acceptValidWindow(endMs: number, windowIndex: number, scores: readonly number[]): DecisionCell[] {
    const mapped = mapScoreVector(scores);
    const values = CATEGORY_IDS.map((id) => mapped.scores[id] as number);

    const released: DecisionCell[] = [];
    // 1) 缺测清算：连续缺测 ≥960 ms → 清 EMA/投票（缺测不参加退出证明，这里整体重置）。
    if (this.missingRunMs >= this.params.missingResetMs) {
      this.clearSmoothingState();
      this.counters.stateResets += 1;
      this.lastValidEndMs = null;
    }
    // 2) EMA：首有效窗初始化，其后 alpha = 1 − exp(−真实deltaT/tau)。
    const deltaSeconds = this.lastValidEndMs === null ? 0 : (endMs - this.lastValidEndMs) / 1000;
    if (this.ema === null) {
      this.ema = Float64Array.from(values);
    } else {
      const alpha = 1 - Math.exp(-deltaSeconds / this.params.emaTauSeconds);
      const ema = this.ema;
      for (let i = 0; i < ema.length; i += 1) {
        ema[i] = (ema[i] as number) + alpha * ((values[i] as number) - (ema[i] as number));
      }
    }
    this.lastValidEndMs = endMs;
    this.missingRunMs = 0;
    this.counters.validWindows += 1;

    // 3) 用本窗**原始**分数确认/否掉上一窗扣住的短事件。
    this.releaseHeld(released, values);

    // 4) 投票环（含本窗）。
    this.voteRing.push(Float64Array.from(this.ema as Float64Array));
    while (this.voteRing.length > this.params.voteWindow) this.voteRing.shift();

    // 5) 保持/退出。
    if (this.labelIndex >= 0) {
      const labelScore = (this.ema as Float64Array)[this.labelIndex] as number;
      if (labelScore >= this.params.holdScore) {
        this.belowHoldStreak = 0;
      } else {
        this.belowHoldStreak += 1;
        if (this.belowHoldStreak >= this.params.exitBelowHoldCount) {
          this.labelIndex = -1;
          this.belowHoldStreak = 0;
          this.lastSwitchMs = endMs;
        }
      }
    }

    // 6) 进入 / 切换。
    const best = this.bestCandidate();
    if (best.index < 0) {
      this.candidateIndex = -1;
      this.candidateSinceMs = null;
    } else if (this.candidateIndex === best.index) {
      // 候选延续，保持进入时刻
    } else {
      this.candidateIndex = best.index;
      this.candidateSinceMs = endMs;
    }
    if (
      this.candidateIndex >= 0 &&
      this.candidateSinceMs !== null &&
      endMs - this.candidateSinceMs >= this.params.switchDominanceMs &&
      this.labelIndex !== this.candidateIndex
    ) {
      const dwellOk = this.lastSwitchMs === null || endMs - this.lastSwitchMs >= this.params.minDwellMs;
      if (dwellOk) {
        this.labelIndex = this.candidateIndex;
        this.belowHoldStreak = 0;
        this.lastSwitchMs = endMs;
      }
    }

    // 7) 本窗单元。
    const label = this.labelIndex >= 0 ? (CATEGORY_IDS[this.labelIndex] as CategoryId) : null;
    const labelScore = this.labelIndex >= 0 ? ((this.ema as Float64Array)[this.labelIndex] as number) : 0;
    const cell: DecisionCell = {
      cellIndex: this.cellIndex,
      windowIndex,
      startMs: endMs - DECISION_CELL_MS,
      endMs,
      durationMs: DECISION_CELL_MS,
      validInference: true,
      categoryId: label,
      score: labelScore,
      confirmed: label !== null,
      candidateId: this.candidateIndex >= 0 ? (CATEGORY_IDS[this.candidateIndex] as CategoryId) : null,
      reason: null,
      viaShortEvent: false,
    };
    this.cellIndex += 1;
    this.counters.cells += 1;
    if (label === null) this.counters.unknownCells += 1;
    else this.counters.classifiedCells += 1;

    // 8) 短事件候选 → 扣住本单元等下个有效窗确认（桶等 500 ms 的正是这一档）。
    const burst = this.detectShortEvent(values);
    if (burst.index >= 0 && this.held === null) {
      this.counters.shortEventCandidates += 1;
      this.held = { cell, burstIndex: burst.index, burstScore: burst.score };
      return released;
    }
    return [...released, cell];
  }

  private releaseHeld(released: DecisionCell[], currentRaw: readonly number[] | null): void {
    const held = this.held;
    if (!held) return;
    this.held = null;
    const raw = currentRaw === null ? -1 : (currentRaw[held.burstIndex] as number);
    if (raw >= this.params.shortEventConfirmScore) {
      this.counters.shortEventConfirmed += 1;
      released.push({
        ...held.cell,
        categoryId: CATEGORY_IDS[held.burstIndex] as CategoryId,
        score: held.burstScore,
        confirmed: true,
        viaShortEvent: true,
        reason: null,
      });
    } else {
      this.counters.shortEventUnconfirmed += 1;
      released.push({
        ...held.cell,
        reason: currentRaw === null ? 'SHORT_EVENT_UNRESOLVED_AT_SEGMENT_END' : 'SHORT_EVENT_UNCONFIRMED',
      });
    }
  }

  private detectShortEvent(values: readonly number[]): { index: number; score: number } {
    let bestIndex = -1;
    let bestScore = 0;
    for (const id of DECISION_SHORT_EVENT_CATEGORIES) {
      const index = CATEGORY_INDEX.get(id) as number;
      const v = values[index] as number;
      if (v >= this.params.shortEventScore && v > bestScore) {
        bestIndex = index;
        bestScore = v;
      }
    }
    return { index: bestIndex, score: bestScore };
  }

  /** 进入判定：`z ≥ 0.55` 且领先第二名 ≥0.10，且最近 3 个有效窗中同候选 ≥2 票。 */
  private bestCandidate(): { index: number; score: number; margin: number } {
    const ema = this.ema as Float64Array;
    let first = -1;
    let firstScore = -1;
    let secondScore = 0;
    for (const index of LABEL_CANDIDATE_INDEX) {
      const v = ema[index] as number;
      if (v > firstScore) {
        secondScore = firstScore > 0 ? firstScore : secondScore;
        firstScore = v;
        first = index;
      } else if (v > secondScore) {
        secondScore = v;
      }
    }
    if (first < 0) return { index: -1, score: 0, margin: 0 };
    const margin = firstScore - secondScore;
    if (firstScore < this.params.enterScore || margin < this.params.enterMargin) {
      return { index: -1, score: firstScore, margin };
    }
    let votes = 0;
    for (const snapshot of this.voteRing) {
      if ((snapshot[first] as number) >= this.params.enterScore) votes += 1;
    }
    if (votes < this.params.enterVotes) return { index: -1, score: firstScore, margin };
    return { index: first, score: firstScore, margin };
  }

  /** Top3：EMA 降序、同分按类别 id 稳定排序；每项 ≥0.35 且最近 3 有效窗 ≥2 次过门槛。 */
  private top3(): { categoryId: CategoryId; score: number }[] {
    const ema = this.ema;
    if (!ema) return [];
    const rows: { categoryId: CategoryId; score: number }[] = [];
    for (const index of TOP3_INDEX) {
      const score = ema[index] as number;
      if (score < this.params.top3MinScore) continue;
      let votes = 0;
      for (const snapshot of this.voteRing) {
        if ((snapshot[index] as number) >= this.params.top3MinScore) votes += 1;
      }
      if (votes < this.params.top3MinVotes) continue;
      rows.push({ categoryId: CATEGORY_IDS[index] as CategoryId, score });
    }
    rows.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.categoryId.localeCompare(b.categoryId)));
    return rows.slice(0, 3);
  }

  private pushInvalid(endMs: number, windowIndex: number, reason: string, planned: boolean): DecisionCell[] {
    if (!planned) this.missingRunMs += DECISION_CELL_MS;
    this.counters.missingWindows += 1;
    const released: DecisionCell[] = [];
    // 缺测不参加退出证明；但被扣住的短事件必须显式落空（不沿用旧标签补时间）。
    this.releaseHeld(released, null);
    const cell: DecisionCell = {
      cellIndex: this.cellIndex,
      windowIndex,
      startMs: endMs - DECISION_CELL_MS,
      endMs,
      durationMs: DECISION_CELL_MS,
      validInference: false,
      categoryId: null,
      score: 0,
      confirmed: false,
      candidateId: null,
      reason,
      viaShortEvent: false,
    };
    this.cellIndex += 1;
    this.counters.cells += 1;
    this.counters.unknownCells += 1;
    return [...released, cell];
  }

  private clearSmoothingState(): void {
    this.ema = null;
    this.voteRing = [];
    this.labelIndex = -1;
    this.belowHoldStreak = 0;
    this.candidateIndex = -1;
    this.candidateSinceMs = null;
    this.lastSwitchMs = null;
  }
}

/**
 * 单元 → `shared/study-bucket.ts` 的 tick 流。
 * **只有 `validInference=true` 的单元产生 tick**；缺测单元不产生 tick（→ 计 categoryUnknown，
 * 不会被算进 validInferenceMs）。类别为 null 的单元仍产生 tick：那是一次真实推理，只是没确认类别。
 */
export function cellsToTicks(cells: readonly DecisionCell[]): BucketTick[] {
  const out: BucketTick[] = [];
  for (const cell of cells) {
    if (!cell.validInference) continue;
    out.push({
      durationMs: cell.durationMs,
      categoryId: cell.categoryId,
      score: cell.categoryId === null ? 0 : cell.score,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 桶装配（480 ms 单元 → 5 s 桶 tick，含 500 ms 等待预算）
// ---------------------------------------------------------------------------

export interface SealedBucketTicks {
  bucketIndex: number;
  startOffsetMs: number;
  endOffsetMs: number;
  widthMs: number;
  /** 已到达且及时的单元切分后的 tick（跨桶按交集拆分，整数毫秒）。 */
  ticks: BucketTick[];
  /** 有效推理覆盖毫秒（= Σ tick.durationMs，含未确认类别的 null tick）。 */
  coveredMs: number;
  /** 已分类毫秒（Σ 有类别 tick 的 durationMs）。 */
  classifiedMs: number;
  /** 桶内无有效推理覆盖的毫秒（= 桶宽 − coveredMs）→ 计 categoryUnknown。 */
  uncoveredMs: number;
}

interface BucketAccumulator {
  ticks: BucketTick[];
  coveredMs: number;
  classifiedMs: number;
}

/**
 * 把决策单元装配成 5 秒桶的 tick 流（§8.11）。
 *
 * - 单元跨桶按**交集毫秒**拆分（480 ms 与 5,000 ms 边界都是整数，交集必为整数）；
 * - 桶在「桶末 + 500 ms」之后封存；封存后迟到的单元只在 `lateDroppedMs` 记账，
 *   **不改已封存的桶**（其时间自然成为 unknown）；
 * - 缺测单元不产生 tick，因此不计入 coveredMs —— 桶记账层据此得到
 *   `categoryUnknownMs = 桶宽 − classifiedMs`、`validInferenceMs = coveredMs`。
 */
export class BucketTickAssembler {
  private readonly widthMs: number;
  private readonly waitMs: number;
  private readonly buckets = new Map<number, BucketAccumulator>();
  private readonly lateByBucket = new Map<number, number>();
  private sealedUpTo = -1;

  constructor(options: { bucketWidthMs?: number; waitMs?: number } = {}) {
    this.widthMs = options.bucketWidthMs ?? DECISION_BUCKET_WIDTH_MS;
    this.waitMs = options.waitMs ?? DECISION_BUCKET_WAIT_MS;
    if (!Number.isInteger(this.widthMs) || this.widthMs <= 0) {
      throw new Error(`ASSEMBLER_BAD_WIDTH: ${String(this.widthMs)}`);
    }
    if (!Number.isFinite(this.waitMs) || this.waitMs < 0) {
      throw new Error(`ASSEMBLER_BAD_WAIT: ${String(this.waitMs)}`);
    }
  }

  get pendingBucketIndexes(): number[] {
    return [...this.buckets.keys()].sort((a, b) => a - b);
  }

  /** 已封存桶之后再到的单元毫秒（按桶号），只能计 unknown/drop。 */
  get lateDroppedByBucket(): ReadonlyMap<number, number> {
    return new Map([...this.lateByBucket.entries()].sort((a, b) => a[0] - b[0]));
  }

  /** 迟到丢弃总毫秒。 */
  get lateDroppedMs(): number {
    let total = 0;
    for (const ms of this.lateByBucket.values()) total += ms;
    return total;
  }

  /** 送入一个已定稿单元。`arrivedAtMs` 省略时按"单元结束即到达"。 */
  pushCell(cell: DecisionCell, arrivedAtMs: number = cell.endMs): void {
    if (!Number.isInteger(cell.startMs) || !Number.isInteger(cell.endMs)) {
      throw new Error(`TICK_TIME_NOT_INTEGER: [${cell.startMs}, ${cell.endMs}]`);
    }
    if (!cell.validInference) return;
    const first = Math.floor(cell.startMs / this.widthMs);
    const last = Math.floor((cell.endMs - 1) / this.widthMs);
    let cursor = cell.startMs;
    for (let index = first; index <= last; index += 1) {
      const bucketStart = index * this.widthMs;
      const bucketEnd = bucketStart + this.widthMs;
      const segStart = Math.max(cursor, bucketStart);
      const segEnd = Math.min(cell.endMs, bucketEnd);
      const duration = segEnd - segStart;
      cursor = segEnd;
      if (duration <= 0) continue;
      if (index <= this.sealedUpTo || bucketEnd + this.waitMs <= arrivedAtMs) {
        // 桶已封存（或等待预算已过）：本次结果只能计 unknown/drop；**不重建已封存的桶**。
        this.lateByBucket.set(index, (this.lateByBucket.get(index) ?? 0) + duration);
        continue;
      }
      const bucket = this.ensure(index);
      bucket.ticks.push({
        durationMs: duration,
        categoryId: cell.categoryId,
        score: cell.categoryId === null ? 0 : cell.score,
      });
      bucket.coveredMs += duration;
      if (cell.categoryId !== null) bucket.classifiedMs += duration;
    }
  }

  /** 封存所有等待预算已过的桶（`桶末 + waitMs <= nowMs`），按桶序号升序返回。 */
  sealDue(nowMs: number): SealedBucketTicks[] {
    const due: number[] = [];
    for (const [index] of this.buckets) {
      if ((index + 1) * this.widthMs + this.waitMs <= nowMs) due.push(index);
    }
    due.sort((a, b) => a - b);
    return due.map((index) => this.seal(index));
  }

  /** 段结束：立即封存全部剩余桶（尾桶宽度仍按名义桶宽报告，由调用方按真实宽度换算）。 */
  flush(): SealedBucketTicks[] {
    const indexes = [...this.buckets.keys()].sort((a, b) => a - b);
    return indexes.map((index) => this.seal(index));
  }

  private ensure(index: number): BucketAccumulator {
    let bucket = this.buckets.get(index);
    if (!bucket) {
      bucket = { ticks: [], coveredMs: 0, classifiedMs: 0 };
      this.buckets.set(index, bucket);
    }
    return bucket;
  }

  private seal(index: number): SealedBucketTicks {
    const bucket = this.ensure(index);
    this.buckets.delete(index);
    if (index > this.sealedUpTo) this.sealedUpTo = index;
    const startOffsetMs = index * this.widthMs;
    return {
      bucketIndex: index,
      startOffsetMs,
      endOffsetMs: startOffsetMs + this.widthMs,
      widthMs: this.widthMs,
      ticks: bucket.ticks,
      coveredMs: bucket.coveredMs,
      classifiedMs: bucket.classifiedMs,
      uncoveredMs: this.widthMs - bucket.coveredMs,
    };
  }
}
