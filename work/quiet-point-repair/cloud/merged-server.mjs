/**
 * 静点 · **云端合并入口**（Render 免费档：一个 Web Service 只暴露一个端口）。
 *
 * 职责只有三件事，**不碰**任何既有业务逻辑：
 *   ① 一个 `app.listen`（`HOST` 默认 `0.0.0.0`、`PORT` 用平台注入的）——对外只有一个端口；
 *   ② 按**路径前缀**分流：`/addons/*` → 附加服务 app（挂载会剥掉前缀），其余 → 主 app；
 *   ③ 合并级 CORS（回显 Origin）+ `GET /healthz`（真去问一次两个 app 和一次数据库）。
 *
 * 为什么是「挂载两次」而不是「起两个 Server」：Render 免费档一个服务只给一个端口，
 * 第二个监听没人连得上。所以两个 app 在**同一个进程、同一个端口**上被挂载两次。
 *
 * 数据落盘（诚实版）：
 *   · 目录**可配**，沿用既有环境变量：`QUIET_DATA_DIR`（主库+学习表，默认 `data`）、
 *     `QUIET_ADDONS_DATA_DIR`（addons 的四个 JSON，默认 `data-addons`）——不设置时**本地行为不变**；
 *   · 本入口额外认一个伞形变量 `QP_DATA_DIR`（只在上面两个都没显式给时才推导），
 *     Render 上指向 `/tmp/quiet-point/**`（免费档只有临时盘）；
 *   · 目录/表不存在会自动建（`mkdirSync(recursive)` + `CREATE TABLE IF NOT EXISTS`），空库不崩；
 *   · ★**免费档没有持久盘 ⇒ 每次重启/重新部署，SQLite 与 JSON 快照清零**（App 照常可用，历史丢）。
 *
 * 启动：`node cloud/merged-server.mjs`（= `npm run cloud:start`）。本地试跑用 `PORT=8080`。
 */

import express from 'express';

// ---------------------------------------------------------------------------
// 0. 环境推导（**必须在 import 应用模块之前**：store/study-store 在模块加载时就读 env）
// ---------------------------------------------------------------------------

/** 主库 + 学习表目录（既有变量名，默认 `data` ⇒ 本地不变）。 */
export const DATA_DIR = process.env.QUIET_DATA_DIR ?? process.env.QP_DATA_DIR ?? 'data';
/** addons 的 JSON 快照目录（既有变量名，默认 `data-addons` ⇒ 本地不变）。 */
export const ADDONS_DIR = process.env.QUIET_ADDONS_DATA_DIR ?? (process.env.QP_DATA_DIR ? `${process.env.QP_DATA_DIR}/addons` : 'data-addons');
// 只在「没有显式设置」时回填，绝不覆盖用户/平台给的值。
process.env.QUIET_DATA_DIR ??= DATA_DIR;
process.env.QUIET_ADDONS_DATA_DIR ??= ADDONS_DIR;

const PORT = Number(process.env.PORT ?? 8080);
/** 云端必须监听 0.0.0.0（Render 反代要连得上）；本地想只走回环就设 `HOST=127.0.0.1`。 */
const HOST = process.env.HOST ?? '0.0.0.0';

// ---------------------------------------------------------------------------
// 1. 挂载两个既有 app（**只挂载，不改它们内部任何一行**）
// ---------------------------------------------------------------------------

/** 主后端：`server/index.ts` 改动后导出 app（listen 已被 isMain 守卫挡住）。 */
const mainModule = await import('../.runtime/server/index.js');
const mainApp = mainModule.app;
/** 附加服务：原本就有 isMain 守卫，import 不会自己监听。 */
const { createAddonApp } = await import('../.runtime-addons/addons/main.js');
const addonsApp = createAddonApp().app;
/** 主库连接（与主 app 是同一个模块实例 ⇒ 同一个 DatabaseSync），健康检查用它证「库连得上」。 */
const { db } = await import('../.runtime/server/store.js');

