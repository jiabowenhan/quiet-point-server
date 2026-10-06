/**
 * F4（每日打卡＋鼓励标语，联网版）契约与**纯**函数。
 *
 * 冻结口径（SCOPE_FINAL §21:20 + SOL_ENHANCE_A_REVIEW_6 §2.6C）：
 *  · 幂等键 = **日期 + 匿名设备标识**；设备标识**只能**来自既有可信身份（`X-Study-Key` 的 sha256），
 *    body 里**不接受**任何设备/匿名 ID 字段（`.strict()` 直接 400）⇒ 谁也不能换 ID 冒充别人；
 *  · 只存 `date / roomId? / streak / mottoIndex`（外加服务端时间/序号）；**不存** PCM、评分、备注、设备明文；
 *  · **streak 服务端从唯一日期集合复算** —— 客户端提交的 `streak` 字段被**显式忽略**（不是真源）；
 *  · 日期按 **Asia/Shanghai 日界**（见 `shared/day.ts`）；回补窗口有界，未来日期一律拒绝；
 *  · 标语**本地内置**（固定一组、按连续天数挑选、循环不重复轰炸），**不含任何个人数据**。
 */

import { z } from 'zod';
import { roomSchema } from '../../shared/model.js';
import { addDays, diffDays, isValidDay } from '../shared/day.js';

export const CHECKIN_REPORT_SCHEMA_VERSION = 'checkin-report-v1';
export const CHECKIN_ACK_SCHEMA_VERSION = 'checkin-ack-v1';
export const CHECKIN_TODAY_SCHEMA_VERSION = 'checkin-today-v1';

/**
 * 允许回补的天数上限（离线 pending 只能在窗口内补传）。
 * 与客户端 pending 队列的 TTL 一致：更旧的记录服务端会**明确拒绝**（不是静默丢弃）。
 */
export const MAX_BACKFILL_DAYS = 7;
/** 有界保留：每设备最多保留 180 天打卡（连续天数上限因此 = 180，超过部分不假装记得）。 */
export const RETENTION_DAYS = 180;

/**
 * 内置标语（固定一组、纯文案、**无任何个人数据**：无数字/日期/姓名占位符）。
 * 挑选规则见 `mottoFor`：连续天数每 +1，索引 +1 取模 ⇒ 相邻两天必然不同（不重复轰炸）。
 */
export const MOTTOS: readonly string[] = [
  '今天也来坐一会儿，很好。',
  '安静的时间正在一点一点攒起来。',
  '你已经把它变成习惯了。',
  '坐下来的这一刻，就已经在往前走了。',
  '不用着急，慢慢来就好。',
  '今天的安静，属于你自己。',
  '一直做着同一件小事，很了不起。',
  '明天要是也能来，就更好了。',
];

/** 标语选择（**确定性**）：streak ≤ 0 ⇒ 索引 0；否则索引 = (streak − 1) mod N。 */
export function mottoFor(streak: number): { index: number; text: string } {
  const safe = Number.isFinite(streak) ? Math.max(0, Math.trunc(streak)) : 0;
  const index = safe <= 0 ? 0 : (safe - 1) % MOTTOS.length;
  return { index, text: MOTTOS[index] as string };
}

/** 截止 `day` 的连续天数（`day` 必须**本身**在集合里；否则返回 0）。 */
export function streakEndingOn(dates: ReadonlySet<string>, day: string): number {
  let run = 0;
  let cursor = day;
  while (dates.has(cursor)) {
    run += 1;
    cursor = addDays(cursor, -1);
  }
  return run;
}

/**
 * 「当前连续天数」：以 `day` 为观察日。
 *  · 当天已打卡 ⇒ 就是截止当天的连续段；
 *  · 当天未打卡 ⇒ 取**截止昨天**的连续段（今天还能续上，所以不算断）。
 *  两种情况都由同一份唯一日期集合复算，客户端提交值不参与。
 */
export function streakAsOf(dates: ReadonlySet<string>, day: string): number {
  if (dates.has(day)) return streakEndingOn(dates, day);
  return streakEndingOn(dates, addDays(day, -1));
}

/** 历史最长连续段（只用于展示，不影响幂等/streak 语义）。 */
export function longestStreak(dates: ReadonlySet<string>): number {
  const sorted = [...dates].sort();
  let best = 0;
  let run = 0;
  let previous: string | null = null;
  for (const day of sorted) {
    run = previous !== null && diffDays(day, previous) === 1 ? run + 1 : 1;
    if (run > best) best = run;
    previous = day;
  }
  return best;
}

/**
 * 请求体白名单（`.strict()`）：
 *  · `streak` **允许出现但被忽略**（客户端本地估算值；服务端不采信、不落盘、不进体校验哈希）；
 *  · 任何未声明字段（含 `deviceId` / `anonymousId` / `owner` 之类）⇒ 400，防换 ID 冒充。
 */
export const checkinRequestSchema = z
  .object({
    schemaVersion: z.literal(CHECKIN_REPORT_SCHEMA_VERSION),
    date: z.string().refine(isValidDay, '必须是合法的 YYYY-MM-DD 日期'),
    roomId: roomSchema.nullable().optional(),
    streak: z.number().int().finite().min(0).optional(),
  })
  .strict();
export type CheckinRequest = z.infer<typeof checkinRequestSchema>;

export interface CheckinAck {
  schemaVersion: typeof CHECKIN_ACK_SCHEMA_VERSION;
  /** 本次提交是否被接受（幂等重放 = true，因为事实已在库中）。 */
  accepted: boolean;
  /** true = 该 (date, identity) 此前已存在且内容一致 ⇒ 返回**原**记录，streak 不重复增长。 */
  duplicate: boolean;
  /** 这次提交的日期（Asia/Shanghai）。 */
  date: string;
  /** 服务端权威「今天」（Asia/Shanghai）——客户端拿去校准本地时钟。 */
  serverToday: string;
  /** 截止 `date` 的连续天数（服务端复算）。 */
  streak: number;
  /** 截止 `serverToday` 的连续天数（UI 显示用；回补旧日期时与 streak 可能不同）。 */
  currentStreak: number;
  mottoIndex: number;
  motto: string;
  roomId: string | null;
  /** >0 表示这条是**回补**（date < serverToday），不能被洗成今天。 */
  backfilled: boolean;
  serverSeq: number;
  serverReceivedAt: number;
  reason: string | null;
}

export interface CheckinTodayView {
  schemaVersion: typeof CHECKIN_TODAY_SCHEMA_VERSION;
  /** 被查询的那一天（Asia/Shanghai）。 */
  date: string;
  serverToday: string;
  /** true/false = 已核验；**null = 存储不可核验**（缺证时不假装"没打卡"）。 */
  checkedIn: boolean | null;
  streak: number | null;
  longestStreak: number | null;
  mottoIndex: number | null;
  motto: string | null;
  roomId: string | null;
  lastCheckinDate: string | null;
  serverSeq: number | null;
  storeCorrupted: boolean;
  reason: string | null;
}
