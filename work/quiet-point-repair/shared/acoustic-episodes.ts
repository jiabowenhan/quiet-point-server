/**
 * A-Q6：**与 Worker 生命周期独立**的会话级 episode 状态机 + checkpoint 纯类型。
 *
 * 权威依据：`work\SOL_ENHANCE_A_INTEGRATION_PROMPT.md`（Sol 增强 A 集成施工 Prompt）
 *   §R6「A-Q6 会话级状态机语义」、§R7「冲突①裁定：稳定标识 ↔ DTO UUID 与持久化」、
 *   以及 `work\SOL_BASE_ACCEPTANCE_2.md`（A-Q6 行）、`work\SOL_BASE_ACCEPTANCE_4.md` §4。
 *
 * 职责边界（Sol §FILES TO MODIFY 第 4 行逐字）：本文件只提供
 * 「会话级 A-Q6 状态机、checkpoint 纯类型、转换/裁剪函数；**不访问存储、网络、UUID 或设备**」。
 *   - UUID 由调用方注入（`newUuid`，默认 `crypto.randomUUID`），本文件**不生成**身份外的持久化；
 *   - 不做 IO、不读时钟、不读随机源（除注入的 UUID 生成器）；
 *   - 不解析 PCM、不持有波形、不 import FIR/决策模块。
 *
 * ## 两条硬约束（来自 Sol R6/R7/R8，逐条对齐）
 *
 * 1. **episode 身份只在「已验决策确认转入合格类别」时由会话 owner 分配一次**；
 *    序号 `episodeSeq` 从 1 开始、会话内严格递增、**永不复用**（pending/已结束/已 ACK 都不回收）；
 *    稳定标识精确为 `${sessionId}:A-Q6:${episodeSeq}`。
 * 2. **DTO `episodeId` 必须是 UUID**（`shared/study-model.ts::bucketSchema` 既有校验，**未改动**），
 *    由 `newUuid()` 生成并与 stableId 一对一绑定后写入 checkpoint。
 *    禁止把稳定字符串、其 base64 或任何非 UUID hash 填进 `episodeId`。
 * 3. **原有效性谓词不变**：沿用旧 `buildBucket()` 的「同一类别连续 ≥2 个有效 tick」口径
 *    （`A_Q6_MIN_VALID_TICKS`），不得替换为「≥2 个重叠推理窗」——共享窗口前 495 ms 不是新的独立持续证据。
 *    确认转入与达到有效性门槛可能同步、也可能先后发生：未达门槛留 `confirmed-pending`，**不向桶导出**。
 * 4. **leftCensored 只改变起点可知性**：不豁免确认与有效性门槛，且服务端 `interruptionCount`
 *    只统计 `kind==='confirmed'` 的 episodeId，故 `counted = valid && !leftCensored`，
 *    客户端 `uniqueEpisodeCount` 与服务端口径恒等。
 */

import { type CategoryId } from './acoustic-categories.js';

/** 稳定标识命名空间段（Sol §R7 逐字：`${sessionId}:A-Q6:${episodeSeq}`）。 */
export const A_Q6_NAMESPACE = 'A-Q6';

/** 原有效性谓词：同一类别连续有效 tick 数下限（沿用旧 `buildBucket()` 的 2）。 */
export const A_Q6_MIN_VALID_TICKS = 2;

/** 单元时长（`DECISION_CELL_MS` 的镜像，只用于注释与断言，不参与计算）。 */
export const A_Q6_CELL_MS = 480;

/**
 * 允许建立 episode 的类别（「疑似干扰片段」口径）。
 *
 * 排除三项，理由逐条可核验：
 * - `quiet` —— `shared/acoustic-map.ts` 给它 `gate:'state'`（声级状态，**不是**被分类的事件）；
 *   §8.9「quiet 不与实质类同列」。服务端 `interruptionCount` 对**全部** `confirmed` episodeId 去重，
 *   若把安静段当 confirmed episode 入桶，就会把「安静」伪造成「疑似干扰片段」。
 * - `background` —— `DECISION_LABEL_CANDIDATES` 已把它排除出分数驱动标签候选
 *   （见 `work/REPAIR_ENHANCE_A_LOGIC_REPORT.md` §6-④）。
 * - `other` —— 「类别未确认」的兜底，不是可指认的干扰事件。
 *
 * 该集合是本执行者按上列依据确定的**保守默认**，已在集成报告中列为待 Sol 裁定项；
 * 它不是契约字段，改动只影响本模块的判定。
 */
