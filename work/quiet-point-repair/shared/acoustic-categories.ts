/**
 * 声学类别元数据（无 IO、无 CSV 依赖）。
 *
 * 为什么单独一个模块：`shared/acoustic-map.ts` 需要内嵌 CSV（构建期生成），而
 * `shared/study-model.ts`（服务端启动链、桶 DTO 校验）**只需要类别 id 与映射版本**。
 * 把这两样放在这里，服务端启动链就不会因为"CSV 尚未生成/加载失败"而被拖死，
 * 同时消除过去两处各自维护同一份常量、可能静默漂移的问题（Sol 裁决 §2 第 6 条）。
 *
 * 本文件是**唯一权威**：`acoustic-map.ts` 与 `study-model.ts` 都从这里取，
 * 并各自 re-export 以保持既有公开 API 不变。
 */

/** 映射版本常量。进入所有 5 秒桶的 mapVersion 字段。 */
export const MAP_VERSION = 'map-v1' as const;

/**
 * 12 个产品类别（顺序固定：与 §4 第二列一致，也是 categoryMs 的键序）。
 * `unknown` 不是类别而是质量状态；`other` 表示"映射有效但未明确分组的真实模型类"。
 */
export const CATEGORY_IDS = [
  'paper',
  'whisper',
  'conversation',
  'chair_drag',
  'impact',
  'ring',
  'cough',
  'footstep',
  'keyboard',
  'quiet',
  'background',
  'other',
] as const;

export type CategoryId = (typeof CATEGORY_IDS)[number];

/** 类别计分门控方式：'score' 由模型分数驱动；'state' 仅由第 3 章声级状态门控参与。 */
export type CategoryGate = 'score' | 'state';
