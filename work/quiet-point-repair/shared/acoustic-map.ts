/*
 * shared/acoustic-map.ts — 静点 YAMNet 521 类 → 12 产品类别映射（map-v1）
 *
 * 权威依据：work/CODEX_DECISION_AI.md §4「中文类别映射」。
 * 映射源：work/models/yamnet-class-map.csv（521 类，mid 为权威，index 作交叉断言）。
 *
 * 设计要点（不可放宽）：
 *  1. CSV 文本**逐字节内嵌**于本文件（MAP_CSV_TEXT），运行时用正规 RFC4180 解析器解析。
 *     禁止 split(',')：CSV 含 73 个带逗号的引号字段（如 "Child speech, kid speaking"）。
 *     内嵌而非读盘，是因为浏览器/Android WebView 无法访问 work/models 路径；
 *     内嵌文本与磁盘文件的对应关系由 MAP_SOURCE_SHA256 / MAP_SOURCE_BYTES 常量 +
 *     自检与测试双重核验（tests/acoustic-map.test.ts 会比对磁盘文件）。
 *  2. 组分数 = 组内成员 sigmoid 分数的 **max**，不是 sum。
 *  3. 12 个产品类别；unknown 是质量状态，不是第 13 种声音。
 *  4. 每个 index 只归一个组；未在 §4 显式列出的 index 全部落 other。
 *  5. 500–506 与 520（场景/混响/录音来源）仍展开到 other，但 suppressAsEvent=true。
 */

// 类别元数据与映射版本来自唯一权威模块（无 IO / 无 CSV 依赖），此处 re-export 保持既有 API。
import { CATEGORY_IDS, MAP_VERSION, type CategoryGate, type CategoryId } from './acoustic-categories.js';
// 内嵌 CSV 与其身份常量来自构建前生成的模块（scripts/generate-acoustic-map.mjs）。
import {
  EXPECTED_CLASS_COUNT,
  MAP_CSV_TEXT,
  MAP_SOURCE_BYTES,
  MAP_SOURCE_FILE_SHA256,
  MAP_SOURCE_NORMALIZED_BYTES,
  MAP_SOURCE_SHA256,
} from './generated/acoustic-map-source.js';

export { CATEGORY_IDS, MAP_VERSION, type CategoryGate, type CategoryId };
export {
  EXPECTED_CLASS_COUNT,
  MAP_SOURCE_BYTES,
  MAP_SOURCE_FILE_SHA256,
  MAP_SOURCE_NORMALIZED_BYTES,
  MAP_SOURCE_SHA256,
};

// ---------------------------------------------------------------------------
// CSV 源文本（逐字节内嵌；由生成器从 work/models/yamnet-class-map.csv 注入）
// ---------------------------------------------------------------------------

// CSV 源文本由上方 `./generated/acoustic-map-source.js` 提供（构建前生成，杜绝占位符残留）。

// ---------------------------------------------------------------------------
// 正规 RFC4180 CSV 解析（禁止 split(',')）
// ---------------------------------------------------------------------------

/**
 * 解析 CSV 文本为行×字段矩阵。
 * 支持：引号包裹字段、字段内逗号、字段内换行、`""` 转义为单个 `"`。
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 12 个产品类别定义（中文名与能力界限逐条对齐 §4）
// ---------------------------------------------------------------------------

// CATEGORY_IDS / CategoryId / CategoryGate 由 ./acoustic-categories.js 提供并在文件头 re-export。

export interface CategoryDef {
  readonly categoryId: CategoryId;
  /** 固定中文显示名（§4 第二列）。 */
  readonly displayName: string;
  /** 该类别是否必须保留「疑似」限定。 */
  readonly suspected: boolean;
  /** 能力界限说明（不得越界声称）。 */
  readonly boundary: string;
  /** 归属本类别的 YAMNet index 列表。 */
  readonly members: readonly number[];
  /** 计分门控方式。 */
  readonly gate: CategoryGate;
}

