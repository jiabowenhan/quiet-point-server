# quiet-point-server

静点（Quiet Point）后端 —— **主服务 `server/**` + 附加服务 `addons/**` 合并成"一个进程、一个端口"** 的最小可部署子树。

> 这个仓库**只放跑服务必需的东西**：没有前端 `app/`、没有构建产物、没有本地数据、没有日志、没有任何凭据。
> 前端（APK / 网页）不必上云；它只按一个地址访问本服务。

## 它对外长什么样

| 路径 | 归谁 | 说明 |
|---|---|---|
| `/api/*` | 主后端 `server/**` | 房间聚合、上传、学习记录七接口、`/api/events` SSE |
| `/addons/v1/*` | 附加服务 `addons/**` | 账号（注册/登录/会话/登出）、F2/F3/F4/F8c |
| `/healthz` | 合并入口 | 健康检查：真去问一次两个 app + 一次数据库 |
| `/` | 主后端静态 | 需要 Web UI 时才由 `vite build` 产出 |

分流实现是 `work/quiet-point-repair/cloud/merged-server.mjs`：
一个 `app.listen`，`app.use('/addons', addonsApp)` + `app.use('/', mainApp)`
（Express 挂载会**剥掉** `/addons` 前缀 ⇒ 两个 app 内部路由一行未改）。

## 目录

```
work/
  models/yamnet-class-map.csv          # acoustic:check 的输入（14096 B，521 类）
  quiet-point-repair/
    package.json  tsconfig*.json
    server/    主后端
    addons/    附加服务
    shared/    两侧共享的模型与算法常量
    cloud/     合并入口 + render.yaml + Dockerfile + 部署说明
    scripts/   generate-acoustic-map.mjs
```

> ★ `scripts/generate-acoustic-map.mjs` 按 `scripts/../../models/` 定位 CSV，
> 所以 `work/models/` 与 `work/quiet-point-repair/` 这一层**必须保持同级**——别把应用根单独提上来。

## 在本机跑一遍（不部署也能验）

```bash
cd work/quiet-point-repair
npm install --include=dev --no-audit --no-fund
npm run cloud:build          # acoustic:check + tsc(主服务) + tsc(附加服务)
PORT=8080 HOST=127.0.0.1 \
  QP_DATA_DIR=/tmp/quiet-point \
  node cloud/merged-server.mjs
# 另开一个终端：
curl -s localhost:8080/healthz
```

## Render 上的设置（免费档）

| 字段 | 值 |
|---|---|
| Runtime | `node` |
| Region | `singapore` |
| Plan | `free` |
| Root Directory | `work/quiet-point-repair` |
| Build Command | `npm install --include=dev --no-audit --no-fund && npm run cloud:build` |
| Start Command | `npm run cloud:start` |
| Health Check Path | `/healthz` |
| `NODE_VERSION` | `24`（`node:sqlite` 需要，低于 24 起不来） |
| `HOST` | `0.0.0.0` |
| `QP_DATA_DIR` | `/tmp/quiet-point` |
| `QUIET_DATA_DIR` | `/tmp/quiet-point/data` |
| `QUIET_ADDONS_DATA_DIR` | `/tmp/quiet-point/addons` |

> ★ 免费档**没有持久磁盘**：重启 / 重新部署 / 空闲休眠唤醒后，SQLite 与 JSON 快照清零。
> 这是设计前提，不是缺陷 —— App 照常可用（采集、计时、上传都在），只是历史房间数据与账号会丢。
> ★ 免费档**会休眠**：闲置约 15 分钟实例下线，下一次请求要冷启动，App 端首次请求超时属正常，重试一次即可。
>
> 构建命令里**不带** `npm run cloud:build:web`：本仓库没有前端 `app/`，Web UI 构建在这里没有意义
> （`/api/*` 与 `/addons/v1/*` 不受影响）。

## 安全边界

- 仓库内**没有任何凭据**：不含 token、口令、`.env`、私钥（已按模式扫描：`ghp_` / `rnd_` / `glpat-` / `Bearer` / 私钥头等一律无命中）。
- `addons` 的账号体系是**演示级**：没有邮箱验证、没有找回密码、没有风控。别用真实密码。
- 不录音、不上传谈话内容；App 只上传音量摘要。
