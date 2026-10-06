/**
 * 运行配置（由**真机实读**后锁定的标识）。
 *
 * 依据 Sol 裁决 §5.1：
 *   「插件改读 `TensorFlowLite.runtimeVersion()`，另报 `schemaVersion()`；真实 runtime 核验后
 *     生成/锁定运行配置标识（预计 `tflite-2.16.1`，实读不同则停止诊断），后端白名单增加该确切标识。」
 *
 * 本文件的值**只允许来自真机 `info()` 实读**，并必须附带读证据（设备、时间、原始日志片段）。
 * 禁止为了"让流程能跑"而冒填：若实读值与白名单不符，应停在这里并回到 Sol，而不是改这个文件。
 *
 * 为什么需要它：基础范围（Sol §5.3）不启用声学分类管线，插件的 `load()` 不会发生，
 * 因此没有"实读"可依赖；但基础范围仍要建立**真实学习段**（桶全 unknown、aiStatus=unavailable）。
 * 用一份"实读后锁定"的配置标识来创建学习段，既不冒填、也不假装已启用 AI 管线。
 */

/**
 * C16 脱敏常量（结构性占位）：**真机 serial / 设备型号 / 私有网段地址一律不落源码**。
 *
 * 为什么可以这样改（等价性，Sol §4 隐私 FAIL 的关闭）：
 *  · 本文件里**参与运行时判定**的只有 `LOCKED_RUNTIME_PROFILE`（它不含任何设备标识）；
 *  · `LOCKED_RUNTIME_READ` 只作审计留痕，且全部消费方只有
 *    `tests/acoustic-build-info.test.ts` —— 它只读 `.evidence`（断言 hash/runtime/schema），
 *    **从不读 `.device`** ⇒ 换掉这一段字面量不改变任何代码路径的取值。
 *  · `.evidence` 与 `LOCKED_RUNTIME_PROFILE` 逐字未动（见 `tests/acoustic-build-info.test.ts`
 *    的 REDACT-2 逐字段断言）。
 *
 * 真实 serial / IP 只保留在**内部证据**（`work/base-acceptance/**` 的原始日志与本周期
 * `run-c16/PRODUCT_CHANGES.md` 的审计说明）里，不进源码包。
 */
export const TEST_DEVICE_SERIAL_REDACTED = 'TEST_DEVICE_SERIAL_REDACTED' as const;
export const TEST_DEVICE_MODEL_REDACTED = 'TEST_DEVICE_MODEL_REDACTED' as const;
export const PRIVATE_LAN_TEST_HOST = 'PRIVATE_LAN_TEST_HOST' as const;

/** 真机实读证据（原样保留，便于审计；仅设备标识按 Sol §4 脱敏为结构常量）。 */
export const LOCKED_RUNTIME_READ = {
  /** 实读设备：serial/型号已脱敏（结构常量见上方；真实值只在内部证据里）。 */
  device: `${TEST_DEVICE_SERIAL_REDACTED} / ${TEST_DEVICE_MODEL_REDACTED}`,
  /** 实读时间（Asia/Shanghai）。 */
  readAt: '2026-10-03T17:12:00+08:00',
  /** 实读来源：`AcousticInference.info()` 的 `loaded` 快照（logcat 原文见 evidence）。 */
  evidence:
    '[acoustic] loaded model=yamnet.tflite sha=10c95ea3eb9a7bb4cb8bddf6feb023250381008177ac162ce169694d05c317de ' +
    'bytes=4126810 loadMs=34 runtime=2.16.1 schema=3 inTensor=waveform_binary shape=[15600] ' +
    'out=tower0/network/layer32/final_output#0 scores=521',
} as const;

/**
 * 锁定的运行配置标识（由上面那次实读得出）。
 * - `runtimeVersion` 来自 `TensorFlowLite.runtimeVersion()` → `2.16.1`（记为 `tflite-2.16.1`）
 * - `schemaVersion` 来自 `TensorFlowLite.version()` → `3`（**不是** runtime，两者不得混用）
 * - `preprocessVersion` 本构建真实路径 = 线性诊断（`preproc-diag-linear-v1`），**不声称** FIR
 */
export const LOCKED_RUNTIME_PROFILE = {
  modelHash: '10c95ea3eb9a7bb4cb8bddf6feb023250381008177ac162ce169694d05c317de',
  runtimeVersion: 'tflite-2.16.1',
  schemaVersion: '3',
  preprocessVersion: 'preproc-diag-linear-v1',
  mapVersion: 'map-v1',
  decisionVersion: 'decision-v1',
} as const;
