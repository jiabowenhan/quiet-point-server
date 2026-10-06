# 静点 · 云端合并镜像（Render Docker 部署用；也可本机 `docker build` 自证）
#
# ★ 构建上下文必须是**仓库根**（不是本目录）：Dockerfile 要按原相对结构拿到
#   `work/quiet-point-repair/**` 与 `work/models/yamnet-class-map.csv`
#   （`npm run acoustic:check` 会按 `scripts/../../models/` 找那份 CSV，并核对字节数与 SHA256）。
#
#   docker build -f work/quiet-point-repair/cloud/Dockerfile -t quiet-point-merged .
#
# ★ 与 render.yaml 的 start 命令等价：一个进程、一个端口（`cloud/merged-server.mjs`）。

FROM node:24-slim

# 保持与仓库一致的相对结构：/srv/work/quiet-point-repair 的 `../../models` 正好是 /srv/work/models
WORKDIR /srv/work/quiet-point-repair

# 只拷应用本体；其余 work/** 证据文件不进镜像
COPY work/quiet-point-repair/ /srv/work/quiet-point-repair/
# acoustic:check 的源 CSV（14096 B / SHA256 CDF24D19…6DF2）
COPY work/models/yamnet-class-map.csv /srv/work/models/yamnet-class-map.csv

# tsc 在 devDependencies 里 ⇒ 必须 --include=dev；构建产物是 .runtime/ 与 .runtime-addons/（纯 JS，运行时不需要 tsc）
RUN npm install --include=dev --no-audit --no-fund \
 && npm run cloud:build \
 && (npm run cloud:build:web || echo "[docker] Web UI 构建跳过（不影响后端接口）")

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    QP_DATA_DIR=/tmp/quiet-point \
    QUIET_DATA_DIR=/tmp/quiet-point/data \
    QUIET_ADDONS_DATA_DIR=/tmp/quiet-point/addons

# Render 会注入自己的 PORT；这里给个默认只是方便本机 docker run
ENV PORT=10000
EXPOSE 10000

# 健康检查：能反映「库连得上 + 两个 app 都挂上了」
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "cloud/merged-server.mjs"]
