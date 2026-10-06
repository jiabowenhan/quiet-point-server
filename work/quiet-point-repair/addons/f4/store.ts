/**
 * F4 打卡持久化：**独立有界 JSON**（`data-addons/checkin-v1.json`），零 SQLite 新表、零迁移。
 *
 * 红线（SCOPE_FINAL §21:20 第 2 条 + §2.6C）：
 *  · **不碰** `data/quiet.sqlite` 的 schema、**不碰** `server/**`、**不碰** 既有上传/鉴权路径；
 *  · 设备归属**只**由调用方传进来的可信 `owner`（= `sha256(X-Study-Key)`）决定 —— 本 store 根本没有
 *    「按请求体里的 ID 找设备」这条路径，所以客户端换匿名 ID 冒充不了别人；
 *  · 只存 `date / roomId / serverSeq / serverReceivedAt`；`streak`、`mottoIndex`、`motto` 是**复算视图**，
 *    **不落盘做第二真源**（§2.6C：streak 必须服务端从唯一日期集合复算）；
 *  · 有界：每设备 ≤180 天、≤16 台设备、文件 ≤2 MiB；**超限当场报错**，不静默丢新记录。
 *
 * 幂等（与 F3 store 同纪律）：同 `(date, owner)` 且 roomId 一致 ⇒ 返回**原** serverSeq / 原 serverReceivedAt，
 * 不分配新序号、不刷新时间、streak 不重复增长；同 `(date, owner)` 但 roomId 不同 ⇒ 409 `IDEMPOTENCY_CONFLICT`。
 */

import {
  CHECKIN_ACK_SCHEMA_VERSION,
  CHECKIN_TODAY_SCHEMA_VERSION,
  MAX_BACKFILL_DAYS,
  MOTTOS,
  RETENTION_DAYS,
  mottoFor,
  streakAsOf,
  streakEndingOn,
  longestStreak,
  type CheckinAck,
  type CheckinTodayView,
} from './contract.js';
import { DataStoreError, fileBytes, readJsonFile, sweepTemp, writeJsonAtomic } from '../shared/atomic-json.js';
import { diffDays, shanghaiDayOf } from '../shared/day.js';

export const CHECKIN_STORE_SCHEMA_VERSION = 1;
/** 每台设备最多保留的天数（= 保留下限，也是连续天数的可核验上限）。 */
export const MAX_DATES_PER_DEVICE = RETENTION_DAYS;
/** 有界设备数（超限 507，不静默淘汰别人的打卡）。 */
export const MAX_DEVICES = 16;
/** 快照字节上限。 */
export const MAX_CHECKIN_BYTES = 2 * 1024 * 1024;

interface CheckinRecord {
  /** 归属日期（Asia/Shanghai，同时也是 map key，保留字段便于自解释与损坏排查）。 */
  date: string;
  roomId: string | null;
  serverSeq: number;
  serverReceivedAt: number;
}

interface DeviceState {
  dates: Record<string, CheckinRecord>;
}

interface StoreFile {
  schemaVersion: number;
  serverSeqHighWater: number;
  devices: Record<string, DeviceState>;
  updatedAt: number;
}

export interface CheckinCapacityState {
  corrupted: boolean;
  corruptedReason: string | null;
  deviceCount: number;
  dateCount: number;
  serverSeqHighWater: number;
  bytes: number;
}

export interface CheckinInput {
  owner: string;
  date: string;
  roomId: string | null;
}

export class CheckinStore {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private data: StoreFile | null = null;
  private corrupted = false;
  private corruptedReason: string | null = null;

  constructor(options: { filePath: string; now?: () => number; maxBytes?: number }) {
    this.filePath = options.filePath;
    this.now = options.now ?? (() => Date.now());
    this.maxBytes = options.maxBytes ?? MAX_CHECKIN_BYTES;
  }

  private empty(): StoreFile {
    return { schemaVersion: CHECKIN_STORE_SCHEMA_VERSION, serverSeqHighWater: 0, devices: {}, updatedAt: this.now() };
  }