if (typeof mainApp !== 'function' || typeof addonsApp !== 'function') {
  console.error('[merged] 启动失败：`.runtime/server/index.js` 必须导出 app、`.runtime-addons/addons/main.js` 必须导出 createAddonApp。请先 `npm run cloud:build`。');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. 合并层（CORS → /healthz → /addons → 主 app）
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');

/**
 * 合并级 CORS。**这是本次部署的关键项**：App 的 WebView 从 `https://localhost` 发起请求，
 * 而主后端原本没有任何 CORS 头（原生走 CapacitorHttp 不需要，网页端走同源相对路径）。
 * 合并后两个 app 同源暴露，这里统一回显 Origin —— 不写死白名单，避免"部署好了却连不上"。
 * 用 `setHeader` 覆盖语义：addons app 自己的白名单 CORS 若也命中同一 Origin，
 * 会写进**同一个头**（值相同），不会出现重复头导致的浏览器报错。
 */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '') {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'X-Study-Key,Content-Type,Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

let listeningPort = PORT;

/** 进程内自问一次（真发 HTTP，而不是"我以为挂上了"）。 */
async function probe(path) {
  const started = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${listeningPort}${path}`, { headers: { accept: 'application/json' } });
    return { ok: res.ok, status: res.status, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 健康检查：`{ok:true,...}` 且 200 ⇐⇒ **库读得动 且 两个 app 真能应答**。
 * 任一项不过 ⇒ 503 + `ok:false`（Render 会因此把实例判为不健康，而不是"假装健康"）。
 */
app.get('/healthz', async (_req, res) => {
  const checks = { db: { ok: false }, main: { ok: false }, addons: { ok: false } };
  try {
    const row = db.prepare('SELECT (SELECT COUNT(*) FROM sessions) AS sessions,(SELECT COUNT(*) FROM samples) AS samples').get();
    checks.db = { ok: true, sessions: Number(row.sessions), samples: Number(row.samples) };
  } catch (err) {
    checks.db = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  checks.main = await probe('/api/state?source=demo');
  checks.addons = await probe('/addons/v1/health');
  const ok = checks.db.ok === true && checks.main.ok === true && checks.addons.ok === true;
  res.status(ok ? 200 : 503).json({
    ok,
    service: 'quiet-point-merged',
    schemaVersion: 'merged-v1',
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    // ★ 如实告知：免费档没有持久盘，重启即清零。
    persistence: 'ephemeral',
    dataDir: DATA_DIR,
    addonsDir: ADDONS_DIR,
    routes: { main: '/', addons: '/addons', health: '/healthz' },
    checks,
  });
});

// 附加服务挂在 `/addons`（Express 挂载会剥掉前缀 ⇒ addons 内部 `/v1/health` 等路由原样可用）。
app.use('/addons', addonsApp);
// 主 app 挂在根路径（它的 /api/*、/v1 之外的静态与错误处理全部保持原样）。
app.use('/', mainApp);

// ---------------------------------------------------------------------------
// 3. 唯一监听
// ---------------------------------------------------------------------------

const server = app.listen(PORT, HOST, () => {
  listeningPort = server.address()?.port ?? PORT;
  console.log(`[merged] 静点合并服务：http://${HOST}:${listeningPort}`);
  console.log(`[merged]   主服务   /            ← .runtime/server/index.js`);
  console.log(`[merged]   附加服务 /addons      ← .runtime-addons/addons/main.js`);
  console.log(`[merged]   健康检查 /healthz`);
  console.log(`[merged]   主库目录 ${DATA_DIR}；addons 目录 ${ADDONS_DIR}`);
  console.log('[merged]   ⚠ 若部署在 Render 免费档：没有持久盘，重启即清零（App 照常可用，历史丢）。');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[merged] 收到 ${signal}，关闭唯一监听…`);
    server.close(() => process.exit(0));
  });
}
