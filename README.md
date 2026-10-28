# Torrent 全品类通用搜索站 — Web 端（Cloudflare Worker 单体）

> TorrDex — a torrent index & search engine with real seeder counts and health scores. No fake numbers.

API + 前端在同一个 Worker 里：`src/worker.js` 一个文件（约 1200 行，无构建、无 npm 依赖），
HTML/CSS/JS 全部内嵌。数据在 Turso（libSQL），Worker 只通过 HTTP `/v2/pipeline` 读库
（外加搜索日志与投诉表单两个受控写入）。

配套文档：`../PRD-v1.md`（§6 FR / §7 排序与健康分 / §11 接口）、`../data-model-sqlite.sql`（§10.3 查询口径）。

## 部署（Git 路线，现行）

本仓库 `ReardonYang/torrdex` 已连接 Cloudflare Workers Builds（Worker 名 `torrdex`，以
`wrangler.toml` 的 `name` 为准）：**推送到 `main` 分支即自动构建部署**——构建命令为空、
部署命令 `npx wrangler deploy`，无需本地 wrangler 授权，也不用再手动粘贴代码。

一次性前置（已完成；迁移或重建时才需要再做）：

1. **Turso 令牌**：Turso 控制台 → 数据库 `torrent-index` → Create Token（现行用读写令牌，
   与爬虫共用同一枚：搜索日志与投诉落库需要写权限；只读令牌下这两处会静默失败，
   取舍见「行为约定」）。令牌只显示一次，不要经聊天/文档中转。
2. **Worker 与变量**：Dashboard 建 Worker `torrdex` 后，在 Settings → Variables and Secrets 添加：
   - `TURSO_URL`（变量）= `libsql://torrent-index-reardon.aws-ap-northeast-1.turso.io`
     （同时写在 `wrangler.toml` 的 `[vars]` 里，二者一致）
   - `TURSO_TOKEN`（Secret）= 第 1 步的令牌，加密保存，只写不可读
   - 可选 `LOG_SALT`（Secret）= 搜索日志 IP 哈希盐；不设时用代码内默认值
   `wrangler.toml` 已设 `keep_vars = true`，Git 部署不会冲掉 Dashboard 管理的变量与机密。
3. **自定义域名**：`torrdex.com` 在 Worker `torrdex` 的 Domains 页绑定（生产环境）。

验证：打开 https://torrdex.com/api/stats 返回真实计数即通；首页显示「服务器尚未配置」
= 机密没配对。

## 本地自检

```
node --check src/worker.js        # 语法
node test/selftest.mjs            # mock Turso: FTS/LIKE 路径、重排、磁力、成人默认显示
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
- **成人策略**（2026-10-28 站长定）：无开关，成人内容默认直接显示。`adultAllowed()`
  恒为 true，SQL 层不排除 `policy='adult'` 的分类与作品，`/browse/adult` 直接可达。
  （历史：曾有页脚 cookie 开关，站长反馈不好用后按其指示改为默认显示。）
  2026-10-27 由「cookie + URL 参数双条件」改为单条件——双条件会让开关在普通站内
  跳转后静默失效（参数丢失），用户实测反馈「按钮失效」。只带参数、无 cookie 时仍排除。
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
  订阅与到货提醒。成人分类已按站长 2026-10-28 决策改为默认直接显示（无开关）。
- **P3 未做**：评论、三键反馈（`/api/feedback`）、用户提交（`/api/submit`）、
  认证与签名、举报/审核后台界面（队列与黑名单表在模型层，入库侧由爬虫执行 FR-ADM-01）。
  账号体系已于 2026-10-27 上线基础版（见上「账号」条），不在未做之列。
- **运维侧**：搜索日志 30 天滚动删除、热搜重算（`trending_terms`）由本地爬虫机日批负责。
  冷启动种子词已于 2026-10-27 撤除（用户定）：日批未跑出真实热搜前，首页不显示热搜区。
- **界面约定**（2026-10-27 定）：全站矩形无圆角；**头部区块全站统一**——站名大标题＋标语＋
  中央大搜索＋统计行由 layout 统一渲染，除登录/注册外每页完全一致、同位（统计走 60 秒缓存，
  成人开/关两份）；搜索框只在页面中央（抬头栏不放），
  分页（分类/最新/Top20/收藏/历史/账号）用与首页相同的版式：标题居中、搜索在其下（静态，
  不做固定头——试过 sticky 固定头，与列表内容重叠，已于当晚撤除）；
  列表每页最多 20 条；主按钮（搜索键、登录键）统一 42px 高、用石墨色（Graphite，
  乔布斯时代 Mac OS 的经典替代外观色），亮蓝水晶只留给详情页「复制磁力」与顶栏「注册」钮；
  外观切换两档名为「浅色 / 深色」（内部值 jobs / flat 不变）；登录、注册页不显示搜索框、
  登录框在主区正中；顶栏账号区为「登录（浅色次钮）+ 注册（亮色主钮）」双按钮，登录后
  合并为一个邮箱按钮（进我的账号），与内容导航文字链区隔。空内容页底栏贴底（弹性布局）。
  分类页「热门 / 最新收录」用与外观段控同源的段控切换钮，居中置于列表之上。
- **账号**（2026-10-27 新增）：邮箱注册/登录（密码 PBKDF2-SHA256 10 万次加盐哈希存
  `users.password_hash`；会话令牌只存 sha256，cookie `td_session` HttpOnly 30 天；
  `td_user` 仅供页头显示邮箱，非登录凭据）。登录后可收藏种子（`user_favorites`，
  区别于模型里按作品收藏的 `favorites`）、查看个人搜索历史（`user_search_history`，
  每人保留最近 200 条）。`sessions` 等三张表由 Worker 首次用到时自建（幂等），
  无需手工迁移。暂无邮箱验证与找回密码（注册即用，风险自担，后续接邮件服务再补）。
