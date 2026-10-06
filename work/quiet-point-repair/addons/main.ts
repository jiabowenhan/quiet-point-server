/**
 * 静点 · 附加服务（`addons/`）——F2 学习状态关联分析 + 简化版 F3 房间安静指数列表。
 *
 * 为什么是**独立进程**（Sol `SOL_DESIGN_F2_F6_F7_F3.md` §0.1 第 1 条）：
 *  · 现有 `server/**`（Express 主机、七接口、鉴权、上传路径、DB schema）**全部字节不动**；
 *  · 旧 SQLite **只读**打开（`readOnly:true` + `PRAGMA query_only=ON`），不加表、不加列、不迁移；
 *  · F3 的新聚合持久化用**独立有界 JSON**（`data-addons/room-index-v1.json`），零 SQLite 新表；
 *  · 新增端点只在 3002；停掉本进程**不影响**旧上传（3001 与它的 `adb reverse` 一个都不动）。
 *
 * 启动：`node .runtime-addons/addons/main.js`（见 `scripts/start-addons.ps1`）。
 */

import express from 'express';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createCorrelationsRouter } from './f2/route.js';
import { createRoomIndexRouter } from './f3/routes.js';
import { RoomIndexStore, sweepTempFiles } from './f3/store.js';
import { createCheckinRouter } from './f4/routes.js';
import { CheckinStore } from './f4/store.js';
import { createPresenceRouter } from './f8/routes.js';
import { PresenceStore } from './f8/store.js';
import { createAuthRouter } from './auth/routes.js';
import { AuthStore } from './auth/store.js';
import { errorBody, AddonError } from './shared/owner.js';
import { sweepTemp } from './shared/atomic-json.js';

export const ADDON_DEFAULT_PORT = 3002;
export const ADDON_DEFAULT_HOST = '127.0.0.1';
/** F3 快照目录（与旧 `quiet.sqlite` 同盘的独立目录，绝不混入旧 schema）。 */
export const ADDONS_DATA_DIR = process.env.QUIET_ADDONS_DATA_DIR ?? resolve('data-addons');
export const ROOM_INDEX_FILE = join(ADDONS_DATA_DIR, 'room-index-v1.json');
/** F4 打卡快照（独立有界 JSON，与 F3 快照**互不干扰**）。 */
export const CHECKIN_FILE = join(ADDONS_DATA_DIR, 'checkin-v1.json');
/** F8-c 共同存在信号快照（独立有界 JSON；只存 TTL 内的最新心跳，不留历史）。 */
export const PRESENCE_FILE = join(ADDONS_DATA_DIR, 'presence-v1.json');
/** C-6 账号/会话快照（独立有界 JSON；**只存** salt/hash 与 sha256(token)，明文口令与 token 不落盘）。 */
export const AUTH_FILE = join(ADDONS_DATA_DIR, 'auth-v1.json');
/** 旧库路径：**只读**打开。可用环境变量覆盖（测试用）。 */
export const OLD_DB_PATH = process.env.QUIET_DB_PATH ?? resolve(process.env.QUIET_DATA_DIR ?? 'data', 'quiet.sqlite');

export interface AddonApp {
  app: express.Express;
  store: RoomIndexStore;
  checkinStore: CheckinStore;
  presenceStore: PresenceStore;
  authStore: AuthStore;
}

export function createAddonApp(options: { dbPath?: string; roomIndexFile?: string; checkinFile?: string; presenceFile?: string; authFile?: string; now?: () => number } = {}): AddonApp {
  const dbPath = options.dbPath ?? OLD_DB_PATH;
  const roomIndexFile = options.roomIndexFile ?? ROOM_INDEX_FILE;
  mkdirSync(dirname(roomIndexFile), { recursive: true });
  sweepTempFiles(roomIndexFile);
  const store = new RoomIndexStore({ filePath: roomIndexFile, now: options.now });
  const checkinFile = options.checkinFile ?? CHECKIN_FILE;
  mkdirSync(dirname(checkinFile), { recursive: true });
  sweepTemp(checkinFile);
  const checkinStore = new CheckinStore({ filePath: checkinFile, now: options.now });
  const presenceFile = options.presenceFile ?? PRESENCE_FILE;
  mkdirSync(dirname(presenceFile), { recursive: true });
  sweepTemp(presenceFile);
  const presenceStore = new PresenceStore({ filePath: presenceFile, now: options.now });
  const authFile = options.authFile ?? AUTH_FILE;
  mkdirSync(dirname(authFile), { recursive: true });
  sweepTemp(authFile);
  const authStore = new AuthStore({ filePath: authFile, now: options.now });
  const app = express();
  // 新 body 上限独立设定（8kb），**不是**修改旧 64kb。
  app.use(express.json({ limit: '8kb' }));
  // 原 UI origin 的精确 CORS（含 X-Study-Key / Content-Type 预检）；原 3001 行为不改。
  const allowed = new Set(
    (process.env.QUIET_ADDONS_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173,https://localhost,capacitor://localhost,http://localhost')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  app.use((req, res, next) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (origin !== '' && allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'X-Study-Key,Content-Type,Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
  app.get('/v1/health', (_req, res) => {
    const status = store.status();
    res.json({ ok: true, schemaVersion: 'addons-v1', dbPath, roomIndexFile, store: status });
  });
  app.use(createCorrelationsRouter({ dbPath, now: options.now }));
  app.use(createRoomIndexRouter({ dbPath, store, now: options.now }));
  // —— C4 增量：F4 打卡 + F8-c 共同存在信号（只挂新路由；上面两行一个字都没动）——
  app.use(createCheckinRouter({ store: checkinStore, now: options.now }));
  app.use(createPresenceRouter({ store: presenceStore, now: options.now }));
  // —— C-6 增量：账号 / 会话（只挂新路由；上面几行一个字都没动）——
  // 账号是**独立的一根轴**：不读也不要求 X-Study-Key，不碰上传链路与旧库。
  app.use(createAuthRouter({ store: authStore, now: options.now }));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AddonError) {
      res.status(err.status).json(errorBody(err));
      return;
    }
    const message = err instanceof Error ? err.message : '附加服务内部错误';
    res.status(500).json({ error: { code: 'STORE_UNAVAILABLE', message, retryable: false } });
  });
  return { app, store, checkinStore, presenceStore, authStore };
}

const isMain = process.argv[1] !== undefined && /main\.(js|ts)$/.test(process.argv[1]);
if (isMain) {
  const host = process.env.ADDONS_HOST ?? ADDON_DEFAULT_HOST;
  const port = Number(process.env.ADDONS_PORT ?? ADDON_DEFAULT_PORT);
  const { app } = createAddonApp();
  if (!existsSync(OLD_DB_PATH)) {
    console.log(`[addons] 警告：旧库不存在（${OLD_DB_PATH}）⇒ F2/F3 只会回复 unavailable，旧服务不受影响`);
  }
  app.listen(port, host, () => {
    console.log(`[addons] 静点附加服务：http://${host}:${port}（旧库只读 ${OLD_DB_PATH}；房间指数快照 ${ROOM_INDEX_FILE}）`);
    console.log(`[addons] F4 打卡快照 ${CHECKIN_FILE}；F8-c 共同存在信号快照 ${PRESENCE_FILE}`);
    console.log(`[addons] C-6 账号/会话快照 ${AUTH_FILE}（只存 salt/hash 与 sha256(token)，明文口令与 token 不落盘）`);
  });
}
