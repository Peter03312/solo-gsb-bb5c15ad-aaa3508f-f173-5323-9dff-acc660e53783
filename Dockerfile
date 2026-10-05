# syntax=docker/dockerfile:1
# ---- 构建阶段：编译前端 + 后端 ----
FROM node:20-bookworm AS build
WORKDIR /app

# better-sqlite3 无预编译包时需要本地编译工具链
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# 先装依赖（利用层缓存）
COPY package.json package-lock.json* ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm install

# 再拷源码并构建：web/dist 静态资源 + server/dist
COPY . .
RUN npm run build

# ---- 运行阶段：最小镜像 ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=4000 \
    DB_PATH=/data/app.db \
    PUBLIC_DIR=/app/web/dist

# 复制整个工作区（含已构建的 dist 与带原生模块的 node_modules）
COPY --from=build /app /app

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 4000

# 服务启动时自动执行表结构创建与初始数据播种（幂等）
CMD ["node", "server/dist/index.js"]
