/**
 * 阶段2 真机接线：16 kHz 重采样（纯函数式，无 DOM 依赖，Node 可单测）。
 *
 * 为什么需要它：
 * - YAMNet/TFLite 的输入契约是 **16 kHz 单声道 waveform**（原生 `WINDOW_SAMPLES = 15600`）；
 * - Android WebView 的 `AudioContext` 实际采样率通常是 48000（偶尔 44100），**不能直接喂进去**，
 *   否则等于把 0.325 秒的音频当成 0.975 秒，频率与时长全错。
 *
 * 本模块只做一件事：把任意输入采样率的连续块，用**线性插值**重采样到 16 kHz，
 * 且跨块保持分数位置连续（分块结果与整段结果一致 —— 由 tests/acoustic-resample.test.ts 断言）。
 *
 * 边界与诚实性：
 * - 输入采样率低于 16 kHz 直接构造失败（不静默升采样，不假装能分类）；
 * - 输入采样率恰为 16 kHz 时原样透传（不做无意义的插值）；
 * - 模块不采音、不联网、不写文件。
 */

/** 目标采样率：与原生 `SAMPLE_RATE_HZ` 一致。 */
export const ACOUSTIC_TARGET_RATE_HZ = 16000;

/**
 * 单个 YAMNet patch 的样本数：96×160+400 = 15600（0.975 s @16 kHz）。
 * 与原生 `AcousticInferencePlugin.WINDOW_SAMPLES` 是同一个契约值；
 * `app/acoustic-capture.ts` 在启动时会与 bridge 的常量做一致性断言，防止两边静默漂移。
 */
export const ACOUSTIC_WINDOW_SAMPLES = 15600;

/**
 * 线性插值重采样器（流式）。典型用法：
 * ```ts
 * const r = new LinearResampler16k(context.sampleRate);
 * const out16k = r.push(chunk48k);   // 每次拿到可以继续累积的输出
 * ```
 */
export class LinearResampler16k {
  /** 输入/输出采样率之比：每产生一个输出样本，输入位置前进 ratio。 */
  private readonly ratio: number;
  /** 透传模式（输入已是 16 kHz）。 */
  private readonly passthrough: boolean;
  /** 上一块末尾保留的样本（保证插值跨块连续）。 */
  private carry: Float32Array;
  /** 下一个输出样本在 carry 中的分数位置。 */
  private pos: number;
  /** 累计输出样本数（诊断用）。 */
  private produced: number;
  /** 累计输入样本数（诊断用）。 */
  private consumed: number;

  constructor(inputRateHz: number) {
    if (!Number.isFinite(inputRateHz) || inputRateHz <= 0) {
      throw new Error(`输入采样率非法：${String(inputRateHz)}`);
    }
    if (inputRateHz < ACOUSTIC_TARGET_RATE_HZ) {
      throw new Error(
        `输入采样率 ${inputRateHz} Hz 低于目标 ${ACOUSTIC_TARGET_RATE_HZ} Hz：拒绝升采样假装可分类`,
      );
    }
    this.ratio = inputRateHz / ACOUSTIC_TARGET_RATE_HZ;
    this.passthrough = this.ratio === 1;
    this.carry = new Float32Array(0);
    this.pos = 0;
    this.produced = 0;
    this.consumed = 0;
  }

  /** 每产生一个输出样本需要的输入样本数（1 = 已是目标采样率）。 */
  get step(): number {
    return this.ratio;
  }

  get inputSamples(): number {
    return this.consumed;
  }

  get outputSamples(): number {
    return this.produced;
  }

  /**
   * 推入一块输入，返回本块新产生的 16 kHz 样本。
   * 返回的 Float32Array 是**新分配**的（调用方可安全持有）。
   */
  push(input: Float32Array): Float32Array {
    if (input.length === 0) {
      return new Float32Array(0);
    }
    this.consumed += input.length;
    if (this.passthrough) {
      const copy = input.slice();
      this.produced += copy.length;
      return copy;
    }

    const buf = new Float32Array(this.carry.length + input.length);
    buf.set(this.carry, 0);
    buf.set(input, this.carry.length);

    const out: number[] = [];
    let p = this.pos;
    // 需要 i 与 i+1 两个输入样本，故上界是 length-2。
    while (p <= buf.length - 2) {
      const i = Math.floor(p);
      const frac = p - i;
      const a = buf[i] as number;
      const b = buf[i + 1] as number;
      out.push(a + (b - a) * frac);
      p += this.ratio;
    }

    // 保留最后一个输入样本及其后的余量，供下一块继续插值。
    const keepFrom = Math.max(0, Math.min(Math.floor(p), buf.length - 1));
    this.carry = buf.slice(keepFrom);
    this.pos = p - keepFrom;

    const result = Float32Array.from(out);
    this.produced += result.length;
    return result;
  }
}

/**
 * 累积定长 patch 的辅助器：把连续输出切成恰好 `patchSize` 的块。
 * 不满足一整块时留在内部，等下一次 push（不做零填充 —— 零填充会伪造静音段）。
 */
export class PatchAccumulator {
  private readonly patchSize: number;
  private buffer: Float32Array;
  private filled: number;
  /** 因调用方未能及时取走而丢弃的整块数（诚实计数，不静默）。 */
  private dropped: number;

  constructor(patchSize: number) {
    if (!Number.isInteger(patchSize) || patchSize <= 0) {
      throw new Error(`patchSize 非法：${String(patchSize)}`);
    }
    this.patchSize = patchSize;
    this.buffer = new Float32Array(patchSize);
    this.filled = 0;
    this.dropped = 0;
  }

  /** 当前已累积但未成块的样本数。 */
  get pending(): number {
    return this.filled;
  }

  get droppedPatches(): number {
    return this.dropped;
  }

  /**
   * 推入样本，回调每一个成形的整块。
   * `onPatch` 返回 `false` 表示消费方未接住（例如上一次推理还在飞），本块计入 dropped。
   */
  push(samples: Float32Array, onPatch: (patch: Float32Array) => boolean): void {
    let offset = 0;
    while (offset < samples.length) {
      const need = this.patchSize - this.filled;
      const take = Math.min(need, samples.length - offset);
      this.buffer.set(samples.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.patchSize) {
        const accepted = onPatch(this.buffer.slice());
        if (!accepted) {
          this.dropped += 1;
        }
        this.filled = 0;
      }
    }
  }

  /** 清空未成块的余量（停止采样时调用；不产生 patch）。 */
  reset(): void {
    this.filled = 0;
  }
}