/** 显式归组表：index + mid（mid 用于与 CSV 交叉断言，§4「每 index 唯一归组且 mid 相等」）。 */
const EXPLICIT_GROUPS: ReadonlyArray<{
  readonly categoryId: CategoryId;
  readonly members: ReadonlyArray<readonly [number, string]>;
}> = [
  {
    categoryId: 'paper',
    members: [
      [473, '/t/dd00112'],
      [474, '/m/07qcx4z'],
      [481, '/m/07qwyj0'],
    ],
  },
  { categoryId: 'whisper', members: [[12, '/m/02rtxlg']] },
  {
    categoryId: 'conversation',
    members: [
      [0, '/m/09x0r'],
      [1, '/m/0ytgt'],
      [2, '/m/01h8n0'],
      [63, '/m/07rkbfh'],
      [65, '/m/07qfr4h'],
    ],
  },
  {
    categoryId: 'chair_drag',
    members: [
      [469, '/m/07qv4k0'],
      [480, '/m/07qh7jl'],
    ],
  },
  {
    categoryId: 'impact',
    members: [
      [353, '/m/07r4wb8'],
      [354, '/m/07qcpgn'],
      [454, '/m/07qnq_y'],
      [460, '/m/07pws3f'],
      [483, '/m/07qmpdm'],
    ],
  },
  {
    categoryId: 'ring',
    members: [
      [384, '/m/07pp8cl'],
      [385, '/m/01hnzm'],
    ],
  },
  { categoryId: 'cough', members: [[42, '/m/01b_21']] },
  {
    categoryId: 'footstep',
    members: [
      [47, '/m/07qv_x_'],
      [48, '/m/07pbtc8'],
    ],
  },
  {
    categoryId: 'keyboard',
    members: [
      [378, '/m/0316dw'],
      [380, '/m/01m2v'],
    ],
  },
  { categoryId: 'quiet', members: [[494, '/m/028v0c']] },
  {
    categoryId: 'background',
    members: [
      [490, '/m/07rcgpl'],
      [507, '/m/096m7z'],
      [508, '/m/06_y0by'],
      [509, '/m/07rgkc5'],
      [510, '/m/06xkwv'],
      [514, '/m/0chx_'],
      [515, '/m/0cj0r'],
    ],
  },
];

/** 场景/混响/录音来源类：仍展开到 other，但不得独立触发 episode（§4）。 */
export const SUPPRESS_AS_EVENT_INDICES: readonly number[] = [
  500, 501, 502, 503, 504, 505, 506, 520,
];

/** Whispering 有效时，从 conversation 候选中排除的泛 Speech 贡献（§4 层级与兜底）。 */
export const CONVERSATION_GENERIC_MEMBERS: readonly number[] = [0, 1];
/** conversation 中可提供独立证据的成员（多人交谈类）。 */
export const CONVERSATION_INDEPENDENT_MEMBERS: readonly number[] = [2, 63, 65];

// ---------------------------------------------------------------------------
// 521 行表（由内嵌 CSV 展开）
// ---------------------------------------------------------------------------

export interface AcousticMapRow {
  /** CSV 权威序号（0…520）。 */
  readonly index: number;
  /** AudioSet mid（CSV 权威）。 */
  readonly mid: string;
  /** CSV 原名（display_name）。 */
  readonly displayName: string;
  /** 唯一归属的产品类别。 */
  readonly categoryId: CategoryId;
  /** 是否禁止独立触发事件。 */
  readonly suppressAsEvent: boolean;
}

function buildIndexToCategory(): Map<number, CategoryId> {
  const m = new Map<number, CategoryId>();
  for (const group of EXPLICIT_GROUPS) {
    for (const [index] of group.members) {
      if (m.has(index)) {
        throw new Error(`ACOUSTIC_MAP_DUPLICATE_GROUP: index ${index} 被归入多个组`);
      }
      m.set(index, group.categoryId);
    }
  }
  return m;
}

function buildRows(): AcousticMapRow[] {
  const parsed = parseCsv(MAP_CSV_TEXT);
  const header = parsed[0];
  if (!header || header.length !== 3 || header[0] !== 'index' || header[1] !== 'mid' || header[2] !== 'display_name') {
    throw new Error(`ACOUSTIC_MAP_BAD_HEADER: ${JSON.stringify(header)}`);
  }
  const indexToCategory = buildIndexToCategory();
  const suppress = new Set<number>(SUPPRESS_AS_EVENT_INDICES);
  const rows: AcousticMapRow[] = [];
  for (let r = 1; r < parsed.length; r++) {
    const fields = parsed[r]!;
    if (fields.length !== 3) {
      throw new Error(`ACOUSTIC_MAP_BAD_ROW_FIELDS: 第 ${r} 行字段数=${fields.length}`);
    }
    const index = Number(fields[0]);
    if (!Number.isInteger(index)) {
      throw new Error(`ACOUSTIC_MAP_BAD_INDEX: 第 ${r} 行 index=${fields[0]}`);
    }
    const categoryId = indexToCategory.get(index) ?? 'other';
    if (suppress.has(index) && categoryId !== 'other') {
      throw new Error(`ACOUSTIC_MAP_SUPPRESS_NOT_OTHER: index ${index} 属于 ${categoryId}`);
    }
    rows.push({
      index,
      mid: fields[1]!,
      displayName: fields[2]!,
      categoryId,
      suppressAsEvent: suppress.has(index),
    });
  }
  return rows;
}