export const EPISODE_INTERFERENCE_CATEGORIES: readonly CategoryId[] = Object.freeze([
  'paper',
  'whisper',
  'conversation',
  'chair_drag',
  'impact',
  'ring',
  'cough',
  'footstep',
  'keyboard',
] as CategoryId[]);

const INTERFERENCE = new Set<string>(EPISODE_INTERFERENCE_CATEGORIES);

/** 该类别是否合格为「疑似干扰片段」（Sol §R6「确认转入**合格类别**」）。 */
export function isEpisodeEligibleCategory(categoryId: CategoryId): boolean {
  return INTERFERENCE.has(categoryId);
}

/** checkpoint 版本。 */
export const ACOUSTIC_CHECKPOINT_VERSION = 1 as const;

/** `committedTransitionKeys` 的保留上限（超出丢最旧；去重主要靠决策游标）。 */
export const A_Q6_TRANSITION_KEY_LIMIT = 512;

/** episode 生命周期（Sol §R6 表格）。 */
export type EpisodeStatus = 'confirmed-pending' | 'active' | 'ended';

/** 状态机当前态（Sol §R6：「状态至少为 IDLE / CANDIDATE / CONFIRMED_PENDING / ACTIVE」）。 */
export type EpisodeSegmentState = 'IDLE' | 'CANDIDATE' | 'CONFIRMED_PENDING' | 'ACTIVE';

/** 一个已定稿决策单元（只取 A-Q6 判定所需字段）。 */
export interface EpisodeCell {
  /** 采集世代（主线程分配；重开/断段后递增）。 */
  generation: number;
  /** 该单元末尾在 16 kHz 域上的绝对样本号（幂等游标）。 */
  endSample16k: number;
  /** Worker 提供的「转入去重键」；用于重放 no-op。 */
  transitionKey: string;
  /** 单元起点（相对会话起点，整数毫秒）。 */
  startMs: number;
  /** 单元终点（半开区间，整数毫秒）。 */
  endMs: number;
  /** 本单元是否有一次真实有效推理；false = 缺测 → 断证据。 */
  validInference: boolean;
  /** 是否为迟滞/双窗**确认**的稳定标签；false = 未确认候选 → 只更新 candidate。 */
  confirmed: boolean;
  /** 确认类别；null = 本次推理未确认任何类别。 */
  categoryId: CategoryId | null;
}

/** checkpoint 里的单条 episode 记录（Sol §R7 的 `AcousticSessionCheckpointV1.episodes` 条目）。 */
export interface EpisodeCheckpointEntry {
  episodeSeq: number;
  stableId: string;
  dtoEpisodeId: string;
  category: CategoryId;
  startMs: number;
  knownEndMs: number;
  leftCensored: boolean;
  counted: boolean;
  status: EpisodeStatus;
  endReason: string | null;
  transitionKey: string;
  /** 原有效性谓词所需状态：连续有效 tick 数。 */
  consecutiveTicks: number;
  /** 是否已达到有效性门槛（达标即可向桶导出）。 */
  valid: boolean;
}

/**
 * 最小客户端 checkpoint（Sol §R7 逐字结构）。
 * **不含任何 PCM、波形、窗口、FIR 历史、完整 scores、base64 或可重建音频的特征。**
 */
export interface AcousticSessionCheckpointV1 {
  version: 1;
  sessionId: string;
  /** 已使用序号高水位（pending/已结束/已 ACK 都不回收）。 */
  episodeSeqHighWater: number;
  uniqueEpisodeCount: number;
  lastCommittedDecisionCursor: { generation: number; endSample16k: number } | null;
  committedTransitionKeys: string[];
  continuity: { generation: number; sourceFrameEnd: number; actualSampleRate: number } | null;
  episodes: EpisodeCheckpointEntry[];
}

/** 交给桶 DTO `episodes[]` 的裁剪引用（Sol §R8：只求已知区间与桶的非空交集）。 */
export interface EpisodeRef {
  episodeId: string;
  /** 桶内相对偏移（半开区间起点）——服务端不变量「episode 起点在桶内」。 */
  startOffsetMs: number;
  kind: 'confirmed' | 'leftCensored';
}

