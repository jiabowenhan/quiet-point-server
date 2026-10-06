// 阶段三：学习数据 HTTP 接口（CODEX_DECISION_AI.md §5 七接口 + 统一错误）
// 身份：X-Study-Key（匿名访问凭据）→ 后端只存 SHA256 ownerHash；key 不打印、不进 URL/SSE。
// 错误：{error:{code,message,retryable}}；未知字段一律 400（strict），超体积 413。
import express from 'express';
import { ZodError } from 'zod';
import {
  BATCH_MAX_BYTES,
  STATUS_BY_CODE,
  StudyError,
  batchSchema,
  endSchema,
  insightsQuerySchema,
  listQuerySchema,
  scoresSchema,
  studySessionCreateSchema,
  type StudyErrorCode,
} from '../shared/study-model.js';
import {
  buildInsights,
  createStudySession,
  endStudySession,
  getStudySession,
  listStudySessions,
  sha256,
  writeBatch,
  writeScores,
} from './study-store.js';

const KEY_PATTERN = /^[A-Za-z0-9_\-+/=]{22,200}$/;
const STUDY_PATH = /^\/api\/(study-sessions|study-insights|acoustic-summaries)/;

export function ownerHashFrom(headers: Record<string, unknown>): string {
  const raw = headers['x-study-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null || value === '') {
    throw new StudyError('STUDY_KEY_REQUIRED', '缺少 X-Study-Key 请求头');
  }
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    throw new StudyError('STUDY_KEY_INVALID', 'X-Study-Key 格式非法');
  }
  return sha256(value);
}

function zodMessage(err: ZodError): string {
  const first = err.issues[0];
  if (!first) return '请求体不符合契约';
  const path = first.path.join('.');
  return path ? `字段 ${path} 不合法：${first.message}` : `请求体不合法：${first.message}`;
}

function sendError(res: express.Response, code: StudyErrorCode, message: string): void {
  const retryable = code === 'DB_BUSY';
  res.status(STATUS_BY_CODE[code]).json({ error: { code, message, retryable } });
}

function isBusy(err: unknown): boolean {
  return err instanceof Error && /SQLITE_BUSY|database is locked/i.test(err.message);
}

/** 把任意抛出物翻译为统一错误；非学习路径的错误交回原错误链（不重定义既有接口契约）。 */
function translate(err: unknown, req: express.Request, res: express.Response, next: express.NextFunction): void {
  const studyPath = STUDY_PATH.test(String(req.originalUrl ?? ''));
  if (!studyPath) {
    next(err);
    return;
  }
  if (err instanceof ZodError) {
    sendError(res, 'VALIDATION_FAILED', zodMessage(err));
    return;
  }
  if (err instanceof StudyError) {
    sendError(res, err.code, err.message);
    return;
  }
  if (isBusy(err)) {
    sendError(res, 'DB_BUSY', '数据库忙，请稍后重试');
    return;
  }
  const status = (err as { status?: number; statusCode?: number; type?: string } | null);
  if (status && (status.status === 413 || status.statusCode === 413 || status.type === 'entity.too.large')) {
    sendError(res, 'PAYLOAD_TOO_LARGE', `请求体超过 ${BATCH_MAX_BYTES} 字节`);
    return;
  }
  // 不把 SQL 堆栈/自由备注写进日志：只记错误类型。
  console.error(`[study] 内部错误：${(err as Error)?.name ?? typeof err}`);
  sendError(res, 'VALIDATION_FAILED', '请求无法处理');
}

export function createStudyRouter(): express.Router {
  const router = express.Router();

  // 1. 创建学习会话（201 新建 / 200 同 owner 同输入重试）
  router.post('/study-sessions', (req, res, next) => {
    try {
      const ownerHash = ownerHashFrom(req.headers as Record<string, unknown>);
      const body = studySessionCreateSchema.parse(req.body);
      const result = createStudySession(body, ownerHash);
      res.status(result.created ? 201 : 200).json({
        sessionId: result.view.sessionId,
        startTime: result.startTime,
        serverNow: result.serverNow,
        status: result.view.status,
        aggregateRevision: result.view.aggregateRevision,
      });
    } catch (err) {
      next(err);
    }
  });

  // 2. 声学摘要批量写入（1–12 条、总 ≤64kb、整批事务）
  router.post('/acoustic-summaries/batch', (req, res, next) => {
    try {
      const ownerHash = ownerHashFrom(req.headers as Record<string, unknown>);
      const body = batchSchema.parse(req.body);
      if (Buffer.byteLength(JSON.stringify(body), 'utf8') > BATCH_MAX_BYTES) {
        throw new StudyError('PAYLOAD_TOO_LARGE', `请求体超过 ${BATCH_MAX_BYTES} 字节`);
      }
      const result = writeBatch(ownerHash, body.summaries);
      res.json({ acceptedIds: result.acceptedIds, aggregateRevisions: result.aggregateRevisions });
    } catch (err) {
      next(err);
    }
  });

  // 3. 结束学习会话
  router.post('/study-sessions/:id/end', (req, res, next) => {
    try {
      const ownerHash = ownerHashFrom(req.headers as Record<string, unknown>);
      const body = endSchema.parse(req.body);
      const result = endStudySession(String(req.params.id), ownerHash, body);
      res.status(result.idempotent ? 200 : 200).json({
        sessionId: result.sessionId,
        endTime: result.endTime,
        duration: result.duration,
        status: result.status,
        missingBucketCount: result.missingBucketCount,
        aggregateRevision: result.aggregateRevision,
      });
    } catch (err) {
      next(err);
    }
  });

  // 4. 自评专注分与备注
  router.post('/study-sessions/:id/scores', (req, res, next) => {
    try {
      const ownerHash = ownerHashFrom(req.headers as Record<string, unknown>);
      const body = scoresSchema.parse(req.body);
      const result = writeScores(String(req.params.id), ownerHash, body);
      res.json({
        sessionId: result.sessionId,
        scoreRevision: result.scoreRevision,
        updatedAt: result.updatedAt,
        idempotent: result.idempotent,
      });
    } catch (err) {
      next(err);
    }
  });

  // 5. 读单会话（完整字段 + 质量 + 缺测）
  router.get('/study-sessions/:id', (req, res, next) => {
    try {
      const ownerHash = ownerHashFrom(req.headers as Record<string, unknown>);
      const detail = getStudySession(String(req.params.id), ownerHash);
      res.json(detail);
    } catch (err) {
      next(err);
    }
  });

  // 6. 会话分页列表
  router.get('/study-sessions', (req, res, next) => {
    try {
      const ownerHash = ownerHashFrom(req.headers as Record<string, unknown>);
      const query = listQuerySchema.parse(req.query);
      res.json(listStudySessions(ownerHash, query));
    } catch (err) {
      next(err);
    }
  });

  // 7. 洞察（今日 / 本周 / 关联分析）
  router.get('/study-insights', (req, res, next) => {
    try {
      const ownerHash = ownerHashFrom(req.headers as Record<string, unknown>);
      const query = insightsQuerySchema.parse(req.query);
      res.json(buildInsights(ownerHash, {
        timezone: query.timezone ?? 'Asia/Shanghai',
        nowDate: query.nowDate,
        range: query.range,
      }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * 挂载入口：在既有路由之后、最终错误处理之前调用。
 * index.ts 只需一行 `mountStudyRoutes(app)`，不改动既有错误处理。
 */
export function mountStudyRoutes(app: express.Express): void {
  app.use('/api', createStudyRouter());
  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    translate(err, req, res, next);
  });
}

export { translate as studyErrorTranslator };
