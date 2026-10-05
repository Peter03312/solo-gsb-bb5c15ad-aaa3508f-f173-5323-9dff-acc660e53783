# 展览展签校核 Web 应用

一款面向博物馆/美术馆的**展签文字校核**系统。两类本地账号分工协作：

- **校核人（checker）**：在当前展签正文中框选**连续文字**，提交「替换文本 + 校核依据」；
- **馆员（librarian）**：查看建议，按**正文版本**逐条采纳，处理冲突，并**发布**固化版本。

技术栈：**TypeScript 全栈** · React 18 + Vite（前端）· Node.js + Express（后端）· SQLite（better-sqlite3）· Docker / Docker Compose 一键启动。

---

## 一、一键启动（Docker Compose）

需要 Docker 20.10+ 与 Compose v2（或 `docker-compose` v1）。

```bash
docker compose up -d --build
```

启动后打开：

| 地址 | 说明 |
| --- | --- |
| http://localhost:4000 | 应用首页（登录页） |
| http://localhost:4000/checker | 校核人工作台（登录后） |
| http://localhost:4000/reviewer | 馆员审批工作台（登录后） |
| http://localhost:4000/publications | 发布历史与两次发布正文差异 |

数据库文件保存在 Docker 卷 `labelcheck-data`（容器内 `/data/app.db`），容器重建数据不丢失。

停止 / 查看日志 / 重置：

```bash
docker compose logs -f          # 查看日志
docker compose down             # 停止（保留数据）
docker compose down -v          # 停止并删除数据库卷（恢复初始演示数据）
```

> 镜像构建时已完成「npm 依赖安装 + 前端构建 + 后端编译」；容器**首次启动自动建表并幂等播种**演示账号、演示展签和初始发布，无需额外初始化命令。

---

## 二、演示账号

| 角色 | 账号 | 密码 | 入口 |
| --- | --- | --- | --- |
| 校核人 | `checker` | `checker123` | `/checker` |
| 馆员 | `librarian` | `librarian123` | `/reviewer` |

建议用两个浏览器（或常规窗口 + 隐身窗口）分别登录两个账号，观察并发与实时轮询。

演示展签《溪山行旅图》的 v1 正文中预置了 3 条待审建议，其中：

- `#1`「链→练」与 `#2`「飞瀑如链，山脚→飞瀑如练。山脚」**选区重叠**：先采纳任一条，另一条会**自动转为冲突**并停止采纳；
- `#3`「雾蔼→雾霭」与二者**不重叠**：前一条采纳后，它的选区会**随文字位移**，仍然精确指向「雾蔼」。

---

## 三、核心业务规则

### 1. 选区与并发（乐观版本控制）

- 正文每次采纳生成一个新版本（v1、v2、…），历史版本永久保留在 `label_versions`。
- 校核人提交、馆员采纳、馆员发布都必须携带 `expectedVersion`（页面打开时所见版本）：
  - 服务端发现版本不是最新 → 返回 **409**，拒绝操作并提示「所见版本已过期」，**不会覆盖并发改动**；
  - 前端每 6 秒轮询版本号，发现对方账号已推进版本会自动刷新数据。

### 2. 采纳时的选区位移与冲突（单次数据库事务）

采纳建议 `#A`（编辑区间 `[start,end)`，旧长度 → 新长度）时，对每条其他**待审**建议：

| 待审建议选区与编辑区间的关系 | 处理 |
| --- | --- |
| 完全在编辑点之前（`end ≤ startA`） | 原地不动 |
| 完全在编辑点之后（`start ≥ endA`） | 起止偏移整体平移 `Δ = 新长度 − 旧长度`，继续指向原内容 |
| 与编辑区间重叠 | **转为「冲突」**，记录冲突原因，**停止采纳**（按钮消失） |

已采纳建议自身的选区更新为替换后区间；冲突建议保留提交时原文与旧坐标作为留痕。

### 3. 无效操作一律拒绝且不改数据

以下情况后端返回明确原因（HTTP 状态码 + 中文错误信息，页面红条展示），数据库零改动：

- **无效选区**：偏移非整数、越界、空选区/反向、选区文字与当前正文不一致（422）；
- **重复采纳**：建议已是「已采纳」（409，提示采纳于哪个版本）；已是「冲突」（409）；
- **重复提交**：完全相同的待审建议（409）；
- **无权限**：未登录（401）；校核人调用采纳/发布、馆员访问校核提交（403，说明所需角色）；
- **版本过期**：提交/采纳/发布所依据的版本落后（409）；
- 同一正文版本**重复发布**（409）。