export interface SessionEpisodeStateOptions {
  sessionId: string;
  /** DTO UUID 生成器（默认 `globalThis.crypto.randomUUID`）；注入便于测试确定性。 */
  newUuid?: () => string;
  /** 有效性门槛的连续 tick 数（默认 `A_Q6_MIN_VALID_TICKS`）。 */
  minValidTicks?: number;
}

export interface ObserveOutcome {
  /** 该单元是否被忽略（重放/游标倒退）——重放必须 no-op。 */
  replayed: boolean;
  /** 本次是否发生了「确认转入」并分配了新身份。 */
  transitioned: boolean;
  /** 本次是否发生 counted 由 false→true 的原子提交。 */
  countedNow: boolean;
  /** 新建立/被提升的 episode 序号（没有则 null）。 */
  episodeSeq: number | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 稳定标识 `${sessionId}:A-Q6:${episodeSeq}`（Sol §R7 精确格式）。 */
export function stableEpisodeId(sessionId: string, episodeSeq: number): string {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('A_Q6_BAD_SESSION: sessionId 必须是非空字符串');
  }
  if (!Number.isInteger(episodeSeq) || episodeSeq < 1) {
    throw new Error(`A_Q6_BAD_SEQ: episodeSeq 必须是从 1 开始的整数，实际 ${String(episodeSeq)}`);
  }
  return `${sessionId}:${A_Q6_NAMESPACE}:${episodeSeq}`;
}

/**
 * 会话级 A-Q6 状态机（主线程唯一 owner，Sol §FILES TO MODIFY 第 6 行）。
 *
 * 调用顺序：先 `restore(checkpoint)`（若有），再按时间**串行** `observe(cell)`；
 * 桶提交前用 `episodeRefsForBucket()` 取裁剪引用，并在**同一次原子提交**里保存 `checkpoint()`。
 */
export class SessionEpisodeState {
  readonly sessionId: string;
  private readonly newUuid: () => string;
  private readonly minValidTicks: number;

  private seqHighWater = 0;
  private uniqueCount = 0;
  private entries: EpisodeCheckpointEntry[] = [];
  private transitionKeys: string[] = [];
  private cursor: { generation: number; endSample16k: number } | null = null;
  private continuity: { generation: number; sourceFrameEnd: number; actualSampleRate: number } | null = null;
  /**
   * A-B04-G：已到达但**尚未轮到自己**的真实缺口（按 16 kHz 断点定序）。
   *
   * 缺口由 Worker 在源头发现，但 Worker 的定稿单元是**按桶批量上送**的：缺口前已缓存的单元
   * 会在缺口**之后**才随下一个桶到达主线程。若按到达顺序立刻闭合旧段，这些单元就会在 IDLE
   * 之后重开一个跨缺口的新段（真机证据：一个 UUID 贯穿 27 个 GAP、26 桶）。故缺口排队等待
   * 「首个 endSample16k 严格大于断点」的单元，在它之前生效——与定稿单元的时间顺序一致。
   */
  private pendingGaps: {
    reason: string;
    breakSample16k: number;
    continuity: { generation: number; sourceFrameEnd: number; actualSampleRate: number } | null;
  }[] = [];

  private segment: EpisodeSegmentState = 'IDLE';
  private active: EpisodeCheckpointEntry | null = null;
  private candidateCategory: CategoryId | null = null;
  /** 下一个确认转入是否 leftCensored（会话开始 & gap 后为 true；观察到可靠退出后为 false）。 */
  private leftCensoredNext = true;

  constructor(options: SessionEpisodeStateOptions) {
    if (typeof options?.sessionId !== 'string' || options.sessionId.length === 0) {
      throw new Error('A_Q6_BAD_SESSION: 必须提供真实的 sessionId');
    }
    this.sessionId = options.sessionId;
    const fallback = globalThis.crypto?.randomUUID;
    if (options.newUuid) {
      this.newUuid = options.newUuid;
    } else if (typeof fallback === 'function') {
      this.newUuid = () => globalThis.crypto.randomUUID();
    } else {
      throw new Error('A_Q6_NO_UUID: 运行环境无 crypto.randomUUID，必须注入 newUuid');
    }
    this.minValidTicks = options.minValidTicks ?? A_Q6_MIN_VALID_TICKS;
    if (!Number.isInteger(this.minValidTicks) || this.minValidTicks < 1) {
      throw new Error(`A_Q6_BAD_MIN_TICKS: ${String(this.minValidTicks)}`);
    }
  }

