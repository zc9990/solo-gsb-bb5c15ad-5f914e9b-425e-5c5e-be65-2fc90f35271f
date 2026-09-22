# 盲杯三角测试台（Blind Triangle Bench）

A/B 样品三角盲测的自托管测试台。主持人创建场次后获得 **主持口令** 与 **加入码**；
参与者用加入码加入，系统在数据库事务中为其均衡分配六种上杯顺序之一，并生成三杯
**场次内唯一的三位盲码**；每人只能提交一次“异样杯位 + 1～5 信心值”。
场次关闭前严格保密 A/B 映射、正确杯位与汇总；关闭后公布总命中率及按顺序、信心分组的结果。

技术栈：Node.js + Express + SQLite（better-sqlite3，同步事务）+ 原生 HTML/CSS/JS，无前端构建。

## 一条命令启动

```bash
docker compose up -d --build
```

然后访问： **http://localhost:3000**

停止与查看日志：

```bash
docker compose logs -f
docker compose down            # 停止（数据保留在 Docker 卷 triangle-data 中）
```

> 数据持久化于命名卷 `triangle-data`（容器内 `/data/triangle.db`）。
> 依赖安装与数据库建表均在镜像构建 / 容器启动时自动完成，无需手工初始化。

## 访问地址与端口

| 入口 | 地址 | 说明 |
| --- | --- | --- |
| 首页 | `http://localhost:3000/` | 创建场次 / 输入加入码 |
| 主持页 | `http://localhost:3000/host.html?code=<加入码>` | 需主持口令 |
| 参与者页 | 首页输入加入码后自动进入 | 参与口令保存在本浏览器 localStorage |
| 公开结果 | `http://localhost:3000/results.html?code=<加入码>` | 仅关闭后可访问 |

默认监听容器内 **3000** 端口。修改宿主机映射端口（例如 8080）：

```bash
PORT=8080 docker compose up -d --build   # 访问 http://localhost:8080
```

## 必要配置（环境变量，均为可选）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 容器内监听端口（一般无需改，改宿主端口用 Compose 的 `PORT`） |
| `DB_PATH` | `/data/triangle.db`（容器内） | SQLite 数据库文件路径 |

不使用 Docker 时（需 Node.js ≥ 20）：

```bash
npm ci --omit=dev
npm start                     # 监听 http://localhost:3000，数据文件 ./data/triangle.db
PORT=8080 DB_PATH=/srv/triangle.db npm start
```

## 使用流程

1. **主持人**在首页填写样品 A、样品 B 的真实名称（可加备注），创建场次。
2. 创建后页面显示：
   - **加入码**（6 位，去易混字符）——发给参与者；
   - **主持口令**（64 位随机令牌，仅展示一次）——凭此进入主持页，请妥善保存。
3. **参与者**在首页输入加入码加入，看到三杯盲码（如 `213 / 244 / 475`），
   品鉴后选择异样杯位（1/2/3）与信心值（1～5），**提交一次即不可更改**。
4. 主持人在主持页查看 **制样映射**（每位参与者的杯码 → A/B 样品，用于按码制样），
   以及加入 / 已提交人数。开放期主持页也**看不到**任何人的判断与汇总。
5. 主持人点击「关闭场次」：
   - 参与者页面自动公布其个人顺序、正确杯位与命中判定；
   - 主持页与公开结果页展示总命中率、按六种顺序分组、按 1～5 信心分组，
     以及“顺序 × 信心”交叉表（附 33.3% 纯随机基线对照）。
   - 关闭不可撤销；关闭后不能再加入或提交。

## 设计与安全要点

- **均衡分配**：加入在单个 SQLite 事务内完成——统计六种顺序当前人数，取最少者
  （按 `AAB, ABA, BAA, BBA, BAB, ABB` 固定次序破平），因此任意时刻六种顺序人数差恒为 **≤ 1**。
  已用 100 并发加入验证（分布 17/17/17/17/16/16）。
- **盲码唯一**：每次加入在事务内从该场次已用盲码集合中随机抽取三个 100–999 的
  互不相同三位码，场场次内全局唯一。
- **只存哈希**：主持口令、参与令牌在数据库中仅存 SHA-256 哈希；
  原始令牌只在创建/加入的响应中返回一次，参与令牌由浏览器 localStorage 本地保存。
- **关闭前防泄露**：
  - 参与者接口不返回上杯顺序、A/B 样品名、正确杯位（关闭后才在个人视图公布）；
  - 主持接口开放期只返回制样映射与进度，不返回判断内容 / 信心 / 汇总；
  - 公开汇总接口在开放期返回 `409`，无任何数据。
- **提交幂等约束**：数据库层 `odd_guess IS NULL` 条件更新 + 应用层校验，
  杜绝重复提交；杯位限定 1～3、信心限定 1～5。
- 单进程 + better-sqlite3 同步事务，加入/提交天然串行化，无并发竞态。

## 目录结构

```
src/server.js        Express 路由与接口校验
src/db.js            SQLite 建表、事务（分配/盲码）、汇总与脱敏视图
public/              原生前端（首页 / 参与者 / 主持 / 结果）
Dockerfile           node:20-slim，npm ci 装依赖，启动即建库
docker-compose.yml   单服务 + 命名卷持久化
```

## API 摘要

| 方法 | 路径 | 鉴权 |
| --- | --- | --- |
| POST | `/api/sessions` | —（创建，返回加入码+主持口令） |
| POST | `/api/sessions/:code/join` | —（事务内分配顺序与盲码，返回参与令牌） |
| GET | `/api/participants/:id` | `X-Participant-Token` |
| POST | `/api/participants/:id/submission` | `X-Participant-Token`，body `{oddGuess, confidence}` |
| GET | `/api/host/sessions/:code` | `X-Host-Token` |
| POST | `/api/host/sessions/:code/close` | `X-Host-Token` |
| GET | `/api/sessions/:code/results` | 关闭后公开 |
