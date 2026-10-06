/**
 * 正式桶构建适配器（Sol §R8）：**episode 只有会话状态机一个生产者**。
 *
 * 权威依据：`work\SOL_ENHANCE_A_INTEGRATION_PROMPT.md` §R8「冲突②裁定：`buildBucket` 只裁剪/引用」：
 *   - 新增 `buildBucketWithSessionEpisodes(baseBucketInput, sessionEpisodeSnapshot)`；
 *   - 统计部分必须沿用现有纯统计函数/定义；
 *   - 旧 `buildBucket()` 仅用于旧路径兼容与旧测试；
 *   - 「若有效性确认发生在桶封存之后，只在仍可提交的交集区间引用该已确认身份，历史不可回写，
 *      late/drop 统计如实保留」；
 *   - 「一个跨桶事件可在多个桶出现同 UUID 的片段，但会话 uniqueEpisodeCount 只加一次」。
 *
 * ## R8 的落地方式：`shared\study-bucket.ts` 的**最小解耦**（已授权，已落地）
 *
 * R8 要求「复用已导出的非 episode 统计核心」。实测定点核对：`shared\study-bucket.ts` 只导出
 * `buildBucket()` 与 `checkBucketInvariants()`，统计与 episode 扫描写在同一个函数体内，
 * 没有可直接复用的非 episode 统计核心；Sol 同时禁止「复制统计核心」与「先生成再丢弃 episode」。
 *
 * 该文件因此按 `work\LEAD_AUTHORIZATION_20261004.md` 第 1 条 (b) 做了**最小结构解耦**：
 * `BuildBucketArgs` 增加可选 `episodeSource: 'bucket' | 'session'`（**默认 `'bucket'`**），
 * 逐桶扫描的循环条件改为 `while (episodeSource === 'bucket' && ...)` —— 正式路径传 `'session'`
 * 时**在扫描前就跳过**整个逐桶生成逻辑，旧分支逐字未改、统计口径逐字段不变。
 *
 * 本适配器据此**直接**调用 `buildBucket({ ..., episodeSource: 'session' })`：
 *   - 不再借 `minEpisodeTicks: Number.MAX_SAFE_INTEGER` 之类的阈值手段去「压住」扫描；
 *   - 统计量（quiet/noisy/unknown、valid/classified、categoryMs、top3、counters）全部来自既有实现，
 *     **一行算法都没有复制**；
 *   - episodes 完全来自会话状态机的裁剪引用，不做「生成后再覆盖/丢弃」；
 *   - 仍保留抛错探针 `newEpisodeId` 作为**纵深防御**：若将来有人误删 `episodeSource` 守卫，
 *     旧扫描一旦产出 episode 就会立刻抛 `LEGACY_EPISODE_SCAN_DETECTED`，而不是静默多出一个生产者。
 */

import { buildBucket, checkBucketInvariants, type BuildBucketArgs, type BuiltBucket } from './study-bucket.js';
import { BUCKET_WIDTH_MS } from './study-model.js';
import type { EpisodeRef, SessionEpisodeState } from './acoustic-episodes.js';

/** 旧逐桶扫描被意外触发（正式路径不允许）。 */
export const LEGACY_EPISODE_SCAN_DETECTED = 'LEGACY_EPISODE_SCAN_DETECTED';

/**
 * 已落地的 `shared\study-bucket.ts` 最小解耦记录（Sol §R8 条件清单第 1 条）。
 * 授权依据：`work\LEAD_AUTHORIZATION_20261004.md`（批准 (a) 导出统计核心 或 (b) `episodeSource` 分支）。
 * 本实现选 (b)：`BuildBucketArgs.episodeSource?: 'bucket' | 'session'`，默认 `'bucket'` ⇒ 既有调用方行为不变。
 */
export const STUDY_BUCKET_DECOUPLING = Object.freeze({
  file: 'shared/study-bucket.ts',
  applied: "BuildBucketArgs 增加 episodeSource?: 'bucket' | 'session'（默认 'bucket'）；逐桶扫描循环加 episodeSource === 'bucket' 守卫",
  legacyBranch: '逐字未改：默认 bucket 时既有调用方与旧断言行为完全不变',
  formalBranch: "session：扫描前即跳过逐桶生成逻辑，episodes 恒为 []，由会话状态机唯一生产",
  authorization: 'work/LEAD_AUTHORIZATION_20261004.md 第 1 条 (b)',
});