/** 恰好 521 行映射表（index 0…520）。模块加载时由内嵌 CSV 展开。 */
export const ACOUSTIC_MAP_ROWS: readonly AcousticMapRow[] = Object.freeze(buildRows());

/** 12 类定义（含中文名、能力界限、成员 index、门控方式）。 */
export const CATEGORY_DEFS: readonly CategoryDef[] = Object.freeze(
  CATEGORY_IDS.map((categoryId) => {
    const explicit = EXPLICIT_GROUPS.find((g) => g.categoryId === categoryId);
    const members = explicit
      ? explicit.members.map(([index]) => index)
      : ACOUSTIC_MAP_ROWS.filter((row) => row.categoryId === 'other').map((row) => row.index);
    const meta: Record<CategoryId, { displayName: string; suspected: boolean; boundary: string; gate: CategoryGate }> = {
      paper: {
        displayName: '纸张/翻书声（疑似）',
        suspected: true,
        boundary: '不确认纸材质或翻页动作',
        gate: 'score',
      },
      whisper: {
        displayName: '低声交谈（疑似）',
        suspected: true,
        boundary: '不判断谈话内容',
        gate: 'score',
      },
      conversation: {
        displayName: '交谈声',
        suspected: false,
        boundary: '63/65 胜出才显示「多人交谈（疑似）」，0/1/2 显示「交谈声（人数未确认）」',
        gate: 'score',
      },
      chair_drag: {
        displayName: '椅子拖动/摩擦声（疑似）',
        suspected: true,
        boundary: '也可能是其他物体刮擦',
        gate: 'score',
      },
      impact: {
        displayName: '桌椅碰撞/敲击声（疑似）',
        suspected: true,
        boundary: '不确认来源为桌椅',
        gate: 'score',
      },
      ring: {
        displayName: '手机/电话铃声（疑似）',
        suspected: true,
        boundary: '无法区分来自手机、座机或播放声',
        gate: 'score',
      },
      cough: {
        displayName: '咳嗽声（疑似）',
        suspected: true,
        boundary: '不推断健康状况',
        gate: 'score',
      },
      footstep: {
        displayName: '脚步/挪步声（疑似）',
        suspected: true,
        boundary: '仅作可测代理，不确认人员身份',
        gate: 'score',
      },
      keyboard: {
        displayName: '键盘/打字声（疑似）',
        suspected: true,
        boundary: '不确认输入内容',
        gate: 'score',
      },
      quiet: {
        displayName: '安静（相对本次基线）',
        suspected: false,
        boundary: '必须同时满足第 3 章 quiet 门控',
        gate: 'state',
      },
      background: {
        displayName: '普通背景噪声',
        suspected: false,
        boundary: '不等于一定安静或一定干扰；须有表内实际分数 ≥0.55',
        gate: 'score',
      },
      other: {
        displayName: '其他声音（类别未确认）',
        suspected: false,
        boundary: '不得把所有未知都叫普通背景',
        gate: 'score',
      },
    };
    const m = meta[categoryId];
    return {
      categoryId,
      displayName: m.displayName,
      suspected: m.suspected,
      boundary: m.boundary,
      members: Object.freeze(members),
      gate: m.gate,
    } satisfies CategoryDef;
  }),
);

const CATEGORY_DEF_BY_ID = new Map<CategoryId, CategoryDef>(CATEGORY_DEFS.map((d) => [d.categoryId, d]));

