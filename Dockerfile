# 依赖构建阶段：完整镜像自带编译工具，better-sqlite3 可编译或使用预编译二进制
FROM node:20-bookworm AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 运行阶段：精简镜像
FROM node:20-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/triangle.db
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js db.js ./
COPY public ./public
# 数据库文件目录（建议挂载卷持久化）；表结构随服务启动自动初始化
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "server.js"]
