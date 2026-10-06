# 静点 · 云端部署说明（Render 免费档 · **一个服务一个端口**）

> 面向两种使用者：**主控（命令行 / API）** 与 **主人（网页点点点）**。
> 全部材料在 `work/cloud-deploy/`；可部署源码在 `work/quiet-point-repair/cloud/`。

---

## 0. 一句话说明白

原来两个后端跑在两个端口（主服务 3001、附加服务 3002），App 连的是**会变的免费隧道**。
现在把两个后端**合并进一个进程、只监听一个端口**，Render 只暴露一个 Web Service，App 只填**一个地址**：

| 路径 | 归谁 | 说明 |
|---|---|---|
| `/api/*` | 主后端 `server/**` | 房间聚合、上传、学习记录七接口、`/api/events` SSE —— **路由一个字没动** |
| `/addons/v1/*` | 附加服务 `addons/**` | 账号（C-6）、F2/F3/F4/F8c —— **路由一个字没动**，只是被挂在 `/addons` 前缀下 |
| `/healthz` | 合并入口 | 健康检查：真去问一次两个 app + 一次数据库 |
| `/`（若构建了 Web UI） | 主后端静态 | `dist/index.html` |

实现文件：**`work/quiet-point-repair/cloud/merged-server.mjs`**（纯 ESM，不参与 tsc）。

---

## 1. ⚠️ 必须先知道的三个诚实前提

1. **免费档没有持久磁盘**：服务重启 / 重新部署 / 空闲 15 分钟休眠后唤醒，**SQLite 与 JSON 快照全部清零**。
   App 照常能用（本地采集、计时、上传都还在），但**历史房间数据、学习记录、账号会丢**。
   要留存就得上付费磁盘（Render Disk）或换外部数据库 —— 本专线**没做**，也不假装做了。
2. **免费档会休眠**：闲置约 15 分钟后实例下线，下一次请求要**冷启动几十秒**。App 端首次请求超时是正常的，重试一次即可。
3. **演示级账号体系**：`addons` 的账号本来就没有邮箱验证 / 找回密码 / 风控，别用真实密码。

---

## 2. 部署前自证（**已经在本地跑通，证据见 `EVIDENCE-LOCALRUN.md`**）

```powershell
cd work\quiet-point-repair
npm run cloud:build                 # acoustic:check + tsc(主服务) + tsc(附加服务)
$env:PORT='8080'; $env:HOST='127.0.0.1'
$env:QUIET_DATA_DIR='..\cloud-deploy\tmp-data\data'
$env:QUIET_ADDONS_DATA_DIR='..\cloud-deploy\tmp-data\data-addons'
node cloud\merged-server.mjs        # ← 只有一个端口
```

一键复跑自证（会自己起服务、打完请求、落盘证据、再关掉）：

```powershell
node work\cloud-deploy\verify-merged.mjs        # 默认 8080
```

---

## 3. 路线 A：**网页部署**（推荐给主人，5 分钟）

1. 打开 <https://dashboard.render.com> → 用 GitHub 登录。
2. 右上 **New +** → **Web Service**（用 `render.yaml` 蓝图的话选 **Blueprint**，见 3b）。
3. 选仓库（放本项目的那个 GitHub 仓库）→ **Connect**。
4. 逐项照填（其余保持默认）：

   | 字段 | 填什么 |
   |---|---|
   | **Name** | `quiet-point-merged` |
   | **Region** | `Singapore`（离国内最近） |
   | **Branch** | `main`（或你实际用的分支） |
   | **Root Directory** | `work/quiet-point-repair` |
   | **Runtime** | `Node` |
   | **Build Command** | `npm install --include=dev --no-audit --no-fund && npm run cloud:build`（想要网页版 UI 就再加 `&& (npm run cloud:build:web \|\| echo skip)`） |
   | **Start Command** | `npm run cloud:start` |
   | **Instance Type** | `Free` |
   | **Health Check Path** | `/healthz` |

5. **Environment → Add Environment Variable**（7 条，逐条加）：

   ```
   NODE_VERSION              = 24
   HOST                      = 0.0.0.0
   QP_DATA_DIR               = /tmp/quiet-point
   QUIET_DATA_DIR            = /tmp/quiet-point/data
   QUIET_ADDONS_DATA_DIR     = /tmp/quiet-point/addons
   QUIET_ADDONS_ORIGINS      = https://localhost,capacitor://localhost,http://localhost,http://127.0.0.1:5173,http://localhost:5173
   NODE_ENV                  = production
   ```

