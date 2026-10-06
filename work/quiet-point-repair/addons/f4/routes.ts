/**
 * F4 新增端点（**只在 3002 附加服务**上挂；绝不在原 `server/index.ts` 挂路由）：
 *
 *   POST /v1/checkin        —— 打卡（幂等键 = 日期 + 匿名设备标识）
 *   GET  /v1/checkin/today  —— 今日状态 + 连续天数 + 今日标语
 *
 * 服务端纪律（SCOPE_FINAL §21:20 + SOL_ENHANCE_A_REVIEW_6 §2.6C）：
 *  · 身份**只**取 `X-Study-Key` 头（沿用既有匿名鉴权方式）⇒ `owner = sha256(key)`；
 *    body 里出现 `deviceId`/`owner` 等未声明字段**直接 400**（`.strict()`），换 ID 冒充不了别人；
 *  · 「今天」由**服务端时钟 + Asia/Shanghai 日界**决定；客户端提交的日期只作为「离线发生日期」，
 *    超出回补窗口或落在未来 ⇒ 明确 400，**不静默改写**成今天；
 *  · 客户端提交的 `streak` 一律**忽略**（不作为真源）；响应里的 streak/motto 全部服务端复算；
 *  · 本路由**不读**旧库、**不写**旧库、**不签发**任何采音意图（不 import 任何采集模块）。
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AddonError, errorBody, ownerHashFrom } from '../shared/owner.js';
import { DataStoreError } from '../shared/atomic-json.js';
import { isValidDay, shanghaiDayOf } from '../shared/day.js';
import { checkinRequestSchema } from './contract.js';
import { CheckinStore } from './store.js';

export interface CheckinRouterOptions {
  store: CheckinStore;
  now?: () => number;
}

/** `DataStoreError` → HTTP 语义（与 F3 同款映射；新码只在 `shared/owner.ts` 里增量登记）。 */
function translate(err: unknown): AddonError {
  if (err instanceof AddonError) return err;
  if (err instanceof DataStoreError) {
    const known = ['STORE_UNAVAILABLE', 'STORE_CAPACITY', 'IDEMPOTENCY_CONFLICT', 'CHECKIN_DATE_FUTURE', 'CHECKIN_DATE_TOO_OLD'];
    if (known.includes(err.code)) return new AddonError(err.code as 'STORE_UNAVAILABLE', err.message);
    return new AddonError('STORE_UNAVAILABLE', err.message);
  }
  return new AddonError('STORE_UNAVAILABLE', err instanceof Error ? err.message : '附加服务内部错误');
}

export function createCheckinRouter(options: CheckinRouterOptions): Router {
  const router = Router();
  const now = options.now ?? (() => Date.now());
  const hash = (v: string): string => createHash('sha256').update(v).digest('hex');

  router.post('/v1/checkin', (req: Request, res: Response, next: NextFunction) => {
    try {
      const owner = ownerHashFrom(req.headers as Record<string, unknown>, hash);
      const parsed = checkinRequestSchema.parse(req.body);
      const ack = options.store.checkin({ owner, date: parsed.date, roomId: parsed.roomId ?? null });
      res.json(ack);
    } catch (err) {
      if (err instanceof z.ZodError) {
        const first = err.issues[0];
        const path = first ? first.path.join('.') : '';
        next(new AddonError('VALIDATION_FAILED', path ? `字段 ${path} 不合法：${first.message}` : '请求体不合法'));
        return;
      }
      next(err);
    }
  });

  router.get('/v1/checkin/today', (req: Request, res: Response, next: NextFunction) => {
    try {
      const owner = ownerHashFrom(req.headers as Record<string, unknown>, hash);
      const raw = req.query.date;
      const serverToday = shanghaiDayOf(now());
      let day = serverToday;
      if (raw !== undefined) {
        if (typeof raw !== 'string' || !isValidDay(raw)) {
          throw new AddonError('VALIDATION_FAILED', 'date 必须是合法的 YYYY-MM-DD 日期');
        }
        if (raw > serverToday) throw new AddonError('CHECKIN_DATE_FUTURE', `查询日期 ${raw} 晚于服务端今天 ${serverToday}`);
        day = raw;
      }
      res.json(options.store.today(owner, day));
    } catch (err) {
      next(err);
    }
  });

  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const addon = translate(err);
    res.status(addon.status).json(errorBody(addon));
  });

  return router;
}