  get episodeSeqHighWater(): number {
    return this.seqHighWater;
  }

  /** 计入 `interruptionCount` 的 episode 数（= counted 条目数；服务端按同 UUID 去重）。 */
  get uniqueEpisodeCount(): number {
    return this.uniqueCount;
  }

  get segmentState(): EpisodeSegmentState {
    return this.segment;
  }

  get episodes(): readonly EpisodeCheckpointEntry[] {
    return this.entries;
  }

  /** 诊断：按状态分布计数。 */
  get statusCounts(): Record<EpisodeStatus, number> {
    const counts: Record<EpisodeStatus, number> = { 'confirmed-pending': 0, active: 0, ended: 0 };
    for (const entry of this.entries) counts[entry.status] += 1;
    return counts;
  }

  /**
   * 送入一个已定稿决策单元。
   *
   * 幂等（Sol §R7「重放已提交 decision/transition 必须 no-op」）：
   * 游标不前进（同 generation 下 `endSample16k` 未增大，或 generation 更小）→ 直接 no-op。
   */
  observe(cell: EpisodeCell): ObserveOutcome {
    const none: ObserveOutcome = { replayed: false, transitioned: false, countedNow: false, episodeSeq: null };
    if (!Number.isInteger(cell.startMs) || !Number.isInteger(cell.endMs) || cell.endMs < cell.startMs) {
      throw new Error(`A_Q6_BAD_CELL_TIME: [${String(cell.startMs)}, ${String(cell.endMs)}]`);
    }
    if (!Number.isInteger(cell.generation) || cell.generation < 0) {
      throw new Error(`A_Q6_BAD_GENERATION: ${String(cell.generation)}`);
    }
    if (!Number.isInteger(cell.endSample16k) || cell.endSample16k < 0) {
      throw new Error(`A_Q6_BAD_CURSOR: ${String(cell.endSample16k)}`);
    }
    // A-B04-G：断点**严格早于**本单元末尾的缺口先闭合旧段（缺口前缓存单元的 endSample16k
    // 必 ≤ 断点，因此它们仍在旧段内被归约，不会在缺口后重开旧段）。
    this.drainGapsBefore(cell.endSample16k);
    if (this.cursor) {
      const isNewerGeneration = cell.generation > this.cursor.generation;
      const sameGenerationAdvanced =
        cell.generation === this.cursor.generation && cell.endSample16k > this.cursor.endSample16k;
      if (!isNewerGeneration && !sameGenerationAdvanced) return { ...none, replayed: true };
    }
    if (this.hasTransitionKey(cell.transitionKey)) {
      // transition 键已提交过：只推进游标，不重复分配/计数。
      this.cursor = { generation: cell.generation, endSample16k: cell.endSample16k };
      return { ...none, replayed: true };
    }
    this.cursor = { generation: cell.generation, endSample16k: cell.endSample16k };

    if (!cell.validInference) {
      this.closeEntry('evidence-gap');
      this.segment = 'IDLE';
      this.candidateCategory = null;
      this.leftCensoredNext = true;
      return none;
    }

    const categoryId = cell.categoryId;
    if (!cell.confirmed || categoryId === null) {
      // 未确认候选：只更新 candidate，不分配正式 episode、不产生 DTO、不增加计数。
      this.closeEntry('label-exit');
      this.candidateCategory = categoryId;
      this.segment = categoryId === null ? 'IDLE' : 'CANDIDATE';
      // 段内先观察到可靠的非该类证据 → 下一个确认转入的起点可知。
      this.leftCensoredNext = false;
      return none;
    }

    if (!isEpisodeEligibleCategory(categoryId)) {
      // 合格类别之外（quiet / background / other）：即使 confirmed 也不产生 episode、不消耗序号。
      this.closeEntry('ineligible-category');
      this.candidateCategory = categoryId;
      this.segment = 'CANDIDATE';
      this.leftCensoredNext = false;
      return none;
    }

    if (this.active && this.active.category === categoryId) {
      this.active.consecutiveTicks += 1;
      this.active.knownEndMs = cell.endMs;
      if (this.active.transitionKey !== cell.transitionKey) this.rememberTransitionKey(cell.transitionKey);
      if (!this.active.valid && this.active.consecutiveTicks >= this.minValidTicks) {
        this.active.valid = true;
        this.active.status = 'active';
        this.segment = 'ACTIVE';
        const countedNow = !this.active.leftCensored;
        if (countedNow) {
          this.active.counted = true;
          this.uniqueCount += 1;
        }
        return { replayed: false, transitioned: false, countedNow, episodeSeq: this.active.episodeSeq };
      }
      this.segment = this.active.valid ? 'ACTIVE' : 'CONFIRMED_PENDING';
      return none;
    }

    // 已验确认切换到另一类别 / 首次确认转入。
    this.closeEntry(this.active ? 'switch' : 'entered');
    const entry = this.createEntry(categoryId, cell);
    this.rememberTransitionKey(cell.transitionKey);
    const countedNow = entry.counted;
    return { replayed: false, transitioned: true, countedNow, episodeSeq: entry.episodeSeq };
  }

