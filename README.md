# Torrent 全品类通用搜索站 — Web 端（Cloudflare Worker 单体）

> TorrDex — a torrent index & search engine with real seeder counts and health scores. No fake numbers.

API + 前端在同一个 Worker 里：`src/worker.js` 一个文件（约 1200 行，无构建、无 npm 依赖），
HTML/CSS/JS 全部内嵌。数据在 Turso（libSQL），Worker 只通过 HTTP `/v2/pipeline` 读库
（外加搜索日志与投诉表单两个受控写入）。

配套文档：`../PRD-v1.md`（§6 FR / §7 排序与健康分 / §11 接口）、`../data-model-sqlite.sql`（§10.3 查询口径）。

## 部署（Dashboard 路线，无 wrangler 授权时用这条）

1. **建 Turso 只读令牌**（给 Worker 用，与爬虫的读写令牌分开）：
   - 打开 Turso 控制台 → 选数据库 `torrent-index` → 右上「…」/ Connect → **Create Token**，
     过期时间选不过期或 90 天，权限如有选项选 **Read-only**；或在装了 Turso CLI 的机器上：
     `turso db tokens create torrent-index --read-only`（以控制台实际选项为准）。
   - 令牌只显示一次，直接粘到下一步的 Secret 里，不要经聊天/文档中转。
2. **建 Worker**：Cloudflare Dashboard → Workers & Pages → Create Worker，命名 `torrent-search`
   （与 `wrangler.toml` 一致）→ Deploy 先出默认骨架。
3. **贴代码**：进入该 Worker → Edit code → 全选删除 → 把 `src/worker.js` 全文粘进去 → Save and deploy。
4. **加 Secrets**：Worker → Settings → Variables and Secrets → Add：
   - `TURSO_URL`（Secret）= 数据库地址，如 `https://torrent-index-<org>.aws-ap-northeast-1.turso.io`
     （`libsql://` 前缀也会被代码自动转换，二者皆可）
   - `TURSO_TOKEN`（Secret）= 第 1 步的只读令牌
   - 可选 `LOG_SALT`（Secret）= 搜索日志 IP 哈希盐，任意长随机串；不设时用代码内默认值。
5. 打开 `https://torrent-search.<你的子域>.workers.dev` 验证首页计数、搜一个已入库的词、
   打开种子详情点「复制磁力」。首页若显示「服务器尚未配置」= Secret 没加对。
6. **自定义域名**（站名/域名定下来之后）：Worker → Settings → Domains & Routes → Add Custom Domain。
   在此之前一律用 workers.dev 地址内测。

> 若之后有了 wrangler 授权：本目录 `wrangler.toml` 已备好，`wrangler deploy` + `wrangler secret put` 等价。

## 本地自检

```
node --check src/worker.js        # 语法
node test/selftest.mjs            # mock Turso: FTS/LIKE 路径、重排、磁力、成人过滤（21 项）
node test/sqlcheck.mjs            # 把 Worker 实际生成的 SQL 在真实 DDL 库上执行验真
```

## 行为约定（与 PRD 的对应关系）

- **搜索召回**（data-model §10.3，与爬虫 `store.search_torrents()` 同口径）：查询清洗后
  规范化长度 ≥3 → FTS5 trigram 整串短语 `MATCH` + `bm25()` 初排取 Top-200；
  <3 字 → `name_clean/name_raw LIKE` 子串兜底（按热度/做种排序）。编号型词（如 `snis850`）
  零结果时自动生成带连字符候选重试，命中后页面明示「已按 XXX 搜索」（FR-SRCH-01.5）。
  40 位 hex 直达种子、 `tt\d{7,8}` 直达作品（FR-SRCH-01.3/.4）。
- **重排**：Top-200 在 Worker 内按 PRD §7.2 公式重排（bm25 在候选集内 min-max 归一化；
  LIKE 召回无 bm25 时文本项取中性 0.6）；`health_band=dead` 在相关性排序中 ×0.1 沉底，
  但按做种/大小/最新显式排序时如实展示不隐藏。排序档：相关 / 推荐（§7.3）/ 做种 / 大小 / 最新。
