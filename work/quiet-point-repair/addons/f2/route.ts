/**
 * F2 新增端点（**只在 3002 附加服务**上挂；绝不在原 `server/index.ts` 挂路由）：
 *
 *   POST /v1/correlations/read   —— 无副作用读取，产出 `category-pearson-v1`
 *
 * body 白名单：`{schemaVersion, from, to, passports:[{sessionId,scoreRevision,provenance,scoreAckObserved}]}`，
 * 最多 1000 条 passport（超限**明确报错**，不静默截断）；明文 key 只在原名 `X-Study-Key` 请求头里，
 * 跨 owner 与不存在同为 404。
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AddonError, errorBody, ownerHashFrom } from '../shared/owner.js';
import { readOnlySnapshot } from './read-model.js';
import {
  ASSOCIATION_SCHEMA_VERSION,
  acceptSession,
  groupedCategoryPearson,
  type AssociationReply,
  type Passport,
  type SessionPair,
} from './eligibility.js';

export const PASSPORT_MAX = 1000;
/** 分析范围上限（半开区间 [from,to)），与旧 `MAX_RANGE_DAYS` 同量级但不复用旧查询。 */
export const RANGE_MAX_DAYS = 366;

const passportSchema = z
  .object({
    sessionId: z.string().uuid(),
    scoreRevision: z.number().int().finite().min(0),
    provenance: z.string().min(1).max(32),
    scoreAckObserved: z.boolean(),
  })
  .strict();

export const readRequestSchema = z
  .object({
    schemaVersion: z.literal(ASSOCIATION_SCHEMA_VERSION),
    from: z.number().int().finite().positive(),
    to: z.number().int().finite().positive(),
    passports: z.array(passportSchema).max(PASSPORT_MAX),
  })
  .strict();

export type ReadRequest = z.infer<typeof readRequestSchema>;

/**
 * 纯编排：只读快照 → 一 session 一行 → 逐 session 资格 → 分组 Pearson。
 * 一 session 最多一对样本（revision 更高的行替换旧的，不叠加）。
 */
export function readAssociations(
  dbPath: string,
  ownerHash: string,
  request: ReadRequest,
  now: number,
): AssociationReply {
  const snapshot = readOnlySnapshot(dbPath, ownerHash, request.from, request.to);
  if (!snapshot.available) {
    throw new AddonError('STORE_UNAVAILABLE', `附加服务只读快照不可用：${snapshot.reason ?? 'unknown'}`);
  }
  const exclusions: Record<string, number> = {};
  const bump = (reason: string): void => {
    exclusions[reason] = (exclusions[reason] ?? 0) + 1;
  };

  const byId = new Map<string, Passport>();
  for (const p of request.passports) byId.set(p.sessionId, p);

  // 「一 session 一 row」由主键保证；这里仍按 scoreRevision 取最大，防止未来视图漂移。
  const latest = new Map<string, (typeof snapshot.sessions)[number]>();
  for (const row of snapshot.sessions) {
    const prev = latest.get(row.sessionId);
    if (prev === undefined || row.scoreRevision > prev.scoreRevision) latest.set(row.sessionId, row);
  }
  const bucketsBySession = new Map<string, typeof snapshot.buckets>();
  for (const b of snapshot.buckets) {
    const list = bucketsBySession.get(b.sessionId);
    if (list === undefined) bucketsBySession.set(b.sessionId, [b]);
    else list.push(b);
  }

  const accepted: SessionPair[] = [];
  let blockedProcessingN = 0;
  for (const [sessionId, row] of [...latest.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const outcome = acceptSession(row, bucketsBySession.get(sessionId) ?? [], byId.get(sessionId));
    if (outcome.ok) {
      accepted.push(outcome.pair);
      continue;
    }
    if (outcome.reason === 'blocked_unknown_processing') blockedProcessingN += 1;
    bump(outcome.reason);
  }

  const groups = groupedCategoryPearson(accepted);
  return {
    schemaVersion: ASSOCIATION_SCHEMA_VERSION,
    computedAt: now,
    range: { from: request.from, to: request.to },
    acceptedSessionN: accepted.length,
    blockedProcessingN,
    groups,
    exclusions,
  };
}

export interface CorrelationsRouterOptions {
  /** 只读打开的旧库路径（**只读**连接，绝不写）。 */
  dbPath: string;
  now?: () => number;
}

export function createCorrelationsRouter(options: CorrelationsRouterOptions): Router {
  const router = Router();
  const now = options.now ?? (() => Date.now());

  router.post('/v1/correlations/read', (req: Request, res: Response, next: NextFunction) => {
    try {
      const ownerHash = ownerHashFrom(req.headers as Record<string, unknown>, (v) => createHash('sha256').update(v).digest('hex'));
      const parsed = readRequestSchema.parse(req.body);
      if (parsed.to <= parsed.from) throw new AddonError('VALIDATION_FAILED', '范围非法：to 必须大于 from');
      if (parsed.to - parsed.from > RANGE_MAX_DAYS * 86_400_000) {
        throw new AddonError('VALIDATION_FAILED', `范围过大：最多 ${RANGE_MAX_DAYS} 天`);
      }
      if (Buffer.byteLength(JSON.stringify(parsed.passports), 'utf8') > 64 * 1024) {
        throw new AddonError('PAYLOAD_TOO_LARGE_PASSPORTS', 'passport 体积超限（≤64KiB）');
      }
      const reply = readAssociations(options.dbPath, ownerHash, parsed, now());
      res.json(reply);
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

  // 统一错误体；非本路由的错误原样交回（附加服务没有别的路由，故直接回 500）。
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AddonError) {
      res.status(err.status).json(errorBody(err));
      return;
    }
    const message = err instanceof Error ? err.message : '附加服务内部错误';
    const code = message === 'PAIR_CONTRACT' || message === 'STAT_NUMERIC' ? 'AGGREGATE_CONTRACT' : 'STORE_UNAVAILABLE';
    const fallback = new AddonError(code as 'AGGREGATE_CONTRACT' | 'STORE_UNAVAILABLE', message);
    res.status(fallback.status).json(errorBody(fallback));
  });

  return router;
}