  /**
   * 显式缺口（sequence 缺口 / 帧不连续 / Fs 变化 / 停顿 / 停止）——**到达即闭合**。
   *
   * 只用于「缺口与定稿单元没有可比较的时间坐标」的场景（测试桩 / 未带断点的旧消息）。
   * 正式链路一律走 `markGapAt()`：Worker 现在同时给出断点在 16 kHz 域的位置，缺口必须按
   * 与定稿单元一致的时间顺序生效（A-B04-G）。
   */
  markGap(reason: string, continuity: { generation: number; sourceFrameEnd: number; actualSampleRate: number } | null = null): void {
    // 到达即闭合会把「断点之后才送达的缺口前缓存单元」误当成新段开头（正是 A-B04-G 的缺陷形态）。
    // 这里显式作废已排队断点：否则一个更早的断点会在更晚的位置误闭合新段。
    this.pendingGaps.length = 0;
    this.applyGap(reason, continuity);
  }

  /**
   * A-B04-G：带**断点**的真实缺口——按与定稿单元一致的时间顺序闭合旧段。
   *
   * @param breakSample16k 断点在 **16 kHz 域**的位置（= Worker 在缺口发生前已输出的样本数），
   *   与 `EpisodeCell.endSample16k` 同一坐标域，因此可直接比较；
   *   `null` 或非法值 ⇒ 退回 `markGap()` 的「到达即闭合」语义（有界、不静默丢弃）。
   */
  markGapAt(
    reason: string,
    breakSample16k: number | null,
    continuity: { generation: number; sourceFrameEnd: number; actualSampleRate: number } | null = null,
  ): void {
    if (breakSample16k === null || !Number.isInteger(breakSample16k) || breakSample16k < 0) {
      this.markGap(reason, continuity);
      return;
    }
    this.pendingGaps.push({ reason, breakSample16k, continuity });
    this.pendingGaps.sort((a, b) => a.breakSample16k - b.breakSample16k);
    // 游标已到达/越过断点 ⇒ 不会再有该断点之前的单元到达：立即生效，不让缺口滞留。
    this.drainReachedGaps();
  }

  /** 尚未生效的排队缺口数（只读诊断；不改变任何计数或身份）。 */
  get pendingGapCount(): number {
    return this.pendingGaps.length;
  }

  /** 更新连续性元数据（真实 Fs / 源帧高水位）。 */
  setContinuity(continuity: { generation: number; sourceFrameEnd: number; actualSampleRate: number } | null): void {
    this.continuity = continuity;
  }

  /**
   * 桶装配层的**只裁剪/引用**入口（Sol §R8）：对每个已提交且达标的 episode，
   * 求其已知区间 `[startMs, knownEndMs)` 与桶 `[bucketStartMs, bucketEndMs)` 的非空交集。
   *
   * - 一个跨桶事件可在多个桶出现**同一 UUID** 的片段，但 `uniqueEpisodeCount` 只加一次；
   * - `confirmed-pending` 与未达标条目**不出现**在结果里；
   * - 桶裁剪本身**不会**把 `leftCensored` 变成 true（它只反映起点是否可知）。
   */
  episodeRefsForBucket(bucketStartMs: number, bucketEndMs: number): EpisodeRef[] {
    if (!Number.isInteger(bucketStartMs) || !Number.isInteger(bucketEndMs) || bucketEndMs <= bucketStartMs) {
      throw new Error(`A_Q6_BAD_BUCKET_RANGE: [${String(bucketStartMs)}, ${String(bucketEndMs)})`);
    }
    const out: EpisodeRef[] = [];
    for (const entry of this.entries) {
      if (!entry.valid || entry.status === 'confirmed-pending') continue;
      const segStart = Math.max(entry.startMs, bucketStartMs);
      const segEnd = Math.min(entry.knownEndMs, bucketEndMs);
      if (segEnd <= segStart) continue;
      out.push({
        episodeId: entry.dtoEpisodeId,
        startOffsetMs: segStart - bucketStartMs,
        kind: entry.leftCensored ? 'leftCensored' : 'confirmed',
      });
    }
    return out;
  }