/** 取类别定义；categoryId 非法时抛错（不静默兜底，避免把错误类别当 other）。 */
export function categoryDef(categoryId: CategoryId): CategoryDef {
  const def = CATEGORY_DEF_BY_ID.get(categoryId);
  if (!def) throw new Error(`ACOUSTIC_MAP_UNKNOWN_CATEGORY: ${String(categoryId)}`);
  return def;
}

/** 12 类显示名。 */
export function categoryDisplayName(categoryId: CategoryId): string {
  return categoryDef(categoryId).displayName;
}

/** 取某 index 的映射行；越界抛错。 */
export function rowForIndex(index: number): AcousticMapRow {
  const row = ACOUSTIC_MAP_ROWS[index];
  if (!row || row.index !== index) {
    throw new Error(`ACOUSTIC_MAP_INDEX_OUT_OF_RANGE: ${index}`);
  }
  return row;
}

/** 取某 index 的唯一归属类别。 */
export function groupOfIndex(index: number): CategoryId {
  return rowForIndex(index).categoryId;
}

/** 取某 index 的 mid。 */
export function midForIndex(index: number): string {
  return rowForIndex(index).mid;
}

/** 取某 index 的 CSV 原名。 */
export function displayNameForIndex(index: number): string {
  return rowForIndex(index).displayName;
}

// ---------------------------------------------------------------------------
// 分数映射
// ---------------------------------------------------------------------------

export type CategoryScores = Readonly<Record<CategoryId, number>>;

export interface MappedScores {
  /** 12 个类别分数，各为组内成员 sigmoid 分数的 max。 */
  readonly scores: CategoryScores;
  /** 521 维中非有限（NaN/Infinity）的个数；这些位置按 0 计，绝不按静音补。 */
  readonly nonFiniteCount: number;
  /** 原始 521 维中的最大分数位置（winningMid 来源，仅本机短暂保留）。 */
  readonly winningIndex: number;
  /** 原始 521 维中的最大分数对应的 mid。 */
  readonly winningMid: string;
  /** 原始 521 维中的最大分数值。 */
  readonly winningScore: number;
}

/** 组内成员分数的 max（不是 sum）。非有限值按 0 计。 */
export function maxMemberScore(scores: ArrayLike<number>, indices: readonly number[]): number {
  let best = 0;
  for (const index of indices) {
    const v = scores[index];
    if (typeof v === 'number' && Number.isFinite(v)) {
      if (v > best) best = v;
    }
  }
  return best;
}

/**
 * 521 维 sigmoid 分数 → 12 类别分数。
 *
 * - 长度必须恰为 521，否则抛 SCORE_LENGTH_MISMATCH（不截断、不补零）。
 * - 非有限值按 0 计并计数（禁止把 NaN 当静音/当高分）。
 * - 组分数 = max(成员分数)；不做归一化，不称「概率/准确率」。
 */
export function mapScoreVector(scores: ArrayLike<number>): MappedScores {
  if (scores.length !== EXPECTED_CLASS_COUNT) {
    throw new Error(`SCORE_LENGTH_MISMATCH: 期望 ${EXPECTED_CLASS_COUNT}，实际 ${scores.length}`);
  }
  let nonFiniteCount = 0;
  let winningIndex = 0;
  let winningScore = 0;
  for (let i = 0; i < scores.length; i++) {
    const v = scores[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      nonFiniteCount += 1;
      continue;
    }
    if (v > winningScore) {
      winningScore = v;
      winningIndex = i;
    }
  }
  const out = {} as Record<CategoryId, number>;
  for (const def of CATEGORY_DEFS) {
    out[def.categoryId] = maxMemberScore(scores, def.members);
  }
  return {
    scores: out,
    nonFiniteCount,
    winningIndex,
    winningMid: midForIndex(winningIndex),
    winningScore,
  };
}

/**
 * 按 §4 层级规则给 conversation 生成中文显示文案。
 * Whispering 进入有效候选时排除 0/1 泛 Speech 贡献，但保留 2/63/65 独立证据。
 */