- **真数口径**（§1.3）：做种/下载/完成来自库内实测快照并标注抓取时间；`NULL` 一律渲染
  「未知」，前端不存在任何写死的速度、下载量、热度数字。结果头「共 N 条（其中存活 M 条），
  用时 X 秒」中 N/M 来自同口径 facet GROUP BY 计数，X 为服务端实测耗时。
- **facet**：分类/画质/健康三维以 GROUP BY 在全命中集上计数（不受当前筛选影响的口径），
  渲染为可点筛选链接。注意：结果列表本身受筛选 + Top-200 召回限制，极端大结果集下
  「总数（facet 口径）」与「可翻页条数（≤200×页）」会不一致——这是 §10.3 架构的已知取舍，
  与爬虫本地搜索一致。
- **成人策略**（§5）：默认 SQL 层排除 `policy='adult'` 的分类与作品。开启需两步同时成立：
  页脚开关（弹年龄确认 → 写 cookie `adult=1`，30 天）**且** URL 带 `adult=1`。
  只改 URL 参数、没有 cookie 时仍排除（防外链直接带参绕过）。
- **搜索日志**（FR-SRCH-04）：`ctx.waitUntil` 异步写 `search_logs`，只记规范化词与结果数；
  IP 存 `sha256(ip|日期|LOG_SALT)`（日轮换盐），30 天滚动删除由本地批任务负责。
  注意：只读令牌下此 INSERT 会失败并被静默吞掉——若要日志与投诉落库，请给 Worker 的令牌
  改用读写令牌（与「只读」的取舍在部署时二选一，代码不感知）。同理 `/api/takedown` 投诉
  落库也需要写权限；无写权限时该接口返回 500，页面表单仍在（上线前必须确认令牌权限，
  FR-ADM-02 是 P1 项）。
- **缓存**：`/api/stats` 与 `/api/home` 走 Cache API，TTL 300 秒；其余接口不缓存。
- **磁力**：服务端拼装 `magnet:?xt=urn:btih:<hash>&dn=<name_clean>` + 种子自带 tracker
  与公共 tracker 列表（去重）。详情页有完整磁力文本框与一键复制（FR-TORR-03 的二维码未做，见下）。

## 尚未实现（对照 PRD，不要当已完成）

- **P1 内未尽**：FR-SRCH-01.6 查询结构化抽取的 chip 展示（年份/分辨率仅在编号纠错与筛选层部分实现）；
  FR-SRCH-03 拼写纠错候选与相似作品推荐（零结果只有去过滤重试 + 榜单入口）；
  FR-LIST-01 全量筛选（现仅分类/画质/健康/排序，缺大小区间、时间、做种下限、语言字幕、发布组、仅认证）；
  FR-LIST-03 海报卡片视图与视图记忆；FR-TITLE-04 纠错表单（表已在模型中，接口未开）；
  FR-TORR-04 详情页内嵌同作品其他版本（现以作品页链接代替）；FR-TORR-03 二维码；
  FR-BRWS-02 Top100 的时间窗口切换（现用 `popularity_7d` 单口径）；sitemap/SEO 收录策略（§9）未落地。
- **P2 未做**：元数据自动补全与海报墙、发布组/人物/厂商页（`/group`、`/person`、`/studio`）、
  订阅与到货提醒、成人分类正式开关决策（§14 待决；代码已按默认关实现）。
- **P3 未做**：账号体系、评论、三键反馈（`/api/feedback`）、用户提交（`/api/submit`）、
  认证与签名、举报/审核后台界面（队列与黑名单表在模型层，入库侧由爬虫执行 FR-ADM-01）。
- **运维侧**：搜索日志 30 天滚动删除、热搜重算（`trending_terms`）由本地爬虫机日批负责，
  未做之前首页热搜会一直用冷启动种子词（页面有口径标注）。