/** 会话 episode 快照（只取裁剪所需字段，避免把整个状态机耦合进桶层）。 */
export interface SessionEpisodeSnapshot {
  uniqueEpisodeCount: number;
  episodeRefsForBucket(bucketStartMs: number, bucketEndMs: number): EpisodeRef[];
}

/**
 * 从 `SessionEpisodeState` 取快照（只读投影）。
 *
 * 参数按**结构类型**接受：真实 Worker 里没有 `SessionEpisodeState` 实例（身份只在主线程分配，§R7/R8），
 * 传入的惰性 sink 只要具备 `uniqueEpisodeCount` 与 `episodeRefsForBucket` 即可；
 * 既有 `SessionEpisodeState` 调用方逐字不变（结构上完全满足）。
 */
export function sessionEpisodeSnapshot(state: SessionEpisodeSnapshot): SessionEpisodeSnapshot {
  return {
    uniqueEpisodeCount: state.uniqueEpisodeCount,
    episodeRefsForBucket: (start, end) => state.episodeRefsForBucket(start, end),
  };
}

export interface BuildBucketWithSessionEpisodesResult {
  bucket: BuiltBucket;
  /** 本桶引用的会话 episode（裁剪后；同一 UUID 可出现在多个桶）。 */
  refs: EpisodeRef[];
  /** 本次旧逐桶扫描产生的 episode 数（恒为 0；>0 会抛错）。 */
  legacyEpisodesProduced: number;
}

/**
 * 用**会话状态机**作为唯一 episode 生产者构建一个桶。
 *
 * `baseBucketInput` 与 `BuildBucketArgs` 同形，但 `episodes` 无关字段照旧；
 * 传入的 `newEpisodeId`/`minEpisodeTicks` 会被本函数覆盖（正式路径不允许逐桶身份）。
 */
export function buildBucketWithSessionEpisodes(
  baseBucketInput: Omit<BuildBucketArgs, 'newEpisodeId' | 'minEpisodeTicks'>,
  session: SessionEpisodeSnapshot,
): BuildBucketWithSessionEpisodesResult {
  let legacyEpisodesProduced = 0;
  const created = buildBucket({
    ...baseBucketInput,
    // Sol §R8：正式分支在扫描前选择 episode 来源 ⇒ 逐桶生成逻辑一次都不执行。
    episodeSource: 'session',
    // 纵深防御：守卫若被误删，旧扫描一旦产出 episode 立即抛错，绝不静默多一个生产者。
    newEpisodeId: () => {
      legacyEpisodesProduced += 1;
      throw new Error(LEGACY_EPISODE_SCAN_DETECTED);
    },
  });
  legacyEpisodesProduced = created.episodes.length;

  const startOffsetMs = created.startOffsetMs;
  const endOffsetMs = created.endOffsetMs;
  const refs = session.episodeRefsForBucket(startOffsetMs, endOffsetMs);
  if (refs.length > 12) {
    // 与服务端 EPISODES_MAX 对齐，超限时本地 fail-fast，绝不静默截断计数。
    throw new Error(`SESSION_EPISODES_OVERFLOW: 本桶 ${refs.length} 条 > 12（服务端上限）`);
  }

  const bucket: BuiltBucket = {
    ...created,
    episodes: refs.map((ref) => ({
      episodeId: ref.episodeId,
      startOffsetMs: ref.startOffsetMs,
      kind: ref.kind,
    })),
  };
  if (baseBucketInput.bucketWidthMs !== undefined && baseBucketInput.bucketWidthMs !== BUCKET_WIDTH_MS) {
    throw new Error(
      `SESSION_BUCKET_WIDTH_UNSUPPORTED: ${String(baseBucketInput.bucketWidthMs)}（本适配器只支持既验 ${BUCKET_WIDTH_MS} ms）`,
    );
  }
  const invalid = checkBucketInvariants(bucket);
  if (invalid !== null) {
    throw new Error(`SESSION_BUCKET_INVALID: ${invalid}`);
  }
  return { bucket, refs, legacyEpisodesProduced };
}
