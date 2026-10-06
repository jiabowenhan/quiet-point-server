/**
 * F3 **服务端权威分组复算**（C6 / Sol 第七轮 §2.5 F3：canonical 必须修）。
 *
 * 缺陷形态：旧实现把客户端自报的 `configKey` / `processingKey` **直接**写进 `StoredReport`，
 * `viewForRoom()` 又按这两个字段分组。于是一个谎报键的客户端（或只是版本对不上的旧包）
 * 就能把**本不可比**的报告并进同一组，房间指数因此混组。
 *
 * 现在的口径（纯函数、无 IO，便于直接验算）：
 *  · 分组键**只由服务器读回的数据**决定：四项版本（preprocess/runtime/map/decision）+ modelHash
 *    + `sessions.processing` 的规范化 profileKey；
 *  · 客户端报来的键只是**声明**：与权威值不一致时**不被采用**，也**不会**因此改变分组；
 *    `processingKey` 声明为非 null 且与权威值矛盾 ⇒ 明确拒绝（`PROCESSING_MISMATCH`），
 *    因为那是一条可被看见的假声明，静默吞掉会让"谎报"看起来像成功。
 *  · 权威 processing 无法规范解析（空/unknown）时 `processingKey=null` —— 与 F2 的
 *    `blocked_unknown_processing` 同源：**不猜**、也不与已知组并池。
 */

import { configurationKeyOf, parseProcessingProfile } from '../../server/insights.js';

export interface CanonicalInput {
  modelHash: string;
  runtimeVersion: string;
  preprocessVersion: string;
  mapVersion: string;
  decisionVersion: string;
  processing: string;
}

export interface CanonicalKeys {
  /** 四项版本拼接（与客户端 `CONFIGURATION_DIMENSIONS` 顺序/分隔符一致，但**由服务器读出**）。 */
  configKey: string;
  /** 规范化 processing profileKey；无法证实一律 null。 */
  processingKey: string | null;
  /** 规范化解析结论（`verified` / `unknown` / `legacy_reported` / `not_supplied`）。 */
  processingEvidence: string;
  modelHash: string;
}

/** 只读权威行 → 权威分组键。**不看客户端任何字段。** */
export function canonicalKeysOf(input: CanonicalInput): CanonicalKeys {
  const configKey = configurationKeyOf({
    preprocessVersion: input.preprocessVersion,
    runtimeVersion: input.runtimeVersion,
    mapVersion: input.mapVersion,
    decisionVersion: input.decisionVersion,
  });
  const parsed = parseProcessingProfile(input.processing === '' ? null : input.processing);
  return {
    configKey,
    processingKey: parsed.profileKey,
    processingEvidence: parsed.evidence,
    modelHash: input.modelHash,
  };
}

export type ClaimVerdict =
  | { ok: true; configKeyClaimMatched: boolean; processingKeyClaimMatched: boolean }
  | { ok: false; reason: 'PROCESSING_MISMATCH'; detail: string };

/**
 * 客户端声明 vs 权威值。
 *
 * `processingKey` 非 null 且与权威值不符 ⇒ 拒绝（这是**可见的假声明**）；
 * `processingKey` 为 null ⇒ 视为"未声明"，由服务器填权威值（现有客户端的真实形态）。
 * `configKey` 不符 ⇒ **不拒绝**，但记 `configKeyClaimMatched=false`：因为分组已经不用它了，
 * 拒绝反而会把"版本对不上的旧包"变成一条看不见的功能中断。
 */
export function judgeClaims(claim: { configKey: string; processingKey: string | null }, canonical: CanonicalKeys): ClaimVerdict {
  if (claim.processingKey !== null && claim.processingKey !== canonical.processingKey) {
    return {
      ok: false,
      reason: 'PROCESSING_MISMATCH',
      detail: '上报的 processingKey 与服务端读回的处理链路不一致',
    };
  }
  return {
    ok: true,
    configKeyClaimMatched: claim.configKey === canonical.configKey,
    processingKeyClaimMatched: claim.processingKey !== null && claim.processingKey === canonical.processingKey,
  };
}