6. **Create Web Service** → 等构建（首次 3–6 分钟）→ 顶部 URL 形如 `https://quiet-point-merged.onrender.com`。
7. 自证：浏览器打开 `https://<你的地址>/healthz` → 应看到 `{"ok":true,...}`（`checks` 里三项全 `ok:true`）。

### 3b. 用蓝图（`render.yaml`）自动配

**New +** → **Blueprint** → 选仓库 → 把 **Blueprint Path** 填 `work/cloud-deploy/render.yaml` → **Apply**。
它会自己建好服务、塞好环境变量、设好 `/healthz`。

> ⚠️ 两种部署方式**二选一**：3 里的手工 Web Service，或 3b 的蓝图。别同时建（会建出两个服务）。

---

## 4. 路线 B：**命令行 / API**（给主控；拿到 Render API Key 之后）

> 以下请求体形状取自官方 OpenAPI（`POST https://api.render.com/v1/services`，
> `serviceDetails.envSpecificDetails` = `nativeEnvironmentDetailsPOST`，必填 `buildCommand` / `startCommand`）。
> 变量：`$KEY` = Render API Key。

**① 拿 workspace（owner）id：**

```powershell
curl.exe -s -H "Authorization: Bearer $env:RENDER_KEY" "https://api.render.com/v1/owners?limit=20"
# 取返回里的 "owner": { "id": "tea-xxxxxxxx" }
```

**② 建服务（Node 原生环境）：**

```powershell
$body = @'
{
  "type": "web_service",
  "name": "quiet-point-merged",
  "ownerId": "tea-xxxxxxxx",
  "repo": "https://github.com/<owner>/<repo>",
  "branch": "main",
  "autoDeployTrigger": "commit",
  "rootDir": "work/quiet-point-repair",
  "envVars": [
    { "key": "NODE_VERSION", "value": "24" },
    { "key": "HOST", "value": "0.0.0.0" },
    { "key": "QP_DATA_DIR", "value": "/tmp/quiet-point" },
    { "key": "QUIET_DATA_DIR", "value": "/tmp/quiet-point/data" },
    { "key": "QUIET_ADDONS_DATA_DIR", "value": "/tmp/quiet-point/addons" },
    { "key": "QUIET_ADDONS_ORIGINS", "value": "https://localhost,capacitor://localhost,http://localhost,http://127.0.0.1:5173,http://localhost:5173" },
    { "key": "NODE_ENV", "value": "production" }
  ],
  "serviceDetails": {
    "env": "node",
    "plan": "free",
    "region": "singapore",
    "healthCheckPath": "/healthz",
    "envSpecificDetails": {
      "buildCommand": "npm install --include=dev --no-audit --no-fund && npm run cloud:build && (npm run cloud:build:web || echo skip)",
      "startCommand": "npm run cloud:start"
    }
  }
}
'@
$body | Out-File -Encoding utf8 body.json
curl.exe -s -X POST -H "Authorization: Bearer $env:RENDER_KEY" -H "Content-Type: application/json" --data-binary "@body.json" "https://api.render.com/v1/services"
```

**③ 看部署与日志：**

```powershell
curl.exe -s -H "Authorization: Bearer $env:RENDER_KEY" "https://api.render.com/v1/services?limit=20"
curl.exe -s -H "Authorization: Bearer $env:RENDER_KEY" "https://api.render.com/v1/services/<srv-xxxx>/deploys?limit=5"
```

**④ 直接触发一次部署：**

```powershell
curl.exe -s -X POST -H "Authorization: Bearer $env:RENDER_KEY" -H "Content-Type: application/json" -d '{\"clearCache\":\"do_not_clear\"}' "https://api.render.com/v1/services/<srv-xxxx>/deploys"
```

> 用 Docker 部署的话，把 `envSpecificDetails` 换成
> `{ "dockerCommand": "", "dockerContext": ".", "dockerfilePath": "work/quiet-point-repair/cloud/Dockerfile" }`
> 并另外传 `"runtime": "docker"`；**`dockerContext` 必须是仓库根**（Dockerfile 要拿 `work/models/yamnet-class-map.csv`）。

---

## 5. 部署完必须做的两件事

**① 探活**：`https://<你的地址>/healthz` → `{"ok":true,...}`，`checks.db/main/addons` 三项都 `ok:true`。

**② 把 App 指过来**（**只改一个文件**：`app/backend-endpoints.ts` 的两条内置默认值）：

```ts
export const DEFAULT_MAIN_BASE = 'https://quiet-point-merged.onrender.com';   // ← 你的地址
export const DEFAULT_ADDONS_BASE = 'https://quiet-point-merged.onrender.com'; // ← 同一个地址！
```