  /** 懒加载；损坏**只标记**，绝不写回空快照（沿用 F3 纪律）。 */
  load(): void {
    if (this.data !== null || this.corrupted) return;
    const read = readJsonFile(this.filePath);
    if (read.kind === 'missing') {
      this.data = this.empty();
      return;
    }
    if (read.kind === 'corrupted') {
      this.corrupted = true;
      this.corruptedReason = read.error;
      return;
    }
    try {
      const candidate = read.value as Partial<StoreFile> | null;
      if (candidate === null || typeof candidate !== 'object') throw new Error('not_object');
      if (candidate.schemaVersion !== CHECKIN_STORE_SCHEMA_VERSION) throw new Error('bad_schema_version');
      if (typeof candidate.serverSeqHighWater !== 'number' || !Number.isFinite(candidate.serverSeqHighWater)) throw new Error('bad_high_water');
      if (typeof candidate.devices !== 'object' || candidate.devices === null) throw new Error('bad_devices');
      this.data = {
        schemaVersion: CHECKIN_STORE_SCHEMA_VERSION,
        serverSeqHighWater: candidate.serverSeqHighWater,
        devices: candidate.devices as Record<string, DeviceState>,
        updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : this.now(),
      };
    } catch (err) {
      this.corrupted = true;
      this.corruptedReason = err instanceof Error ? err.message : 'unknown';
      this.data = null;
    }
  }

  isCorrupted(): boolean {
    this.load();
    return this.corrupted;
  }

  status(): CheckinCapacityState {
    this.load();
    let deviceCount = 0;
    let dateCount = 0;
    if (this.data !== null) {
      deviceCount = Object.keys(this.data.devices).length;
      for (const device of Object.values(this.data.devices)) dateCount += Object.keys(device.dates ?? {}).length;
    }
    return {
      corrupted: this.corrupted,
      corruptedReason: this.corruptedReason,
      deviceCount,
      dateCount,
      serverSeqHighWater: this.data?.serverSeqHighWater ?? 0,
      bytes: fileBytes(this.filePath),
    };
  }

  /** 某设备的全部打卡日期（升序）。只读、供测试与运维核对，不进任何 HTTP 响应。 */
  listDates(owner: string): string[] {
    this.load();
    if (this.data === null) return [];
    return Object.keys(this.data.devices[owner]?.dates ?? {}).sort();
  }

  private datesOf(owner: string): Set<string> {
    return new Set(Object.keys(this.data?.devices[owner]?.dates ?? {}));
  }

  /**
   * 打卡（幂等）。返回的 ACK 里 `serverSeq` / `serverReceivedAt` 是**服务端生成**的权威值；
   * `streak` / `currentStreak` / `mottoIndex` 一律由唯一日期集合**复算**。
   */
  checkin(input: CheckinInput): CheckinAck {
    this.load();
    if (this.corrupted || this.data === null) {
      throw new DataStoreError('STORE_UNAVAILABLE', `打卡快照不可用：${this.corruptedReason ?? 'corrupted'}`);
    }
    const receivedAt = this.now();
    const serverToday = shanghaiDayOf(receivedAt);
    const behind = diffDays(serverToday, input.date);
    // 设备时钟异常 / 跨午夜：一律**显式判定**，不静默归一成别的日子。
    if (behind < 0) {
      throw new DataStoreError('CHECKIN_DATE_FUTURE', `提交日期 ${input.date} 晚于服务端今天 ${serverToday}`);
    }
    if (behind > MAX_BACKFILL_DAYS) {
      throw new DataStoreError('CHECKIN_DATE_TOO_OLD', `提交日期 ${input.date} 超出 ${MAX_BACKFILL_DAYS} 天回补窗口（服务端今天 ${serverToday}）`);
    }

    const roomId = input.roomId ?? null;
    const devices = this.data.devices;
    const current = devices[input.owner];
    const existing = current?.dates[input.date];
    if (existing !== undefined) {
      if ((existing.roomId ?? null) !== roomId) {
        throw new DataStoreError('IDEMPOTENCY_CONFLICT', `同一天（${input.date}）同一身份的房间不一致`);
      }
      return this.ackFor(existing, this.datesOf(input.owner), serverToday, true);
    }
    if (current === undefined && Object.keys(devices).length >= MAX_DEVICES) {
      throw new DataStoreError('STORE_CAPACITY', `打卡设备数已达 ${MAX_DEVICES} 上限`);
    }

    const serverSeq = this.data.serverSeqHighWater + 1;
    const record: CheckinRecord = { date: input.date, roomId, serverSeq, serverReceivedAt: receivedAt };
    const nextDates = { ...(current?.dates ?? {}) };
    nextDates[input.date] = record;
    const pruned = this.pruneDates(nextDates, serverToday);
    const nextDevices: Record<string, DeviceState> = { ...devices };
    if (Object.keys(pruned).length === 0) delete nextDevices[input.owner];
    else nextDevices[input.owner] = { dates: pruned };
    const nextFile: StoreFile = {
      schemaVersion: CHECKIN_STORE_SCHEMA_VERSION,
      serverSeqHighWater: serverSeq,
      devices: nextDevices,
      updatedAt: receivedAt,
    };
    sweepTemp(this.filePath);
    writeJsonAtomic(this.filePath, nextFile, this.maxBytes);
    this.data = nextFile;
    return this.ackFor(record, new Set(Object.keys(pruned)), serverToday, false);
  }

