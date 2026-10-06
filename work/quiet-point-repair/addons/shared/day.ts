/**
 * 日界工具（**纯函数、无 IO、无时区库**）：F4 打卡与 F8-c 共同存在信号都按 **Asia/Shanghai 日界**。
 *
 * 为什么固定 +08:00 就够（不是偷懒）：
 *  · Asia/Shanghai 常驻 **UTC+8、无夏令时**（1986–1991 的历史夏令时早已过去，产品只处理当下日期）；
 *  · 所以 `day = floor((epochMs + 8h) / 24h)` 与 IANA `Asia/Shanghai` 的日历日**逐日相等**；
 *  · 不引第三方时区库 ⇒ 不增打包体积、不受宿主 ICU/tzdata 版本影响，日界行为**完全确定**、可复算。
 *
 * 纪律（Sol §2.6C「日期按 Asia/Shanghai 日界」「跨午夜、设备时钟异常需确定性行为」）：
 *  · 一切判定都走本文件，**不接受**客户端传上来的本地时区/偏移；
 *  · 非法日期（`2026-02-30`、`2026-13-01`）必须**当场判假**，不允许被 Date 静默归一成别的日子。
 */

/** Asia/Shanghai = UTC+8（无夏令时）。 */
export const SHANGHAI_OFFSET_MS = 8 * 3_600_000;
export const DAY_MS = 86_400_000;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** epoch 毫秒 ⇒ 该瞬间在 Asia/Shanghai 的日历日 `YYYY-MM-DD`。 */
export function shanghaiDayOf(epochMs: number): string {
  return new Date(epochMs + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

/** Asia/Shanghai 日历日 ⇒ 自 1970-01-01 起的天序号（整数）。非法输入抛错，不静默归一。 */
export function dayToEpochDay(day: string): number {
  if (!DAY_PATTERN.test(day)) throw new Error(`BAD_DAY:${day}`);
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  if (month < 1 || month > 12 || date < 1 || date > 31) throw new Error(`BAD_DAY:${day}`);
  const ms = Date.UTC(year, month - 1, date);
  const roundTrip = new Date(ms);
  // 2026-02-30 会被 Date 归一成 2026-03-02 ⇒ 回环不等即判假。
  if (roundTrip.getUTCFullYear() !== year || roundTrip.getUTCMonth() !== month - 1 || roundTrip.getUTCDate() !== date) {
    throw new Error(`BAD_DAY:${day}`);
  }
  return ms / DAY_MS;
}

/** 天序号 ⇒ `YYYY-MM-DD`（与 `dayToEpochDay` 互逆）。非有限/非整数一律抛错，不静默截断。 */
export function epochDayToDay(epochDay: number): string {
  if (!Number.isInteger(epochDay)) throw new Error(`BAD_EPOCH_DAY:${epochDay}`);
  const date = new Date(epochDay * DAY_MS);
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** 合法日历日？不抛错的判定版（给 zod refine 用）。 */
export function isValidDay(day: unknown): day is string {
  if (typeof day !== 'string') return false;
  try {
    return epochDayToDay(dayToEpochDay(day)) === day;
  } catch {
    return false;
  }
}

/** 日期加减天数（纯日历运算，不涉及时分秒）。 */
export function addDays(day: string, delta: number): string {
  return epochDayToDay(dayToEpochDay(day) + delta);
}

/** `a - b`，单位=天（可为负）。 */
export function diffDays(a: string, b: string): number {
  return dayToEpochDay(a) - dayToEpochDay(b);
}
