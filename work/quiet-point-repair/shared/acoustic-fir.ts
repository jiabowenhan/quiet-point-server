/**
 * 增强 A（正式生产预处理路径 `preproc-v2`）：任意 Fs → 16 kHz 的**有状态多相 Kaiser 窗 sinc**
 * 抗混叠重采样器。纯函数式、无 DOM/IO 依赖，Node 可单测。
 *
 * 权威依据（逐字对齐，不得放宽）：
 * - `work/SOL_STAGE45_ENHANCEMENT_PLAN.md` §3 P3 裁定：
 *   「Fs=16k 旁路；Fs>16k 使用多相/windowed-sinc、cutoff=7.5kHz、通带至7kHz、阻带自8kHz、
 *     Kaiser beta=7.86；tap 为不小于 0.00535×Fs 的最小奇数（48k 起点257）、1024分数相位、
 *     各相位 DC 归一化。跨块保持历史与相位，完整滤波支持区才输出，不补零制造启动静音；
 *     时间戳对应核中心，lookahead 约2.68ms不重复扣除。NaN/Inf、Fs变化、sequence/source-frame gap
 *     切断连续段。Fs<16k 拒绝分类。」
 *   「验收通带幅度误差≤0.2dB，≥8kHz阻带衰减≥60dB；不达标增加 tap 后重测，不删滤波。」
 * - `work/CODEX_DECISION_AI.md` §2.3/§2.4/§2.5：核 `h(d)=(2fc/Fs)·sinc(2fc·d/Fs)·Kaiser(d)`、
 *   1024 相位表、保留左右历史、中心核等待右侧 lookahead、环 64,000 点、窗 15,600、hop 7,680、
 *   连续段切断条件（sourceFrame/sequence 不连续或 source 停顿 >250ms）。
 *
 * 本模块只做重采样：不采音、不联网、不写文件、不做每窗 peak 归一化、不生成 Mel。
 *
 * 版本口径：使用本模块才是 `preproc-v2`；`shared/acoustic-resample.ts` 的线性实现是
 * `preproc-diag-linear-v1`（阶段2 诊断/对照），两者不得互相冒充（Sol §5.2）。
 */

/** 目标采样率：与原生 `SAMPLE_RATE_HZ` / YAMNet 输入契约一致。 */
export const FIR_TARGET_RATE_HZ = 16000;

/** 抗混叠低通的 cutoff（−6dB 点）。 */
export const FIR_CUTOFF_HZ = 7500;
/** 通带边界：≤7 kHz 必须平坦（验收点）。 */
export const FIR_PASSBAND_HZ = 7000;
/** 阻带边界：≥8 kHz 必须被抑制（验收点）。 */
export const FIR_STOPBAND_HZ = 8000;
/** Kaiser 窗 β（Sol §3 裁定值）。 */
export const FIR_KAISER_BETA = 7.86;
/** tap 下界比例：taps ≥ 0.00535×Fs（Sol §3 裁定值）。 */
export const FIR_MIN_TAP_RATIO = 0.00535;
/** 分数相位个数（Sol §3 裁定值）。 */
export const FIR_PHASE_COUNT = 1024;
/** source 停顿超过该值即切断连续段（CODEX_DECISION_AI §2.5）。 */
export const FIR_SOURCE_PAUSE_MS = 250;

/** 硬验收阈值（Sol §3：通带 ≤0.2 dB、阻带 ≥60 dB）。 */
export const FIR_PASSBAND_TOLERANCE_DB = 0.2;
export const FIR_STOPBAND_ATTENUATION_DB = 60;

// ---------------------------------------------------------------------------
// 系数生成（确定性：无随机、无时间戳、纯 Fs 的函数）
// ---------------------------------------------------------------------------

/** `taps = 不小于 0.00535×Fs 的最小奇数`（48 kHz → 257）。 */
export function tapsForRate(inputRateHz: number): number {
  if (!Number.isFinite(inputRateHz) || inputRateHz <= 0) {
    throw new Error(`FIR_BAD_RATE: ${String(inputRateHz)}`);
  }
  const lower = FIR_MIN_TAP_RATIO * inputRateHz;
  let taps = Math.ceil(lower);
  if (taps % 2 === 0) taps += 1;
  return taps;
}

