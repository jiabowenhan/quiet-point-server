/**
 * F3 新增端点（**只在 3002 附加服务**上挂；绝不在原 `server/index.ts` 挂路由）：
 *
 *   POST /v1/room-index  —— 收一条**聚合指数报告**
 *   GET  /v1/rooms       —— 匿名房间列表（指数 + 新鲜度）
 *
 * 服务端纪律（Sol §1 D ②③）：
 *  · 只接受 `provenance==='real'` 且 passport 与 session 一致的报告；measurement/fixture/unknown 一律 400；
 *  · 不信客户端自报的 `quietIndex` 与时间：从只读库核对同 owner 的 session/room 与对应已 ACK 桶，
 *    **重新聚合**后才算指数；
 *  · `serverReceivedAt` / `serverSeq` 由附加服务生成；重试同 reportId 不刷新新鲜度；
 *  · `evidenceEndAt = min(末桶 receivedAt, serverSessionStart + 末桶 endOffsetMs)`（服务端可信时间锚）；
 *  · 跨 owner 与不存在同为 404（不泄漏存在性）。
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AddonError, errorBody, ownerHashFrom } from '../shared/owner.js';
import { readAckedAggregate } from '../f2/read-model.js';
import { ROOM_REPORT_SCHEMA_VERSION, compareFreshSameConfigThenValueThenStableRoomId, listRoomIds, roomReportSchema } from './contract.js';
import { canonicalKeysOf, judgeClaims } from './canonical.js';
import { RoomIndexStore, StoreError, type RoomAck } from './store.js';

export interface RoomIndexRouterOptions {
  dbPath: string;
  store: RoomIndexStore;
  now?: () => number;
}

function translate(err: unknown): AddonError {
  if (err instanceof AddonError) return err;
  if (err instanceof StoreError) {
    if (err.code === 'STORE_UNAVAILABLE') return new AddonError('STORE_UNAVAILABLE', err.message);
    if (err.code === 'STORE_CAPACITY') return new AddonError('STORE_CAPACITY', err.message);
    if (err.code === 'IDEMPOTENCY_CONFLICT') return new AddonError('IDEMPOTENCY_CONFLICT', err.message);
    return new AddonError('STORE_UNAVAILABLE', err.message);
  }
  return new AddonError('STORE_UNAVAILABLE', err instanceof Error ? err.message : '附加服务内部错误');
}

export function createRoomIndexRouter(options: RoomIndexRouterOptions): Router {
  const router = Router();
  const now = options.now ?? (() => Date.now());
  const hash = (v: string): string => createHash('sha256').update(v).digest('hex');

  router.post('/v1/room-index', (req: Request, res: Response, next: NextFunction) => {
    try {
      const owner = ownerHashFrom(req.headers as Record<string, unknown>, hash);
      const parsed = roomReportSchema.parse(req.body);
      if (parsed.schemaVersion !== ROOM_REPORT_SCHEMA_VERSION) {
        throw new AddonError('SCHEMA_VERSION_UNSUPPORTED', '未知 schemaVersion');
      }
      if (parsed.provenance !== 'real') throw new AddonError('NON_REAL_REPORT', '只接受 provenance=real 的报告');
      if (parsed.passport.sessionId !== parsed.sessionId || parsed.passport.explicitCaptureObserved !== true) {
        throw new AddonError('NON_REAL_REPORT', 'passport 与 session 不一致或缺少显式采集证据');
      }
      if (parsed.lastBucket < parsed.firstBucket) throw new AddonError('AGGREGATE_CONTRACT', '桶区间非法');
      const authoritative = readAckedAggregate(options.dbPath, owner, parsed.sessionId, parsed.firstBucket, parsed.lastBucket);
      if (!authoritative.found) throw new AddonError('ROOM_SESSION_MISMATCH', '同一 owner 下没有该 session/桶区间');
      if (authoritative.roomId !== parsed.roomId) throw new AddonError('ROOM_SESSION_MISMATCH', 'roomId 与该 session 不符');
      const aggregate = authoritative.aggregate;
      if (aggregate === null) throw new AddonError('AGGREGATE_CONTRACT', '权威聚合不可用');
      if (aggregate.spanMs !== parsed.aggregate.spanMs || aggregate.quietMs !== parsed.aggregate.quietMs
        || aggregate.noisyMs !== parsed.aggregate.noisyMs || aggregate.unknownMs !== parsed.aggregate.unknownMs
        || aggregate.validInferenceMs !== parsed.aggregate.validInferenceMs) {
        throw new AddonError('EVIDENCE_MISMATCH', '上报聚合与只读库中的已 ACK 桶不一致');
      }
      const receivedAt = now();
      const evidenceEndAt = authoritative.lastBucketReceivedAt === null || authoritative.lastBucketEndOffsetMs === null
        ? null
        : Math.min(authoritative.lastBucketReceivedAt, authoritative.serverSessionStart + authoritative.lastBucketEndOffsetMs);
      // C6/Sol §2.5 F3：分组键**一律**由服务端读回的数据复算；客户端声明只被核对，不被采用。
      if (authoritative.canonical === null) throw new AddonError('EVIDENCE_MISMATCH', '缺少服务端权威分组维度');
      const canonical = canonicalKeysOf(authoritative.canonical);
      const verdict = judgeClaims({ configKey: parsed.configKey, processingKey: parsed.processingKey }, canonical);
      if (!verdict.ok) throw new AddonError(verdict.reason, verdict.detail);
      const ack: RoomAck = options.store.accept({
        owner,
        dto: parsed,
        aggregate,
        canonical,
        claimMatched: { configKey: verdict.configKeyClaimMatched, processingKey: verdict.processingKeyClaimMatched },
        evidenceReceivedAt: authoritative.lastBucketReceivedAt,
        evidenceEndAt,
        receivedAt,
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

  router.get('/v1/rooms', (req: Request, res: Response, next: NextFunction) => {
    try {
      // 仍需凭据（拒绝匿名探测），但输出只有匿名房间聚合。
      ownerHashFrom(req.headers as Record<string, unknown>, hash);
      const at = now();
      const { rooms: stored, corrupted } = options.store.listRooms(at);
      const byId = new Map(stored.map((r) => [r.roomId, r]));
      const rooms = listRoomIds().map((id) => byId.get(id) ?? {
        roomId: id,
        indexVersion: 'quiet-known-v1' as const,
        quietIndex: null,
        status: 'unknown' as const,
        reason: corrupted ? 'store_corrupted' : 'no_report',
        serverReceivedAt: null,
        evidenceReceivedAt: null,
        evidenceEndAt: null,
        serverSeq: null,
        ageSeconds: null,
        terminalCount: 0,
        configKey: null,
        processingKey: null,
      });
      rooms.sort(compareFreshSameConfigThenValueThenStableRoomId);
      res.json({ schemaVersion: 'room-view-v1', computedAt: at, storeCorrupted: corrupted, rooms });
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
