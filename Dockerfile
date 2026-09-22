FROM node:20-bookworm-slim

# better-sqlite3 优先使用预编译二进制；保留构建工具以在预编译包不可用时回退源码编译
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 优先利用依赖层缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/triangle.db

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

# 启动即建库建表（src/server.js -> db.initDb），无需额外初始化步骤
CMD ["node", "src/server.js"]