### 4. 发布固化与版本对比

- 馆员发布时，在 `publications` 中固化当前正文全文快照，在 `publication_adoptions` 中固化当时全部采纳记录（坐标、原文、替换、依据、提交人、采纳版本）；
- 旧发布**只读不可改**：后续审批只会产生新正文版本与新发布，旧快照不受影响；
- `/publications` 页面可任选**两次发布**比较正文差异：中文按单字、拉丁按单词做 LCS 差异，绿色为新增、红色为删除，差异完全基于不可变快照计算。

---

## 四、配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `4000` | HTTP 端口 |
| `DB_PATH` | `/data/app.db`（容器）/ 本地 `./data/app.db` | SQLite 数据库路径，启动时自动建库建表 |
| `PUBLIC_DIR` | 自动指向 `web/dist` | 前端静态资源目录 |
| `SESSION_DAYS` | `30` | 登录会话有效期（天），存于 HttpOnly Cookie |

Compose 中通过 `ports: "4000:4000"` 映射端口，改宿主机端口例如 `8080:4000` 后访问 http://localhost:8080 。

---

## 五、本地开发（不使用 Docker）

要求 Node.js 20+（better-sqlite3 安装时如需本地编译，需 Python 3、make、g++）。

```bash
npm install                 # 安装两个 workspace 的依赖
npm run dev:server          # 终端 1：后端 http://localhost:4000（tsx 热重载，自动初始化 DB）
npm run dev:web             # 终端 2：前端 http://localhost:5173（/api 已代理到 4000）
```

本地开发时数据库默认创建在 `server` 工作目录解析的 `DB_PATH`，可显式指定：

```bash
DB_PATH=./data/dev.db npm run dev:server
```

仅初始化数据库（建表 + 播种）后退出：

```bash
npm run initdb -w server
```

生产式本地运行（先构建再由 Express 托管前端）：

```bash
npm run build
npm start                   # http://localhost:4000
```

---

## 六、目录结构

```
.
├── Dockerfile               # 多阶段构建：依赖 → 前端/后端构建 → 精简运行镜像
├── docker-compose.yml       # 一键启动 + 数据卷 + 环境变量
├── package.json             # npm workspaces 根
├── server/                  # 后端（Express + TypeScript + better-sqlite3）
│   └── src/
│       ├── index.ts         # 入口：路由装配、静态托管、错误处理、启动即初始化数据库
│       ├── db.ts / db/      # 连接、表结构 schema、幂等播种
│       ├── ranges.ts        # 选区位移 / 重叠判定 / 选区校验（纯函数）
│       ├── diff.ts          # CJK 感知的 LCS 正文差异
│       ├── auth.ts          # 会话、登录校验、角色鉴权
│       └── routes/          # auth / labels / suggestions（采纳事务）/ publications
└── web/                     # 前端（React 18 + Vite + TypeScript）
    └── src/
        ├── App.tsx          # 路由与角色守卫
        ├── auth-context.tsx # 登录态
        └── pages/           # 登录、校核工作台、馆员工作台、发布与差异
```

## 七、API 摘要

均返回 JSON；写操作要求 `Content-Type: application/json`，会话使用 HttpOnly Cookie。

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/login` · `/api/logout` | 公开 | 登录 / 退出 |
| GET | `/api/me` | 公开 | 当前登录用户 |
| GET | `/api/labels` · `/api/labels/:id` | 登录 | 展签与当前正文版本 |
| GET | `/api/labels/:id/suggestions` | 登录 | 建议列表 |
| POST | `/api/labels/:id/suggestions` | 校核人 | 提交建议（带 `expectedVersion`） |
| POST | `/api/suggestions/:id/adopt` | 馆员 | 采纳（事务：改正文、位移/冲突其余建议） |
| POST | `/api/labels/:id/publish` | 馆员 | 发布固化（带 `expectedVersion`） |
| GET | `/api/labels/:id/publications` · `/api/publications/:id` | 登录 | 发布历史 / 快照详情 |
| GET | `/api/labels/:id/diff?from=v&to=v` | 登录 | 两次发布正文差异 |