  /** 有界保留：先按保留窗口裁，再按每设备上限保留**最新**的若干天。 */
  private pruneDates(dates: Record<string, CheckinRecord>, serverToday: string): Record<string, CheckinRecord> {
    const kept: Record<string, CheckinRecord> = {};
    for (const [day, record] of Object.entries(dates)) {
      if (diffDays(serverToday, day) > RETENTION_DAYS) continue;
      kept[day] = record;
    }
    const keys = Object.keys(kept).sort();
    if (keys.length <= MAX_DATES_PER_DEVICE) return kept;
    const bounded: Record<string, CheckinRecord> = {};
    for (const day of keys.slice(keys.length - MAX_DATES_PER_DEVICE)) bounded[day] = kept[day] as CheckinRecord;
    return bounded;
  }

  private ackFor(record: CheckinRecord, dates: ReadonlySet<string>, serverToday: string, duplicate: boolean): CheckinAck {
    const currentStreak = streakAsOf(dates, serverToday);
    const motto = mottoFor(currentStreak);
    return {
      schemaVersion: CHECKIN_ACK_SCHEMA_VERSION,
      accepted: true,
      duplicate,
      date: record.date,
      serverToday,
      streak: streakEndingOn(dates, record.date),
      currentStreak,
      mottoIndex: motto.index,
      motto: motto.text,
      roomId: record.roomId,
      backfilled: record.date < serverToday,
      serverSeq: record.serverSeq,
      serverReceivedAt: record.serverReceivedAt,
      reason: null,
    };
  }

  /**
   * 今日（或指定日）视图。缺证纪律：
   *  · 存储损坏 ⇒ `checkedIn:null` + `store_corrupted`（**不**谎称"没打卡"）；
   *  · 查询日早于保留窗口 ⇒ `checkedIn:null` + `out_of_retention`（我们已经不知道了）。
   */
  today(owner: string, day: string): CheckinTodayView {
    this.load();
    const serverToday = shanghaiDayOf(this.now());
    if (this.corrupted || this.data === null) {
      return {
        schemaVersion: CHECKIN_TODAY_SCHEMA_VERSION,
        date: day,
        serverToday,
        checkedIn: null,
        streak: null,
        longestStreak: null,
        mottoIndex: null,
        motto: null,
        roomId: null,
        lastCheckinDate: null,
        serverSeq: null,
        storeCorrupted: true,
        reason: 'store_corrupted',
      };
    }
    const device = this.data.devices[owner];
    const dates = this.datesOf(owner);
    const outOfRetention = diffDays(serverToday, day) > RETENTION_DAYS;
    if (outOfRetention) {
      return {
        schemaVersion: CHECKIN_TODAY_SCHEMA_VERSION,
        date: day,
        serverToday,
        checkedIn: null,
        streak: null,
        longestStreak: null,
        mottoIndex: null,
        motto: null,
        roomId: null,
        lastCheckinDate: null,
        serverSeq: null,
        storeCorrupted: false,
        reason: 'out_of_retention',
      };
    }
    const checkedIn = dates.has(day);
    const streak = streakAsOf(dates, day);
    const motto = mottoFor(streak);
    const lastCheckinDate = [...dates].filter((d) => d <= day).sort().pop() ?? null;
    const lastRecord = lastCheckinDate === null ? undefined : device?.dates[lastCheckinDate];
    return {
      schemaVersion: CHECKIN_TODAY_SCHEMA_VERSION,
      date: day,
      serverToday,
      checkedIn,
      streak,
      longestStreak: longestStreak(dates),
      mottoIndex: motto.index,
      motto: motto.text,
      roomId: lastRecord?.roomId ?? null,
      lastCheckinDate,
      serverSeq: lastRecord?.serverSeq ?? null,
      storeCorrupted: false,
      reason: null,
    };
  }
}

/** 标语总数（供 UI/测试引用，避免各自硬编码）。 */
export const MOTTO_COUNT = MOTTOS.length;