两条**填同一个地址**＝同源模式：`getAddonsBase()` 会自动拼上 `/addons` 前缀（见
`app/backend-endpoints.ts` 的 `resolveAddonsBase()`）。**不需要**手动写 `…/addons`。

不想重新打包 APK 也行：App「我的」页有两个地址输入框，**两个都填这个地址**→ 保存 → 下次请求生效。

---

## 6. 排查表

| 现象 | 原因 / 处理 |
|---|---|
| `/healthz` 返回 `ok:false` + `checks.addons.ok:false` | 附加服务没挂上：看构建日志里 `scripts/cloud:build` 是否真跑了 `tsc -p tsconfig.addons.json`（`.runtime-addons/addons/main.js` 必须存在） |
| 构建报 `tsc: not found` | 免费档 `NODE_ENV=production` 会跳过 devDependencies ⇒ build 命令必须带 `--include=dev` |
| 构建报 `acoustic-map … CHECK FAILED` / `源 CSV 不存在` | `work/models/yamnet-class-map.csv` 没进构建上下文。原生部署要保证仓库里有它；Docker 部署要 `dockerContext: .` |
| 起服务就报 `Cannot find module '…/.runtime/server/index.js'` | 没先构建：`npm run cloud:build` |
| 起服务报 `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` | Node 版本太低（< 24）⇒ 设 `NODE_VERSION=24` |
| 浏览器/App 报跨域 | 合并入口已对所有带 `Origin` 的请求回显 `Access-Control-Allow-Origin`；确认访问的是**合并服务**而不是别的地址。要额外白名单可设 `QUIET_ADDONS_ORIGINS` |
| 一会儿不用就打不开、要等半分钟 | 免费档休眠 + 冷启动，正常现象 |
| 重启后历史没了 | **预期**：免费档没有持久盘，见 §1 |

---

## 7. 环境变量总表

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` | `8080`（本地）/ Render 自动注入 | 合并入口**唯一**对外端口 |
| `HOST` | `0.0.0.0` | 云端必须 `0.0.0.0`；本地只想回环就写 `127.0.0.1` |
| `QP_DATA_DIR` | 无 | **伞形**：仅当下面两个未显式设置时，推导 `$QP_DATA_DIR/data` 与 `$QP_DATA_DIR/addons` |
| `QUIET_DATA_DIR` | `data` | 主库 `quiet.sqlite`（`server/store.ts`、`server/study-store.ts` 读它）—— **本地默认行为不变** |
| `QUIET_ADDONS_DATA_DIR` | `data-addons` | addons 的 `room-index-v1.json` / `checkin-v1.json` / `presence-v1.json` / `auth-v1.json` |
| `QUIET_DB_PATH` | `$QUIET_DATA_DIR/quiet.sqlite` | addons **只读**打开旧库的路径 |
| `QUIET_ADDONS_ORIGINS` | 见 `addons/main.ts:73` | addons 自身白名单 CORS 的追加来源（合并级 CORS 已回显 Origin） |
| `NODE_VERSION` | — | Render 用；必须 ≥ 24（`node:sqlite`） |

> ★ **本地跑法一个字都没变**：不设任何变量时，仍是 `data/`、`data-addons/`、`127.0.0.1:3001`（`npm run start`）与 `127.0.0.1:3002`。

---

## 8. 本专线改了什么（可审计）

| 文件 | 改动 | 说明 |
|---|---|---|
| `server/index.ts` | 末尾 2 处结构改动 | `export { app }` + `app.listen` 收进 `isMain` 守卫（写法照抄 `addons/main.ts:115`）。**路由/鉴权/上传路径/主库 schema 零改动**；直跑 `node .runtime/server/index.js` 行为逐字不变（已实测，见 `EVIDENCE-DIRECT-ENTRY.md`） |
| `app/backend-endpoints.ts` | 新增 `ADDONS_MOUNT_PREFIX` + `resolveAddonsBase()`，`getAddonsBase()` 走它 | **App 侧唯一改动**；两个地址不同时（含内置默认）行为完全不变（C21 测试 12/12 通过） |
| `package.json` | 新增 3 条脚本 | `cloud:build` / `cloud:build:web` / `cloud:start`（纯新增，不动既有脚本） |
| `cloud/merged-server.mjs` | **新增** | 合并入口 |
| `cloud/render.yaml` · `cloud/Dockerfile` | **新增** | 部署材料 |
| `cloud/README-DEPLOY.md` | **新增** | 本文件 |

**判据 / 阈值 / 映射 / EMA / decision-v1 / stride / FIR / credit：一行未动。**