/** 修正贝塞尔函数 I0（级数展开，确定性、无查表）。 */
export function besselI0(x: number): number {
  const half = x / 2;
  let term = 1;
  let sum = 1;
  for (let k = 1; k < 200; k += 1) {
    term *= (half / k) * (half / k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/** 对称 Kaiser 窗，`index ∈ [0, N)`，峰值在 (N−1)/2。 */
export function kaiserWindowAt(index: number, taps: number, beta: number): number {
  const m = (taps - 1) / 2;
  const r = (index - m) / m;
  const arg = 1 - r * r;
  if (arg <= 0) return 0;
  return besselI0(beta * Math.sqrt(arg)) / besselI0(beta);
}

/** 归一化 sinc：sin(πx)/(πx)，x=0 时为 1。 */
export function sinc(x: number): number {
  if (x === 0) return 1;
  const pix = Math.PI * x;
  return Math.sin(pix) / pix;
}

/**
 * 生成**全部 1024 个相位**的系数表（长度 `phaseCount × taps`，相位优先排列）。
 *
 * 设计（与 CODEX_DECISION_AI §2.3 的核公式一致）：
 *   1. 理想核 `h(d) = (2·fc/Fs)·sinc(2·fc·d/Fs)`，`fc = 7500 Hz`，`d` 以**输入样本**为单位；
 *   2. 窗按**整数**原型索引施加（`W[j]`，对称、全部 N 个 tap 均有效，不因分数相位出现零抽头）；
 *   3. 分数相位 `δ_p = p/1024`：`coef[p][j] = W[j]·h(j − M + δ_p)`；
 *   4. **逐相位 DC 归一化**（Σ_j coef = 1），保证任意相位对直流输入增益恒为 1。
 *
 * 确定性：同样的 `inputRateHz` 必然产生逐字节相同的 Float32Array；不读时钟、不读随机源。
 */
export function generateFirCoefficients(inputRateHz: number): Float32Array {
  if (inputRateHz === FIR_TARGET_RATE_HZ) {
    throw new Error('FIR_RATE_BYPASS: 16 kHz 无需滤波（Sol §3 规定旁路）');
  }
  const taps = tapsForRate(inputRateHz);
  const m = (taps - 1) / 2;
  const fcNorm = FIR_CUTOFF_HZ / inputRateHz;
  const win = new Float64Array(taps);
  for (let j = 0; j < taps; j += 1) win[j] = kaiserWindowAt(j, taps, FIR_KAISER_BETA);

  const out = new Float32Array(FIR_PHASE_COUNT * taps);
  for (let p = 0; p < FIR_PHASE_COUNT; p += 1) {
    const delta = p / FIR_PHASE_COUNT;
    let sum = 0;
    for (let j = 0; j < taps; j += 1) {
      const d = j - m + delta;
      const v = win[j] * 2 * fcNorm * sinc(2 * fcNorm * d);
      out[p * taps + j] = v;
      sum += v;
    }
    if (!(Math.abs(sum) > 1e-12)) {
      throw new Error(`FIR_PHASE_DC_INVALID: 相位 ${p} 的系数和为 ${String(sum)}`);
    }
    const inv = 1 / sum;
    for (let j = 0; j < taps; j += 1) {
      const idx = p * taps + j;
      out[idx] = (out[idx] as number) * inv;
    }
  }
  return out;
}

export interface FirPhaseTable {
  readonly inputRateHz: number;
  readonly outputRateHz: number;
  readonly taps: number;
  /** 单边抽头数 (taps−1)/2：核中心左右各 M 个输入样本。 */
  readonly halfTaps: number;
  readonly phaseCount: number;
  /** 相位优先排列的系数（`phaseCount × taps`）。 */
  readonly coefficients: Float32Array;
  /** 核中心等待的右侧 lookahead（输入样本数 = halfTaps）。 */
  readonly lookaheadSamples: number;
  /** lookahead 的毫秒值（= halfTaps/Fs×1000；48 kHz/257 tap ≈ 2.67 ms）。 */
  readonly lookaheadMs: number;
  /** 相位表字节数（诊断/内存口径）。 */
  readonly bytes: number;
}

const tableCache = new Map<number, FirPhaseTable>();
const TABLE_CACHE_LIMIT = 4;

/** 取（并缓存）某输入采样率的相位表。缓存是纯函数结果的复用，不影响确定性。 */
export function firPhaseTable(inputRateHz: number): FirPhaseTable {
  const cached = tableCache.get(inputRateHz);
  if (cached) return cached;
  if (inputRateHz === FIR_TARGET_RATE_HZ) {
    throw new Error('FIR_RATE_BYPASS: 16 kHz 走旁路，不构建相位表');
  }
  const coefficients = generateFirCoefficients(inputRateHz);
  const taps = tapsForRate(inputRateHz);
  const halfTaps = (taps - 1) / 2;
  const table: FirPhaseTable = Object.freeze({
    inputRateHz,
    outputRateHz: FIR_TARGET_RATE_HZ,
    taps,
    halfTaps,
    phaseCount: FIR_PHASE_COUNT,
    coefficients,
    lookaheadSamples: halfTaps,
    lookaheadMs: (halfTaps / inputRateHz) * 1000,
    bytes: coefficients.byteLength,
  });
  if (tableCache.size >= TABLE_CACHE_LIMIT) {
    const oldest = tableCache.keys().next();
    if (!oldest.done) tableCache.delete(oldest.value);
  }
  tableCache.set(inputRateHz, table);
  return table;
}

// ---------------------------------------------------------------------------
// 流式重采样器
// ---------------------------------------------------------------------------

/** 供调用方附带的分块元数据（来自 AudioWorklet 的 generation/sequence/firstSourceFrame）。 */
export interface FirPushMeta {
  /** 同一 generation 内单调 +1 的块序号（uint32 回绕安全）。 */
  sequence?: number;
  /** 本块第一个样本的**绝对** source frame 索引。 */
  firstSourceFrame?: number;
  /** 采集世代；变化即切断连续段。 */
  generation?: number;
  /** 块的单调时刻（毫秒）；与上一块相差 >250 ms 即切断连续段。 */
  nowMs?: number;
  /** 块的实际输入采样率；与本实例不一致时显式失败（须新建实例并另起段）。 */
  inputRateHz?: number;
}

/** 只读诊断计数（诚实计数，不静默丢弃）。 */
export interface FirDiagnostics {
  /** 累计接收的输入样本数。 */
  inputSamples: number;
  /** 累计输出的 16 kHz 样本数。 */
  outputSamples: number;
  /** 因 FIR 振铃超界被 clamp 到 [-1,1] 的输出样本数（→ 上游 resampleClampCount）。 */
  clampCount: number;
  /** 因连续段切断而**未参与任何完整核**的输入样本数（段首跳过 + 段尾残段）。 */
  droppedSamples: number;
  /** 已开始的连续段数（首段 + 每次 gap/停顿/Fs 变化后的新段）。 */
  segmentsStarted: number;
  /** 已结束的连续段数。 */
  segmentsEnded: number;
  /** 触发断段的次数（按原因累计，含显式 endSegment）。 */
  gapCount: number;
  /** 输入绝对值 >1 的样本数（下混应保证 [-1,1]；此处只计数不静默改写）。 */
  inputOutOfRangeCount: number;
  /** 最近一次输出的段内序号（时间戳 = 序号×ratio/Fs，对应核中心）。 */
  lastOutputSampleIndex: number;
  /** 当前连续段首样本的绝对 source frame 索引；无活动段时为 null。 */
  segmentStartSourceFrame: number | null;
}

interface SegmentState {
  /** 段首样本的绝对输入索引。 */
  startAbs: number;
  /** 段内下一个待输出样本序号。 */
  nextOut: number;
  /** 是否已产生过本段第一个输出（用于统计段首跳过的样本）。 */
  firstEmitted: boolean;
  /** 段内底座：缓冲区第 0 个有效样本的绝对输入索引。 */
  bufAbsStart: number;
  /** 段内缓冲的有效样本数。 */
  bufLen: number;
  buf: Float32Array;
  /** 段内已推送的最后一个样本的绝对索引（= bufAbsStart + bufLen − 1）。 */
  lastAbsPushed: number;
}

/**
 * 有状态抗混叠重采样器：任意 Fs（≥16 kHz）→ 16 kHz。
 *
 * 典型用法：
 * ```ts
 * const r = new AntiAliasResampler16k(context.sampleRate);
 * const out = r.push(chunk, { sequence, firstSourceFrame, nowMs: performance.now() });
 * ```
 *
 * 不变量：
 * - **只在完整滤波支持区内输出**：输出样本 k 的核覆盖输入区间
 *   `[f−M, f+M]`（f = floor(k·ratio)、M = (taps−1)/2），该区间必须完全落在当前连续段已收到的样本里；
 *   否则不输出（**绝不补零**，也不制造启动静音）；
 * - 输出时间戳对应**核中心**：`t_ms = k·ratio/Fs×1000`（相对段首），不再另扣延迟；
 * - 段首需要 `ceil(M/ratio)` 个输出位置的等待（48 kHz ≈ 2.67 ms），段尾残余 M 个样本在段结束时计入
 *   `droppedSamples`；
 * - 输入出现 NaN/Inf → 显式抛错；Fs<16 kHz → 构造即拒绝（第一版不分类）。
 */
export class AntiAliasResampler16k {
  readonly inputRateHz: number;
  readonly outputRateHz = FIR_TARGET_RATE_HZ;
  readonly bypass: boolean;
  private readonly ratio: number;
  private readonly taps: number;
  private readonly M: number;
  private readonly coefficients: Float32Array | null;

  private seg: SegmentState | null = null;
  private lastSequence: number | null = null;
  private lastSourceFrameEnd: number | null = null;
  private lastGeneration: number | null = null;
  private lastNowMs: number | null = null;

  private inputSamples = 0;
  private outputSamples = 0;
  private clampCount = 0;
  private droppedSamples = 0;
  private segmentsStarted = 0;
  private segmentsEnded = 0;
  private gapCount = 0;
  private inputOutOfRangeCount = 0;
  private lastOutputSampleIndex = -1;

  constructor(inputRateHz: number) {
    if (!Number.isFinite(inputRateHz) || inputRateHz <= 0 || !Number.isInteger(inputRateHz)) {
      throw new Error(`FIR_BAD_RATE: 采样率必须是正的有限整数，实际 ${String(inputRateHz)}`);
    }
    if (inputRateHz < FIR_TARGET_RATE_HZ) {
      // 与线性诊断实现同一诚实边界：升采样不能凭空造出 8k 以上的信息。
      throw new Error(
        `FIR_RATE_UNSUPPORTED: 输入采样率 ${inputRateHz} Hz 低于目标 ${FIR_TARGET_RATE_HZ} Hz，` +
          '第一版拒绝分类（INPUT_RATE_UNSUPPORTED）',
      );
    }
    this.inputRateHz = inputRateHz;
    this.bypass = inputRateHz === FIR_TARGET_RATE_HZ;
    this.ratio = inputRateHz / FIR_TARGET_RATE_HZ;
    const table = this.bypass ? null : firPhaseTable(inputRateHz);
    this.taps = table ? table.taps : 0;
    this.M = table ? table.halfTaps : 0;
    this.coefficients = table ? table.coefficients : null;
  }

  /** 每产生一个输出样本需要的输入样本数（1 = 旁路）。 */
  get step(): number {
    return this.ratio;
  }

  /** 抽头数（旁路时为 0）。 */
  get tapCount(): number {
    return this.taps;
  }

  /** 右侧 lookahead（输入样本数；旁路为 0）。 */
  get lookaheadSamples(): number {
    return this.M;
  }

  /** 右侧 lookahead（毫秒；48 kHz/257 tap ≈ 2.67 ms）。 */
  get lookaheadMs(): number {
    return (this.M / this.inputRateHz) * 1000;
  }

  /** 相位表字节数（旁路为 0）。 */
  get coefficientBytes(): number {
    return this.coefficients ? this.coefficients.byteLength : 0;
  }

  /** 输出序号 k 对应的时间偏移（毫秒，相对段首；核中心口径）。 */
  outputTimeOffsetMs(k: number): number {
    return ((k * this.ratio) / this.inputRateHz) * 1000;
  }

  /** 只读诊断快照。 */
  get diagnostics(): FirDiagnostics {
    return Object.freeze({
      inputSamples: this.inputSamples,
      outputSamples: this.outputSamples,
      clampCount: this.clampCount,
      droppedSamples: this.droppedSamples,
      segmentsStarted: this.segmentsStarted,
      segmentsEnded: this.segmentsEnded,
      gapCount: this.gapCount,
      inputOutOfRangeCount: this.inputOutOfRangeCount,
      lastOutputSampleIndex: this.lastOutputSampleIndex,
      segmentStartSourceFrame: this.seg ? this.seg.startAbs : null,
    });
  }

  /** 主动切断连续段（停尾、源停顿、切后台等）；段尾未成核的样本计入 droppedSamples。 */
  endSegment(_reason?: string): void {
    this.cutSegment();
  }

  /**
   * 推入一块输入，返回本块新产生的 16 kHz 样本（新分配，调用方可安全持有）。
   * 输入含 NaN/Inf 时抛错；不静默跳过、不按 0 处理。
   */
  push(input: Float32Array, meta: FirPushMeta = {}): Float32Array {
    if (!(input instanceof Float32Array)) {
      throw new Error('FIR_INPUT_TYPE: push 只接受 Float32Array（不做隐式转换）');
    }
    if (input.length === 0) return new Float32Array(0);
    for (let i = 0; i < input.length; i += 1) {
      const v = input[i] as number;
      if (!Number.isFinite(v)) {
        throw new Error(`FIR_INPUT_NOT_FINITE: 第 ${i} 个样本为 ${String(v)}，拒绝把 NaN 当静音`);
      }
      if (v > 1 || v < -1) this.inputOutOfRangeCount += 1;
    }
    if (meta.inputRateHz !== undefined && meta.inputRateHz !== this.inputRateHz) {
      throw new Error(
        `FIR_RATE_CHANGED: 实例 Fs=${this.inputRateHz}，本块 Fs=${meta.inputRateHz}；` +
          '须新建重采样器并另起连续段（不得跨 Fs 续接相位/历史）',
      );
    }

    this.applyMeta(meta, input.length);
    this.inputSamples += input.length;

    if (this.bypass) {
      // 16 kHz 旁路：逐点透传，无相位/历史/等待。
      if (!this.seg) this.openSegment(meta.firstSourceFrame ?? 0);
      const copy = input.slice();
      this.outputSamples += copy.length;
      const seg = this.seg as SegmentState;
      this.lastOutputSampleIndex = seg.nextOut + copy.length - 1;
      seg.nextOut += copy.length;
      return copy;
    }

    if (!this.seg) {
      this.openSegment(meta.firstSourceFrame ?? this.lastSourceFrameEnd ?? 0);
    }
    return this.filterChunk(input);
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  private applyMeta(meta: FirPushMeta, length: number): void {
    if (meta.generation !== undefined) {
      if (this.lastGeneration !== null && meta.generation !== this.lastGeneration) {
        this.gapCount += 1;
        this.cutSegment();
      }
      this.lastGeneration = meta.generation;
    }
    if (meta.sequence !== undefined) {
      const expected = this.lastSequence === null ? null : (this.lastSequence + 1) >>> 0;
      if (expected !== null && meta.sequence !== expected) {
        this.gapCount += 1;
        this.cutSegment();
      }
      this.lastSequence = meta.sequence;
    }
    if (meta.firstSourceFrame !== undefined) {
      if (this.lastSourceFrameEnd !== null && meta.firstSourceFrame !== this.lastSourceFrameEnd) {
        this.gapCount += 1;
        this.cutSegment();
      }
      this.lastSourceFrameEnd = meta.firstSourceFrame + length;
    } else if (this.lastSourceFrameEnd !== null) {
      this.lastSourceFrameEnd += length;
    }
    if (meta.nowMs !== undefined) {
      if (this.lastNowMs !== null && meta.nowMs - this.lastNowMs > FIR_SOURCE_PAUSE_MS) {
        this.gapCount += 1;
        this.cutSegment();
      }
      this.lastNowMs = meta.nowMs;
    }
  }

  private openSegment(startAbs: number): void {
    this.seg = {
      startAbs,
      nextOut: 0,
      firstEmitted: false,
      bufAbsStart: startAbs,
      bufLen: 0,
      buf: new Float32Array(0),
      lastAbsPushed: startAbs - 1,
    };
    this.segmentsStarted += 1;
  }

  /** 切断/结束当前连续段：缓冲区里未参与完整核的样本计入 droppedSamples。 */
  private cutSegment(): void {
    const seg = this.seg;
    if (seg) {
      if (!seg.firstEmitted) {
        // 整段都没有产出过任何完整核：全部样本未参与输出。
        this.droppedSamples += seg.bufLen;
      } else {
        // 段尾残余：最后一次输出的核右沿之后的样本从未参与任何完整核。
        const lastF = Math.floor(this.lastOutputSampleIndex * this.ratio);
        const usedThrough = seg.startAbs + lastF + this.M;
        const tail = seg.lastAbsPushed - usedThrough;
        if (tail > 0) this.droppedSamples += tail;
      }
      this.segmentsEnded += 1;
    }
    this.seg = null;
    this.lastOutputSampleIndex = -1;
  }

  /** 追加输入到段缓冲并产出所有支持区完整的输出。 */
  private filterChunk(input: Float32Array): Float32Array {
    const seg = this.seg as SegmentState;
    const next = new Float32Array(seg.bufLen + input.length);
    if (seg.bufLen > 0) next.set(seg.buf.subarray(0, seg.bufLen), 0);
    next.set(input, seg.bufLen);
    seg.buf = next;
    seg.bufLen += input.length;
    seg.lastAbsPushed = seg.bufAbsStart + seg.bufLen - 1;

    const coefficients = this.coefficients as Float32Array;
    const n = this.taps;
    const m = this.M;
    const ratio = this.ratio;

    // 第一遍：确定本次能产出多少个完整支持区的输出。
    let k = seg.nextOut;
    let count = 0;
    let firstK = -1;
    while (true) {
      const x = k * ratio;
      const f = Math.floor(x);
      if (f < m) {
        // 左侧历史不足：不补零，跳过该输出位置。
        k += 1;
        if (k - seg.nextOut > 4096) break;
        continue;
      }
      if (seg.startAbs + f + m > seg.lastAbsPushed) break;
      if (firstK < 0) firstK = k;
      k += 1;
      count += 1;
    }
    if (count === 0) {
      this.trim(seg);
      return new Float32Array(0);
    }

    const out = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      const kk = firstK + i;
      let f = Math.floor(kk * ratio);
      const delta = kk * ratio - f;
      let p = Math.round(delta * FIR_PHASE_COUNT);
      if (p >= FIR_PHASE_COUNT) {
        p = 0;
        f += 1;
      }
      const base = p * n;
      const idx = seg.startAbs + f + m - seg.bufAbsStart;
      let y = 0;
      for (let j = 0; j < n; j += 1) {
        y += (coefficients[base + j] as number) * (seg.buf[idx - j] as number);
      }
      if (y > 1) {
        y = 1;
        this.clampCount += 1;
      } else if (y < -1) {
        y = -1;
        this.clampCount += 1;
      }
      out[i] = y;
    }

    if (!seg.firstEmitted) {
      // 段首被跳过的样本（首个完整核左沿之前的样本）从未参与输出。
      this.droppedSamples += firstK - m > 0 ? firstK - m : 0;
      seg.firstEmitted = true;
    }
    seg.nextOut = k;
    this.lastOutputSampleIndex = k - 1;
    this.outputSamples += count;
    this.trim(seg);
    return out;
  }

  /** 丢弃下一个输出不再需要的左侧历史。 */
  private trim(seg: SegmentState): void {
    const fNext = Math.floor(seg.nextOut * this.ratio);
    const keepAbs = seg.startAbs + Math.max(0, fNext - this.M);
    const drop = keepAbs - seg.bufAbsStart;
    if (drop <= 0) return;
    const keep = Math.max(0, seg.bufLen - drop);
    if (keep === 0) {
      seg.bufAbsStart = seg.lastAbsPushed + 1;
      seg.bufLen = 0;
      seg.buf = new Float32Array(0);
      return;
    }
    const fresh = new Float32Array(keep);
    fresh.set(seg.buf.subarray(drop, drop + keep), 0);
    seg.buf = fresh;
    seg.bufLen = keep;
    seg.bufAbsStart = keepAbs;
  }
}

/**
 * 频响测量辅助（测试与诊断共用）：在稳态输出上测某频率分量的幅度。
 * 返回值以**输入正弦幅度 1** 为基准的线性幅度（1 = 通过，0 = 完全抑制）。
 * 输出必须覆盖整数个周期（`freqHz × n / 16000 ∈ ℤ`）以免泄漏。
 */
export function measureToneAmplitude(output: Float32Array, freqHz: number, rateHz = FIR_TARGET_RATE_HZ): number {
  const w = (2 * Math.PI * freqHz) / rateHz;
  let re = 0;
  let im = 0;
  for (let i = 0; i < output.length; i += 1) {
    const v = output[i] as number;
    re += v * Math.cos(w * i);
    im += v * Math.sin(w * i);
  }
  return (2 * Math.sqrt(re * re + im * im)) / output.length;
}