export function conversationLabel(scores: ArrayLike<number>, whisperActive: boolean): string {
  const independent = maxMemberScore(scores, CONVERSATION_INDEPENDENT_MEMBERS);
  const generic = maxMemberScore(scores, CONVERSATION_GENERIC_MEMBERS);
  const effective = whisperActive ? independent : Math.max(independent, generic);
  if (whisperActive && generic > 0 && independent < generic) {
    return '交谈声（人数未确认）';
  }
  return effective > 0 ? '多人交谈（疑似）' : '交谈声（人数未确认）';
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

export interface AcousticMapSelfCheck {
  readonly ok: boolean;
  readonly mapVersion: string;
  readonly rowCount: number;
  readonly uniqueIndexCount: number;
  readonly uniqueMidCount: number;
  readonly categoryCount: number;
  readonly suppressAsEventCount: number;
  readonly otherCount: number;
  readonly errors: readonly string[];
}

/**
 * 映射自检：行数=521、index 连续无重复、mid 唯一、每行恰好归一个组、
 * 显式归组的 mid 与 CSV 一致、suppressAsEvent ⊆ other、12 类拼写固定。
 */
export function selfCheckAcousticMap(): AcousticMapSelfCheck {
  const errors: string[] = [];
  const rows = ACOUSTIC_MAP_ROWS;

  if (rows.length !== EXPECTED_CLASS_COUNT) {
    errors.push(`行数应为 ${EXPECTED_CLASS_COUNT}，实际 ${rows.length}`);
  }

  const seenIndex = new Set<number>();
  const seenMid = new Set<string>();
  let previousIndex = -1;
  for (const row of rows) {
    if (seenIndex.has(row.index)) errors.push(`index 重复: ${row.index}`);
    seenIndex.add(row.index);
    if (row.index !== previousIndex + 1) {
      errors.push(`index 不连续: ${previousIndex} → ${row.index}`);
    }
    previousIndex = row.index;
    if (seenMid.has(row.mid)) errors.push(`mid 重复: ${row.mid}`);
    seenMid.add(row.mid);
    if (!CATEGORY_IDS.includes(row.categoryId)) {
      errors.push(`index ${row.index} 归属非法类别 ${String(row.categoryId)}`);
    }
  }

  if (CATEGORY_DEFS.length !== 12) {
    errors.push(`类别数应为 12，实际 ${CATEGORY_DEFS.length}`);
  }
  const defIds = CATEGORY_DEFS.map((d) => d.categoryId);
  for (const id of CATEGORY_IDS) {
    if (!defIds.includes(id)) errors.push(`缺少类别定义: ${id}`);
  }

  // 每行恰好归一个组：组内成员 index 不重叠（buildIndexToCategory 已保证），
  // 且每个成员 index 在表中的 categoryId 与所属组一致。
  for (const group of EXPLICIT_GROUPS) {
    for (const [index, mid] of group.members) {
      const row = rows[index];
      if (!row) {
        errors.push(`显式归组的 index ${index} 不在表内`);
        continue;
      }
      if (row.categoryId !== group.categoryId) {
        errors.push(`index ${index} 表中归属 ${row.categoryId}，显式组为 ${group.categoryId}`);
      }
      if (row.mid !== mid) {
        errors.push(`index ${index} mid 不一致: CSV=${row.mid} §4=${mid}`);
      }
    }
  }

  // 每个 index 恰好出现一次于「显式组 ∪ other」
  let explicitCount = 0;
  for (const group of EXPLICIT_GROUPS) explicitCount += group.members.length;
  const otherCount = rows.filter((r) => r.categoryId === 'other').length;
  if (explicitCount + otherCount !== rows.length) {
    errors.push(`归组覆盖不完整: 显式 ${explicitCount} + other ${otherCount} ≠ ${rows.length}`);
  }

  for (const index of SUPPRESS_AS_EVENT_INDICES) {
    const row = rows[index];
    if (!row) {
      errors.push(`suppressAsEvent index ${index} 不在表内`);
    } else if (row.categoryId !== 'other') {
      errors.push(`suppressAsEvent index ${index} 应属 other，实际 ${row.categoryId}`);
    } else if (!row.suppressAsEvent) {
      errors.push(`suppressAsEvent index ${index} 未标记`);
    }
  }

  return {
    ok: errors.length === 0,
    mapVersion: MAP_VERSION,
    rowCount: rows.length,
    uniqueIndexCount: seenIndex.size,
    uniqueMidCount: seenMid.size,
    categoryCount: CATEGORY_DEFS.length,
    suppressAsEventCount: SUPPRESS_AS_EVENT_INDICES.length,
    otherCount,
    errors,
  };
}

/** 仅供生成器/测试使用：内嵌 CSV 源文本。 */
export function embeddedCsvText(): string {
  return MAP_CSV_TEXT;
}