  /** 可原子持久化的 checkpoint（Sol §R7 结构；**无任何 PCM/波形/scores 特征**）。 */
  checkpoint(): AcousticSessionCheckpointV1 {
    return {
      version: ACOUSTIC_CHECKPOINT_VERSION,
      sessionId: this.sessionId,
      episodeSeqHighWater: this.seqHighWater,
      uniqueEpisodeCount: this.uniqueCount,
      lastCommittedDecisionCursor: this.cursor ? { ...this.cursor } : null,
      committedTransitionKeys: [...this.transitionKeys],
      continuity: this.continuity ? { ...this.continuity } : null,
      episodes: this.entries.map((entry) => ({ ...entry })),
    };
  }

  /**
   * 从 checkpoint 恢复（Sol §R7「恢复先加载 checkpoint 和 outbox，再处理任何新决策」）。
   * 已计数记录、已分配映射、高水位与未 ACK 桶都保留；后续新决策从高水位继续，**不复用序号**。
   */
  restore(checkpoint: AcousticSessionCheckpointV1): void {
    if (!checkpoint || checkpoint.version !== ACOUSTIC_CHECKPOINT_VERSION) {
      throw new Error(`A_Q6_BAD_CHECKPOINT_VERSION: ${String(checkpoint?.version)}`);
    }
    if (checkpoint.sessionId !== this.sessionId) {
      throw new Error(`A_Q6_SESSION_MISMATCH: checkpoint=${checkpoint.sessionId}，本实例 ${this.sessionId}`);
    }
    let expected = 1;
    for (const entry of checkpoint.episodes) {
      if (entry.episodeSeq !== expected) {
        throw new Error(`A_Q6_CHECKPOINT_SEQ_GAP: 期望 ${expected}，实际 ${entry.episodeSeq}（序号不得复用或跳号）`);
      }
      if (stableEpisodeId(this.sessionId, entry.episodeSeq) !== entry.stableId) {
        throw new Error(`A_Q6_CHECKPOINT_ID_MISMATCH: ${entry.stableId}`);
      }
      if (!UUID_PATTERN.test(entry.dtoEpisodeId)) {
        throw new Error(`A_Q6_CHECKPOINT_UUID_INVALID: ${entry.dtoEpisodeId}`);
      }
      expected += 1;
    }
    if (checkpoint.episodeSeqHighWater < checkpoint.episodes.length) {
      throw new Error(
        `A_Q6_CHECKPOINT_HIGHWATER: highWater=${checkpoint.episodeSeqHighWater} < 条目数 ${checkpoint.episodes.length}`,
      );
    }
    const counted = checkpoint.episodes.filter((e) => e.counted).length;
    if (counted !== checkpoint.uniqueEpisodeCount) {
      throw new Error(
        `A_Q6_CHECKPOINT_COUNT_MISMATCH: uniqueEpisodeCount=${checkpoint.uniqueEpisodeCount}，实际 counted=${counted}`,
      );
    }

    this.entries = checkpoint.episodes.map((entry) => ({ ...entry }));
    this.seqHighWater = checkpoint.episodeSeqHighWater;
    this.uniqueCount = checkpoint.uniqueEpisodeCount;
    this.transitionKeys = [...checkpoint.committedTransitionKeys];
    this.cursor = checkpoint.lastCommittedDecisionCursor ? { ...checkpoint.lastCommittedDecisionCursor } : null;
    this.continuity = checkpoint.continuity ? { ...checkpoint.continuity } : null;
    // A-B04-G：排队缺口是**本次投递顺序**的瞬态，不进 checkpoint；恢复后一律从空队列重新开始。
    this.pendingGaps.length = 0;
    this.active = null;
    this.candidateCategory = null;
    const open = [...this.entries].reverse().find((e) => e.status !== 'ended');
    if (open) this.active = open;
    this.segment =
      this.active === null
        ? 'IDLE'
        : this.active.valid
          ? 'ACTIVE'
          : 'CONFIRMED_PENDING';
    // 恢复后不假定起点可知：只有拿到新的「可靠退出」证据才会把 leftCensoredNext 置 false。
    this.leftCensoredNext = this.active === null;
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  private createEntry(category: CategoryId, cell: EpisodeCell): EpisodeCheckpointEntry {
    this.seqHighWater += 1;
    const entry: EpisodeCheckpointEntry = {
      episodeSeq: this.seqHighWater,
      stableId: stableEpisodeId(this.sessionId, this.seqHighWater),
      dtoEpisodeId: this.newUuid(),
      category,
      startMs: cell.startMs,
      knownEndMs: cell.endMs,
      leftCensored: this.leftCensoredNext,
      counted: false,
      status: 'confirmed-pending',
      endReason: null,
      transitionKey: cell.transitionKey,
      consecutiveTicks: 1,
      valid: false,
    };
    if (!UUID_PATTERN.test(entry.dtoEpisodeId)) {
      throw new Error(`A_Q6_BAD_UUID: newUuid() 返回的不是 UUID：${entry.dtoEpisodeId}`);
    }
    // 起点已由本次确认转入证实；后续同段延续不再改变 leftCensored。
    this.leftCensoredNext = false;
    if (entry.consecutiveTicks >= this.minValidTicks) {
      entry.valid = true;
      entry.status = 'active';
      if (!entry.leftCensored) {
        entry.counted = true;
        this.uniqueCount += 1;
      }
    }
    this.entries.push(entry);
    this.active = entry;
    this.segment = entry.valid ? 'ACTIVE' : 'CONFIRMED_PENDING';
    return entry;
  }

  private closeEntry(reason: string): void {
    const entry = this.active;
    if (!entry) return;
    if (entry.status !== 'ended') {
      entry.status = 'ended';
      entry.endReason = reason;
    }
    this.active = null;
  }

  /** 一个真实缺口对状态机的**唯一**落地动作（原 `markGap` 语义，逐字不变）。 */
  private applyGap(
    reason: string,
    continuity: { generation: number; sourceFrameEnd: number; actualSampleRate: number } | null,
  ): void {
    this.closeEntry(reason || 'gap');
    this.segment = 'IDLE';
    this.candidateCategory = null;
    this.leftCensoredNext = true;
    this.continuity = continuity;
  }

  /** 生效所有「断点严格早于 `bound`」的排队缺口（`bound` = 即将归约单元的 endSample16k）。 */
  private drainGapsBefore(bound: number): void {
    while (this.pendingGaps.length > 0 && this.pendingGaps[0].breakSample16k < bound) {
      const gap = this.pendingGaps.shift() as (typeof this.pendingGaps)[number];
      this.applyGap(gap.reason, gap.continuity);
    }
  }

  /** 生效所有「断点已在游标之后（含相等）」的排队缺口：不会再有更早的单元到达。 */
  private drainReachedGaps(): void {
    const reached = this.cursor === null ? -1 : this.cursor.endSample16k;
    while (this.pendingGaps.length > 0 && this.pendingGaps[0].breakSample16k <= reached) {
      const gap = this.pendingGaps.shift() as (typeof this.pendingGaps)[number];
      this.applyGap(gap.reason, gap.continuity);
    }
  }

  private rememberTransitionKey(key: string): void {
    if (this.hasTransitionKey(key)) return;
    this.transitionKeys.push(key);
    if (this.transitionKeys.length > A_Q6_TRANSITION_KEY_LIMIT) {
      this.transitionKeys.splice(0, this.transitionKeys.length - A_Q6_TRANSITION_KEY_LIMIT);
    }
  }

  private hasTransitionKey(key: string): boolean {
    return this.transitionKeys.includes(key);
  }
}

/** Worker 侧构造转入去重键（幂等键不得含时间戳/随机数）。 */
export function makeTransitionKey(generation: number, category: CategoryId, startSample16k: number): string {
  return `g${generation}:${category}:s${startSample16k}`;
}
