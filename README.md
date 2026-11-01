# TorrDex（磁典）— 种子索引与搜索站 · Web 端

> TorrDex — a torrent index & search engine with real seeder counts and health scores. No fake numbers.

TorrDex 是一个全品类种子索引与搜索站：从 BitTorrent DHT 网络持续发现种子，
抓取元数据并实测做种数，给出真实的健康分——**站内不出现任何编造的数字**
（没有实测值的字段一律显示「未知」，并标注抓取时间）。

- 在线地址：**https://torrdex.com**
- 实时计数验证端点：https://torrdex.com/api/stats
  （截至 2026-11-01：种子 284 · 作品 421 · 存活 42，索引持续增长中，以该端点实时返回为准）
- 本仓库是 TorrDex 的 **Web 呈现层**：API 与前端在同一个 Cloudflare Worker 里，
  `src/worker.js` 单文件（约 106 KB，无构建、无 npm 依赖），HTML/CSS/JS 全部内嵌。

## 系统架构与数据流

```
┌────────────────────┐   DHT 发现 / 元数据 / 分类    ┌──────────────────┐
│  DHT 采集器         │ ── tracker 实测做种数 ──────▶ │  本地 SQLite      │
│  （站长家用         │                              │  （采集器同机）    │
│   Windows PC 常驻）  │                              └────────┬─────────┘
└────────────────────┘                                       │ 每 15 分钟批量推送
                                                             ▼
                                                    ┌──────────────────┐
                                                    │  Turso（libSQL）  │
                                                    │  库 torrent-index │
                                                    │  东京区域         │
                                                    └────────┬─────────┘
                                     HTTP /v2/pipeline 只读查询 ▲ │ 受控写入
                                                             │ ▼ （搜索日志/投诉/账号）
┌────────────────────┐    HTTPS     ┌────────────────────────────────┐
│  访客浏览器         │ ───────────▶ │  Cloudflare Worker（本仓库）    │
│  torrdex.com        │ ◀─────────── │  搜索 / 榜单 / 详情 / 账号      │
└────────────────────┘              └────────────────────────────────┘
```

- **采集层**（不在本仓库，在站长本地项目目录）：纯 Python 标准库实现的 DHT 爬虫，
  零第三方依赖。四个循环（发现、元数据、做种抓取、推送）各自带看门狗，单环报错
  自动重启；在本机 SQLite 落库后，每 15 分钟把精简数据批量推 Turso。
- **数据层**：Turso（libSQL）单库 `torrent-index`，是站点与采集器之间的唯一交汇点。
- **呈现层**（本仓库）：Worker 只通过 HTTP `/v2/pipeline` 访问 Turso——读是主体，
  另有三处受控写入：搜索日志、投诉表单、账号系统（注册/会话/收藏/搜索历史）。

## 仓库结构

```
.
├── README.md          # 本文件
├── wrangler.toml      # Worker 名 torrdex；[vars] 含 TURSO_URL；keep_vars = true
├── src/
│   └── worker.js      # 全部逻辑：路由、页面渲染、搜索、账号、数据访问
└── test/
    ├── selftest.mjs   # mock Turso 的行为自检（FTS/LIKE 路径、重排、磁力、成人默认显示）
    └── sqlcheck.mjs   # 把 Worker 实际生成的 SQL 在真实 DDL 库上执行验真
```

> 设计文档（PRD、数据模型 SQL）与采集器代码在站长本地的完整项目目录中，未入本仓；
> 本仓的查询口径与采集器本地搜索保持同源（见下文「行为约定」）。

## 核心模块（worker.js 内）

- **路由与页面**：首页（居中大搜索 + 榜单）、搜索结果、分类浏览、作品页、
  种子详情页、登录/注册、我的账号（收藏 / 搜索历史）。全站直角（矩形）UI、
  石墨色主按钮、浅色 / 深色双主题。
- **搜索**：见下文「行为约定」的召回与重排口径；40 位 hex 直达种子详情，
  IMDb 编号（`tt` + 7~8 位数字）直达作品。
- **数据访问**：所有 SQL 在 Worker 内生成，经 `/v2/pipeline` 执行；
  页面渲染不缓存假数据，计数类展示全部来自同口径实时查询。
- **账号系统**：邮箱注册/登录；密码 PBKDF2-SHA256（10 万次、加盐）哈希存储；
  会话令牌只存 sha256，`td_session` Cookie（HttpOnly，30 天）；`td_user` Cookie
  仅供页头显示邮箱，非登录凭据。账号相关三张表（`sessions`、`user_favorites`、
  `user_search_history`）由 Worker 首次用到时自建（幂等），无需手工迁移。
  暂无邮箱验证与找回密码（注册即用，后续接邮件服务再补）。
- **搜索日志**：`ctx.waitUntil` 异步写入 `search_logs`，只记规范化查询词与结果数；
  IP 存 `sha256(ip | 日期 | LOG_SALT)`，盐按日轮换。

## 数据模型要点

双层模型：**作品（Title）→ 种子（Torrent）**，一个作品可挂多个种子版本。

