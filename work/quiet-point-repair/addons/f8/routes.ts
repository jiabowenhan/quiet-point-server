/**
 * F8-c 新增端点（**只在 3002 附加服务**上挂；绝不在原 `server/index.ts` 挂路由）：
 *
 *   POST /v1/presence/heartbeat       —— 心跳（开启/续期，或 `optIn:false` 立即关闭）
 *   GET  /v1/presence/room?roomId=…   —— 房间级**粗档**共同存在信号
 *
 * 服务端纪律（SCOPE_FINAL §23:35）：
 *  · 身份只取 `X-Study-Key`（去重键 = sha256(key)），**永不回显**；响应里没有名单/精确人数/别人的时间戳；
 *  · 未 opt-in 的人既看不见别人，也**不被计入**别人的视野；
 *  · 过期即消失（TTL 90 s）；读路径无写副作用；存储损坏如实 `unknown`，不假装"只有你"。
 *  · 本路由**不读**旧库、**不写**旧库、不 import 任何采集模块。
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AddonError, errorBody, ownerHashFrom } from '../shared/owner.js';
import { DataStoreError } from '../shared/atomic-json.js';
import { heartbeatSchema } from './contract.js';
import { PresenceStore } from './store.js';
import { rooms, type RoomId } from '../../shared/model.js';

export interface PresenceRouterOptions {
  store: PresenceStore;
  now?: () => number;
}

function translate(err: unknown): AddonError {
  if (err instanceof AddonError) return err;
  if (err instanceof DataStoreError) {
    if (err.code === 'STORE_CAPACITY') return new AddonError('STORE_CAPACITY', err.message);
    return new AddonError('STORE_UNAVAILABLE', err.message);
  }
  return new AddonError('STORE_UNAVAILABLE', err instanceof Error ? err.message : '附加服务内部错误');
}

const ROOM_IDS = rooms.map((r) => r.id) as readonly string[];

export function createPresenceRouter(options: PresenceRouterOptions): Router {
  const router = Router();
  const now = options.now ?? (() => Date.now());
  const hash = (v: string): string => createHash('sha256').update(v).digest('hex');

  router.post('/v1/presence/heartbeat', (req: Request, res: Response, next: NextFunction) => {
    try {
      const owner = ownerHashFrom(req.headers as Record<string, unknown>, hash);
      const parsed = heartbeatSchema.parse(req.body);
      const ack = options.store.heartbeat({
        owner,
        roomId: parsed.roomId,
        optIn: parsed.optIn,
        receivedAt: now(),
      });
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

  router.get('/v1/presence/room', (req: Request, res: Response, next: NextFunction) => {
    try {
      const owner = ownerHashFrom(req.headers as Record<string, unknown>, hash);
      const raw = req.query.roomId;
      if (typeof raw !== 'string' || !ROOM_IDS.includes(raw)) {
        throw new AddonError('VALIDATION_FAILED', 'roomId 必须是合法的房间标识');
      }
      res.json(options.store.view(owner, raw as RoomId, now()));
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
