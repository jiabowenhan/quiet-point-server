/**
 * F4 契约与纯函数（无 IO、无网络）：日界、日历日合法性、streak 复算、标语挑选、请求体白名单。
 *
 * 覆盖 Sol §2.6C 的「最小关闭证据」里与纯函数有关的部分：
 *  · 日期按 **Asia/Shanghai 日界**（UTC 16:00 换日）；
 *  · **跨日/断日 streak** 由唯一日期集合复算（客户端提交值不作真源）；
 *  · 标语**本地内置**、按连续天数挑选、**不含任何个人数据**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BACKFILL_DAYS,
  MOTTOS,
  checkinRequestSchema,
  longestStreak,
  mottoFor,
  streakAsOf,
  streakEndingOn,
} from '../f4/contract.js';
import { addDays, diffDays, epochDayToDay, isValidDay, shanghaiDayOf } from '../shared/day.js';

test('F4-1 Asia/Shanghai 日界：UTC 15:59:59 仍算当天，16:00:00 换日', () => {
  assert.equal(shanghaiDayOf(Date.UTC(2026, 9, 4, 15, 59, 59)), '2026-10-04');
  assert.equal(shanghaiDayOf(Date.UTC(2026, 9, 4, 16, 0, 0)), '2026-10-05');
  // 跨月边界同样成立。
  assert.equal(shanghaiDayOf(Date.UTC(2026, 0, 31, 16, 0, 0)), '2026-02-01');
  // 闰年 2 月 29 日存在，且次日是 3 月 1 日（不接受 Date 静默归一）。
  assert.equal(shanghaiDayOf(Date.UTC(2024, 1, 29, 4, 0, 0)), '2024-02-29');
  assert.equal(addDays('2024-02-29', 1), '2024-03-01');
});

test('F4-2 日历日合法性：非法日期当场判假（不静默归一）', () => {
  assert.equal(isValidDay('2026-10-05'), true);
  assert.equal(isValidDay('2024-02-29'), true);
  assert.equal(isValidDay('2026-02-30'), false);
  assert.equal(isValidDay('2026-13-01'), false);
  assert.equal(isValidDay('2026-00-10'), false);
  assert.equal(isValidDay('2026-1-1'), false);
  assert.equal(isValidDay('today'), false);
  assert.equal(isValidDay(20261005), false);
  // 回环不等的日期一律判假。
  assert.throws(() => epochDayToDay(Number.NaN));
});

test('F4-3 日期加减与差值跨月/跨年正确', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2027-01-01', -1), '2026-12-31');
  assert.equal(diffDays('2026-10-05', '2026-10-04'), 1);
  assert.equal(diffDays('2026-10-04', '2026-10-05'), -1);
  assert.equal(diffDays('2027-03-01', '2026-03-01'), 365);
});

test('F4-4 streak：截止某日 / 作为观察日，都由唯一日期集合复算', () => {
  const dates = new Set(['2026-10-01', '2026-10-02', '2026-10-04', '2026-10-05']);
  // 断档：10-03 缺失 ⇒ 截止 10-05 的连续段长度是 2（不是 4）。
  assert.equal(streakEndingOn(dates, '2026-10-05'), 2);
  assert.equal(streakEndingOn(dates, '2026-10-04'), 1);
  assert.equal(streakEndingOn(dates, '2026-10-03'), 0);
  // 观察日当天已打卡 ⇒ 截止当天。
  assert.equal(streakAsOf(dates, '2026-10-05'), 2);
  // 观察日当天未打卡 ⇒ 取截止昨天（今天还能续上，不算断）。
  assert.equal(streakAsOf(dates, '2026-10-06'), 2);
  // 断开两天 ⇒ 归零。
  assert.equal(streakAsOf(dates, '2026-10-07'), 0);
  // 空集合恒为 0。
  assert.equal(streakAsOf(new Set<string>(), '2026-10-05'), 0);
  // 乱序插入不影响结果（唯一集合，不是数组顺序）。
  const shuffled = new Set(['2026-10-05', '2026-10-01', '2026-10-04', '2026-10-02']);
  assert.equal(streakAsOf(shuffled, '2026-10-05'), 2);
});

test('F4-5 最长连续段只作展示，不影响 streak 语义', () => {
  const dates = new Set(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-10', '2026-01-11']);
  assert.equal(longestStreak(dates), 3);
  assert.equal(longestStreak(new Set<string>()), 0);
  assert.equal(longestStreak(new Set(['2026-01-01'])), 1);
});

test('F4-6 标语：固定一组、确定性挑选、相邻天数不重复轰炸、不含个人数据', () => {
  assert.ok(MOTTOS.length >= 4);
  // streak ≤ 0 ⇒ 索引 0；之后每 +1 天索引 +1，取模循环。
  assert.equal(mottoFor(0).index, 0);
  assert.equal(mottoFor(-3).index, 0);
  assert.equal(mottoFor(1).index, 0);
  assert.equal(mottoFor(2).index, 1);
  assert.equal(mottoFor(MOTTOS.length + 1).index, 0);
  assert.equal(mottoFor(1.9).index, 0); // 非整数一律截断，不抛错
  // 连续天数相邻 ⇒ 索引必然不同（不重复轰炸）。
  for (let streak = 1; streak < MOTTOS.length; streak += 1) {
    assert.notEqual(mottoFor(streak).index, mottoFor(streak + 1).index);
  }
  // 文案本身：无数字、无日期、无模板占位符、无身份字样。
  for (const line of MOTTOS) {
    assert.equal(/\d/.test(line), false, `标语不应含数字：${line}`);
    assert.equal(/[{}%]/.test(line), false, `标语不应含占位符：${line}`);
    assert.equal(/2026|打卡|设备|ID/i.test(line), false, `标语不应含时间/身份信息：${line}`);
    assert.ok(line.length > 0 && line.length <= 40);
  }
  // 全部是中文串，且去重后数量一致（没有复制粘贴糊弄）。
  assert.equal(new Set(MOTTOS).size, MOTTOS.length);
});

test('F4-7 请求体白名单：拒收任何设备/匿名 ID 字段；streak 允许出现但只是陪跑', () => {
  const ok = checkinRequestSchema.safeParse({ schemaVersion: 'checkin-report-v1', date: '2026-10-05' });
  assert.equal(ok.success, true);
  if (ok.success) assert.equal(ok.data.streak, undefined);
  const withRoom = checkinRequestSchema.safeParse({ schemaVersion: 'checkin-report-v1', date: '2026-10-05', roomId: 'study-201' });
  assert.equal(withRoom.success, true);
  const withNullRoom = checkinRequestSchema.safeParse({ schemaVersion: 'checkin-report-v1', date: '2026-10-05', roomId: null });
  assert.equal(withNullRoom.success, true);
  // 客户端自称的 streak 允许出现（服务端会忽略），但不接受任何身份字段。
  assert.equal(checkinRequestSchema.safeParse({ schemaVersion: 'checkin-report-v1', date: '2026-10-05', streak: 99 }).success, true);
  for (const field of ['deviceId', 'anonymousId', 'owner', 'ownerHash', 'terminalId']) {
    const res = checkinRequestSchema.safeParse({ schemaVersion: 'checkin-report-v1', date: '2026-10-05', [field]: 'x' });
    assert.equal(res.success, false, `应拒绝字段 ${field}`);
  }
  // 版本 / 日期 / 房间号非法一律拒绝。
  assert.equal(checkinRequestSchema.safeParse({ schemaVersion: 'nope', date: '2026-10-05' }).success, false);
  assert.equal(checkinRequestSchema.safeParse({ schemaVersion: 'checkin-report-v1', date: '2026-02-30' }).success, false);
  assert.equal(checkinRequestSchema.safeParse({ schemaVersion: 'checkin-report-v1', date: '2026-10-05', roomId: 'nope' }).success, false);
  assert.equal(MAX_BACKFILL_DAYS, 7);
});