| 分组 | 主要表 | 说明 |
|---|---|---|
| 作品层 | `titles`、`categories`、`title_external_ids`、`persons`、`title_credits`、`studios`、`tags`、`title_tags`、`release_groups` | 作品元信息、分类、外部编号（IMDb 等）、演职员、厂牌、标签、发布组 |
| 种子层 | `torrents`、`torrent_files`、`torrent_trackers` | infohash（v1 与 v2 双索引）、大小、文件清单、tracker 列表、健康分与健康带（health_band）、抓取调度（`next_scrape_at`） |
| 采集 | `scrape_records` | 每次实测的做种/下载/完成快照（带时间），是「真数」的来源 |
| 账号与站点 | `users`、`sessions`、`user_favorites`、`user_search_history`、`search_logs`、`comments`、`feedback_votes`、`uploaders` | 账号、会话、个人收藏（与作品层 `favorites` 区分）、个人搜索历史（每人最近 200 条）、搜索日志、评论、投诉投票、上传者 |

口径要点：做种/下载/完成一律取 `scrape_records` 的实测快照并标注抓取时间；
`NULL` 渲染为「未知」；前端不存在写死的速度、下载量、热度数字。

## 部署

本仓库已连接 **Cloudflare Workers Builds**（Worker 名 `torrdex`，以 `wrangler.toml`
的 `name` 为准）：**推送到 `main` 分支即自动构建部署**——构建命令为空、
部署命令 `npx wrangler deploy`，无需本地 wrangler 授权，也不用手动粘贴代码。

一次性前置（已完成；迁移或重建时才需要再做）：

1. **Turso 令牌**：Turso 控制台 → 数据库 `torrent-index` → Create Token。
   现行用读写令牌，与采集器共用同一枚（搜索日志、投诉、账号落库需要写权限；
   只读令牌下这些写入会静默失败，取舍见注意事项）。令牌只显示一次，
   不要经聊天/文档中转。
2. **Worker 变量**（Dashboard → Worker `torrdex` → Settings → Variables and Secrets）：
   - `TURSO_URL`（变量）= `libsql://torrent-index-reardon.aws-ap-northeast-1.turso.io`
     （同时写在 `wrangler.toml` 的 `[vars]` 里，二者一致）
   - `TURSO_TOKEN`（Secret）= 第 1 步的令牌，加密保存，只写不可读
   - `LOG_SALT`（可选 Secret）= 搜索日志 IP 哈希盐；不设时用代码内默认值
   `wrangler.toml` 已设 `keep_vars = true`，Git 部署不会冲掉 Dashboard 管理的变量与机密。
3. **自定义域名**：`torrdex.com` 在 Worker `torrdex` 的 Domains 页绑定（生产环境）。

验证：打开 https://torrdex.com/api/stats 返回真实计数即通；
首页显示「服务器尚未配置」= 机密没配对。

## 本地开发与自检

无需构建，直接用 Node 跑仓库自带的三个检查（改 `src/worker.js` 后必跑）：

```
node --check src/worker.js    # 语法
node test/selftest.mjs        # mock Turso：FTS/LIKE 路径、重排、磁力、成人默认显示
node test/sqlcheck.mjs        # 把 Worker 实际生成的 SQL 在真实 DDL 库上执行验真
```

## 行为约定

- **搜索召回**：查询清洗后规范化长度 ≥3 → FTS5 trigram 整串短语 `MATCH` +
  `bm25()` 初排取 Top-200；<3 字 → `name_clean` / `name_raw` LIKE 子串兜底
  （按热度/做种排序）。编号型词（如 `snis850`）零结果时自动生成带连字符候选重试，
  命中后页面明示「已按 XXX 搜索」。
- **重排**：Top-200 在 Worker 内按公式重排（bm25 在候选集内 min-max 归一化；
  LIKE 召回无 bm25 时文本项取中性 0.6）；`health_band = dead` 在相关性排序中
  ×0.1 沉底，但按做种/大小/最新显式排序时如实展示、不隐藏。
  排序档：相关 / 推荐 / 做种 / 大小 / 最新。
- **facet**：分类 / 画质 / 健康三维以 GROUP BY 在全命中集上计数（不受当前
  筛选影响），渲染为可点筛选链接。
- **分页上限**：所有列表每页最多 20 条，榜单一律 Top 20 口径。
- **成人策略**（2026-10-28 站长定版）：无开关、无年龄门，成人内容默认直接显示；
  SQL 层不排除成人分类与作品，`/browse/adult` 直接可达。
- **结果头口径**：「共 N 条（其中存活 M 条），用时 X 秒」中 N/M 来自同口径
  facet GROUP BY 计数，X 为服务端实测耗时。

## 注意事项

- **令牌安全**：`TURSO_TOKEN` 等于数据库钥匙，只存于 Cloudflare Dashboard 的
  Secret 与采集器本机配置；绝不写入本仓库、文档或聊天。泄露后应在 Turso
  控制台作废旧令牌并换新，两处（Worker Secret、采集器配置）同步更换。
- **已知取舍**：结果列表受筛选 + Top-200 召回限制，极端大结果集下
  「总数（facet 口径）」与「可翻页条数（≤200 × 页）」会不一致——这是现行
  召回架构的有意取舍，与采集器本地搜索口径一致。
- **写入降级**：若 Worker 令牌被换成只读，搜索日志、投诉、账号写入会静默失败，
  页面读功能不受影响——排查「注册不了 / 日志没数」时先查令牌权限。
- **部署纪律**：`main` 即生产。改完先跑三项自检再推送；推送后以
  `/api/stats` 与首页实测为准，不要只看构建状态。
