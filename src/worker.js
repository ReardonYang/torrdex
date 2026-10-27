// ============================================================
// Torrent 全品类通用搜索站 — Cloudflare Worker (API + 前端同体, 无构建无依赖)
// 配套: PRD-v1.md (§6 FR / §7 排序健康 / §11 接口), data-model-sqlite.sql (§10.3 查询口径)
// 数据: Turso (libSQL HTTP /v2/pipeline), 凭据 env: TURSO_URL / TURSO_TOKEN (读写: 搜索日志/账号/收藏需写)
// 部署: Git 集成 (推送仓库 main 分支 -> Cloudflare Workers Builds 自动部署), 见 README.md
// 铁律 (PRD §1.3): 所有数字必须真数 — 做种/下载来自库内实测快照, 无数据写「未知」,
//                 绝不编造速度/下载量/热度。
// ============================================================

// ---------------- 常量 ----------------

const PAGE_SIZE = 20;   // 每页条数 (2026-10-27 用户定: 所有列表一律最多 20 条)
const RECALL_LIMIT = 200;          // §10.3: 召回 Top-200 后应用层重排

const PUBLIC_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://tracker.bittor.pw:1337/announce",
  "udp://public.popcorn-tracker.org:6969/announce",
  "udp://tracker.dler.org:6969/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://glotorrents.pw:6969/announce",
  "udp://tracker.coppersurfer.tk:6969/announce",
  "udp://udp.tracker.leechers-paradise.org:6969/announce",
];

// 热搜只用真实搜索日志 (trending_terms 由日批从 search_logs 重算, FR-HOME-01);
// 无真实数据时首页不显示热搜区 (2026-10-27 用户定: 撤掉冷启动种子词)。

const HEALTH_LABEL = { alive: "活", weak: "弱", dead: "死", unknown: "未知" };
const MAIN_CODECS = new Set(["x264", "x265", "AV1", "VP9"]);

// ---------------- 基础工具 ----------------

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function fmtSize(bytes) {
  if (bytes == null || isNaN(bytes)) return "未知";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = Number(bytes), i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? String(Math.round(v)) : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)) + " " + units[i];
}

export function fmtNum(n) {
  if (n == null) return "未知";
  return Number(n).toLocaleString("en-US");
}

export function fmtAge(iso, now = Date.now()) {
  if (!iso) return "未知";
  const t = Date.parse(iso);
  if (isNaN(t)) return "未知";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return "刚刚";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  if (s < 86400 * 30) return Math.floor(s / 86400) + " 天前";
  if (s < 86400 * 365) return Math.floor(s / (86400 * 30)) + " 个月前";
  return Math.floor(s / (86400 * 365)) + " 年前";
}

export function fmtTime(iso) {
  if (!iso) return "未知";
  const d = new Date(iso);
  if (isNaN(d)) return "未知";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

function parseJsonArr(s) {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

// ---------------- 查询规范化 (镜像 crawler parse.normalized_key / store.search_torrents) ----------------

// §8.5: NFKC 全半角统一 -> 小写 -> 去标点与空白, 保留文字/数字 (与 Python 版等价实现)
export function normalizedKey(text) {
  if (!text) return "";
  return String(text).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}_]/gu, "");
}

// FR-SRCH-01 基础清洗: 全半角统一(NFKC)、连续空白折叠、去首尾符号; 原文保留展示
export function cleanQuery(raw) {
  if (!raw) return "";
  let q = String(raw).normalize("NFKC").replace(/\s+/g, " ").trim();
  q = q.replace(/^[\s\p{P}]+/u, "").replace(/[\s\p{P}]+$/u, "").trim();
  return q.slice(0, 200);
}

function likeEscape(s) {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// ---------------- Turso (libSQL HTTP /v2/pipeline) ----------------

function argVal(v) {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { type: "integer", value: String(v) } : { type: "float", value: v };
  }
  if (typeof v === "boolean") return { type: "integer", value: v ? "1" : "0" };
  return { type: "text", value: String(v) };
}

function cellVal(c) {
  if (!c || c.type === "null") return null;
  if (c.type === "integer") return Number(c.value);
  if (c.type === "float") return c.value;
  return c.value; // text / blob(base64, 本站不用)
}

// statements: [{sql, args:[...]}] -> 每条语句返回行对象数组; 任一语句报错即抛错
export async function turso(env, statements) {
  const base = String(env.TURSO_URL || "").replace(/^libsql:\/\//, "https://").replace(/\/+$/, "");
  if (!base || !env.TURSO_TOKEN) throw new Error("db_not_configured");
  const body = {
    requests: [
      ...statements.map((s) => ({ type: "execute", stmt: { sql: s.sql, args: (s.args || []).map(argVal) } })),
      { type: "close" },
    ],
  };
  const resp = await fetch(base + "/v2/pipeline", {
    method: "POST",
    headers: { "Authorization": "Bearer " + env.TURSO_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error("db_http_" + resp.status);
  const payload = await resp.json();
  return (payload.results || []).map((item) => {
    if (item.type === "error") throw new Error("db_error");
    const res = item.response && item.response.result;
    if (!res) return [];
    const cols = (res.cols || []).map((c) => c.name);
    return (res.rows || []).map((row) => {
      const obj = {};
      cols.forEach((name, i) => { obj[name] = cellVal(row[i]); });
      return obj;
    });
  });
}

async function q1(env, sql, args) { return (await turso(env, [{ sql, args }]))[0]; }

// ---------------- 分类缓存 (isolate 内 60s) ----------------

let _catsCache = { at: 0, rows: [] };
async function getCategories(env) {
  if (Date.now() - _catsCache.at < 60000 && _catsCache.rows.length) return _catsCache.rows;
  const rows = await q1(env,
    "SELECT id, code, name_zh, name_en, policy FROM categories WHERE is_enabled=1 ORDER BY sort_order, id", []);
  _catsCache = { at: Date.now(), rows };
  return rows;
}
function catByCode(cats, code) { return cats.find((c) => c.code === code) || null; }
function catById(cats, id) { return cats.find((c) => c.id === id) || null; }

// ---------------- 成人策略 (PRD §5: 默认关, 主动开启才参与) ----------------

// 只认 cookie adult=1: 该 cookie 只能由页脚开关经年龄确认后写入, 写入本身即「主动开启」
// 的凭据。旧版「cookie + URL 参数双条件」会让开关在普通站内跳转后静默失效 (参数丢失),
// 用户反馈按钮失效, 2026-10-27 改为单条件。无 cookie -> SQL 层排除成人分类与作品。
export function adultAllowed(request, url) {
  const cookie = request.headers.get("Cookie") || "";
  return /(?:^|;\s*)adult=1(?:;|$)/.test(cookie);
}

function adultSql(alias, allowed) {
  if (allowed) return "";
  return ` AND ${alias}.category_id NOT IN (SELECT id FROM categories WHERE policy='adult')` +
         ` AND (${alias}.title_id IS NULL OR ${alias}.title_id NOT IN (SELECT id FROM titles WHERE policy='adult'))`;
}

// ---------------- 磁力拼装 (与 PG 版口径一致: 应用层 xt + dn + tr) ----------------

export function buildMagnet(infohash, displayName, storedTrackers) {
  const seen = new Set();
  const trs = [];
  for (const t of [...(storedTrackers || []), ...PUBLIC_TRACKERS]) {
    if (t && !seen.has(t)) { seen.add(t); trs.push(t); }
  }
  let m = "magnet:?xt=urn:btih:" + infohash;
  if (displayName) m += "&dn=" + encodeURIComponent(displayName);
  for (const t of trs) m += "&tr=" + encodeURIComponent(t);
  return m;
}

// ---------------- §7 排序 ----------------

function trustVal(trust) { return trust === "vip" ? 1 : trust === "trusted" ? 0.5 : 0; }

function freshnessScore(firstSeenAt, now = Date.now()) {
  if (!firstSeenAt) return 0;
  const ageDays = (now - Date.parse(firstSeenAt)) / 86400000;
  if (isNaN(ageDays)) return 0;
  return Math.max(0, 1 - ageDays / 30);
}

// §7.2 相关性: text*0.55 + log做种*0.20 + health*0.15 + trust*0.05 + freshness*0.05
// bm25 归一化: 候选集内 min-max (FTS5 bm25 越小越相关); LIKE 召回无 bm25 时 text=0.6 中性值。
// health_band='dead' 在相关性排序中强制沉底 (×0.1); 显式排序不藏, 如实展示。
export function relevanceScore(row, ctx) {
  let text;
  if (row.bm25 == null) text = 0.6;
  else if (ctx.bm25Max > ctx.bm25Min) text = (ctx.bm25Max - row.bm25) / (ctx.bm25Max - ctx.bm25Min);
  else text = 0.5;
  const seedTerm = Math.min(1, Math.log10(1 + (row.seeders || 0)) / 3);
  let s = text * 0.55 + seedTerm * 0.20 + ((row.health_score || 0) / 100) * 0.15
        + trustVal(row.group_trust) * 0.05 + freshnessScore(row.first_seen_at) * 0.05;
  if (row.health_band === "dead") s *= 0.1;
  return s;
}

// §7.3 作品内推荐分 + 可解释理由
export function recScore(row) {
  let spec = 0;
  const subs = parseJsonArr(row.subtitles);
  if (subs.length) spec += 0.4;
  if (MAIN_CODECS.has(row.video_codec)) spec += 0.3;
  if (row.resolution === "1080p" || row.resolution === "2160p") spec += 0.3;
  const seedTerm = Math.min(1, Math.log10(1 + (row.seeders || 0)) / 3);
  return (row.health_score || 0) * 0.5 + seedTerm * 100 * 0.3 + spec * 20;
}

export function recReasons(row, siblings) {
  const reasons = [];
  const maxSeed = Math.max(...siblings.map((r) => r.seeders || 0));
  if ((row.seeders || 0) > 0 && row.seeders === maxSeed) reasons.push("做种最高");
  if (row.group_verified) reasons.push("认证组");
  const subs = parseJsonArr(row.subtitles);
  if (subs.includes("chs") || subs.includes("cht")) reasons.push("有中字");
  if (row.resolution === "2160p") reasons.push("4K");
  if ((row.health_score || 0) >= 70) reasons.push("健康分高");
  return reasons;
}

export function rerank(rows, sort) {
  const out = [...rows];
  if (sort === "seeders") {
    out.sort((a, b) => (b.seeders ?? -1) - (a.seeders ?? -1) || (b.health_score || 0) - (a.health_score || 0));
  } else if (sort === "size") {
    out.sort((a, b) => (b.total_size || 0) - (a.total_size || 0));
  } else if (sort === "newest") {
    out.sort((a, b) => String(b.first_seen_at || "").localeCompare(String(a.first_seen_at || "")));
  } else if (sort === "recommended") {
    out.sort((a, b) => recScore(b) - recScore(a) || (b.seeders ?? -1) - (a.seeders ?? -1));
  } else { // relevance (默认)
    const vals = out.filter((r) => r.bm25 != null).map((r) => r.bm25);
    const ctx = { bm25Min: vals.length ? Math.min(...vals) : 0, bm25Max: vals.length ? Math.max(...vals) : 0 };
    out.sort((a, b) => relevanceScore(b, ctx) - relevanceScore(a, ctx) || (b.seeders ?? -1) - (a.seeders ?? -1));
  }
  return out;
}

// ---------------- 搜索召回 (data-model §10.3 + crawler store.search_torrents 同口径) ----------------

const TOR_COLS = `t.infohash, t.title_id, t.category_id, t.name_raw, t.name_clean,
  t.total_size, t.file_count, t.year, t.season_no, t.episode_no, t.resolution,
  t.source_type, t.video_codec, t.audio_codec, t.is_hdr, t.is_dolby_vision,
  t.subtitles, t.languages, t.edition, t.seeders, t.leechers, t.completed,
  t.health_score, t.health_band, t.scraped_at, t.first_seen_at, t.last_seen_at,
  t.popularity_7d, t.magnet_clicks, t.size_mismatch, t.is_private, t.piece_length,
  g.name AS group_name, g.trust AS group_trust, g.is_verified AS group_verified`;
const TOR_JOIN = ` FROM torrents t LEFT JOIN release_groups g ON g.id = t.group_id`;

// 构建筛选 WHERE 片段 (全部参数化)。filters: {catId, resolution, health}
function filterSql(filters, args, alias = "t") {
  let s = "";
  if (filters.catId != null) { s += ` AND ${alias}.category_id = ?`; args.push(filters.catId); }
  if (filters.resolution) { s += ` AND ${alias}.resolution = ?`; args.push(filters.resolution); }
  if (filters.health) { s += ` AND ${alias}.health_band = ?`; args.push(filters.health); }
  return s;
}

// 返回 {rows(带 bm25 或 null), mode: 'fts'|'like', searchedAs}
async function recall(env, q, filters, allowed, limit = RECALL_LIMIT) {
  const nk = normalizedKey(q);
  if ([...nk].length >= 3) {
    // FTS5 trigram: 整串短语 MATCH + bm25 初排 (与 crawler 一致)
    const phrase = '"' + q.replace(/"/g, '""') + '"';
    const args = [phrase];
    const sql = `SELECT ${TOR_COLS}, bm25(torrents_fts) AS bm25 FROM torrents_fts` +
      ` JOIN torrents t ON t.infohash = torrents_fts.infohash` +
      ` LEFT JOIN release_groups g ON g.id = t.group_id` +
      ` WHERE torrents_fts MATCH ? AND torrents_fts.status = 'active' AND t.status = 'active'` +
      adultSql("t", allowed) + filterSql(filters, args) +
      ` ORDER BY bm25(torrents_fts) LIMIT ?`;
    args.push(limit);
    const rows = await q1(env, sql, args);
    if (rows.length) return { rows, mode: "fts", searchedAs: q };
    // 编号型词 (snis850 式) 零结果时: 生成带连字符候选双路检索 (FR-SRCH-01.5)
    const m = q.match(/^([A-Za-z]+)(\d+)$/);
    if (m) {
      const cand = m[1] + "-" + m[2];
      const args2 = ['"' + cand + '"'];
      const rows2 = await q1(env, sql.replace("LIMIT ?", "LIMIT ?"), [...args2, ...args.slice(1)]);
      if (rows2.length) return { rows: rows2, mode: "fts", searchedAs: cand };
    }
    return { rows, mode: "fts", searchedAs: q };
  }
  // <3 字符: LIKE 子串兜底 (trigram 对 1-2 字词不产生匹配, §10.3 必守)
  const like = "%" + likeEscape(q) + "%";
  const args = [like, like];
  const sql = `SELECT ${TOR_COLS}, NULL AS bm25 ${TOR_JOIN}` +
    ` WHERE t.status = 'active' AND (t.name_clean LIKE ? ESCAPE '\\' OR t.name_raw LIKE ? ESCAPE '\\')` +
    adultSql("t", allowed) + filterSql(filters, args) +
    ` ORDER BY t.popularity_7d DESC, t.seeders DESC LIMIT ?`;
  args.push(limit);
  const rows = await q1(env, sql, args);
  return { rows, mode: "like", searchedAs: q };
}

// facet 计数: 与召回同口径的命中集上 GROUP BY (分类/画质/健康三维, 一次 pipeline 三条)
async function facetCounts(env, q, allowed) {
  const nk = normalizedKey(q);
  const dims = [
    ["category", "t.category_id"],
    ["resolution", "t.resolution"],
    ["health", "t.health_band"],
  ];
  let from, baseArgs, baseWhere;
  if ([...nk].length >= 3) {
    from = ` FROM torrents_fts JOIN torrents t ON t.infohash = torrents_fts.infohash`;
    baseArgs = ['"' + q.replace(/"/g, '""') + '"'];
    baseWhere = ` WHERE torrents_fts MATCH ? AND torrents_fts.status = 'active' AND t.status = 'active'`;
  } else {
    const like = "%" + likeEscape(q) + "%";
    from = TOR_JOIN;
    baseArgs = [like, like];
    baseWhere = ` WHERE t.status = 'active' AND (t.name_clean LIKE ? ESCAPE '\\' OR t.name_raw LIKE ? ESCAPE '\\')`;
  }
  const stmts = dims.map(([, col]) => ({
    sql: `SELECT ${col} AS k, COUNT(*) AS n ${from} ${baseWhere}` + adultSql("t", allowed) +
         ` GROUP BY ${col} ORDER BY n DESC LIMIT 60`,
    args: [...baseArgs],
  }));
  const results = await turso(env, stmts);
  const facets = {};
  dims.forEach(([name], i) => {
    facets[name] = {};
    for (const r of results[i]) { if (r.k != null && r.k !== "") facets[name][r.k] = r.n; }
  });
  const total = Object.values(facets.health || {}).reduce((a, b) => a + b, 0);
  return { facets, facetTotal: total };
}

// ---------------- 数据整形 ----------------

function torrentJson(row, cats, trackers) {
  return {
    infohash: row.infohash,
    title_id: row.title_id,
    category_id: row.category_id,
    category: catById(cats, row.category_id)?.code || null,
    name: row.name_clean,
    name_raw: row.name_raw,
    total_size: row.total_size,
    file_count: row.file_count,
    year: row.year, season_no: row.season_no, episode_no: row.episode_no,
    resolution: row.resolution, source_type: row.source_type,
    video_codec: row.video_codec, audio_codec: row.audio_codec,
    is_hdr: !!row.is_hdr, is_dolby_vision: !!row.is_dolby_vision,
    subtitles: parseJsonArr(row.subtitles), languages: parseJsonArr(row.languages),
    edition: row.edition,
    group_name: row.group_name || null,
    group_verified: !!row.group_verified,
    // 真数口径: 未抓到就是 null -> 前端渲染「未知」, 禁止补 0 冒充 (§1.3)
    seeders: row.seeders, leechers: row.leechers, completed: row.completed,
    health_score: row.health_score, health_band: row.health_band,
    scraped_at: row.scraped_at, first_seen_at: row.first_seen_at,
    popularity_7d: row.popularity_7d,
    magnet: buildMagnet(row.infohash, row.name_clean, trackers || []),
  };
}

// ---------------- 搜索 (API 与结果页共用同一实现) ----------------

async function doSearch(env, params, allowed) {
  const t0 = Date.now();
  const q = cleanQuery(params.q || "");
  const cats = await getCategories(env);
  const sort = ["relevance", "recommended", "seeders", "size", "newest"].includes(params.sort)
    ? params.sort : "relevance";
  const page = Math.max(1, parseInt(params.page || "1", 10) || 1);
  const filters = {
    catId: params.cat ? (catByCode(cats, params.cat)?.id ?? -1) : null,
    resolution: params.resolution || null,
    health: ["alive", "weak", "dead", "unknown"].includes(params.health) ? params.health : null,
  };
  if (!q) return { q, empty: true, torrents: [], titles: [], total: 0, alive: 0, facets: {}, page, sort, took_ms: 0 };

  // FR-SRCH-01.4: 40 位 hex -> infohash 直达
  if (/^[0-9a-fA-F]{40}$/.test(q)) {
    const rows = await q1(env, `SELECT ${TOR_COLS} ${TOR_JOIN} WHERE t.infohash = ?`, [q.toLowerCase()]);
    return { q, direct: rows.length ? { type: "torrent", infohash: q.toLowerCase() } : null,
             torrents: rows.map((r) => torrentJson(r, cats)), titles: [], total: rows.length,
             alive: rows.filter((r) => r.health_band === "alive").length, facets: {}, page, sort, took_ms: Date.now() - t0 };
  }
  // FR-SRCH-01.3: tt\d{7,8} -> IMDb ID 直查作品层
  const imdb = q.match(/^tt\d{7,8}$/i);
  if (imdb) {
    const hit = await q1(env,
      "SELECT title_id FROM title_external_ids WHERE source='imdb' AND external_id = ?", [q.toLowerCase()]);
    if (hit.length) return { q, direct: { type: "title", id: hit[0].title_id }, torrents: [], titles: [],
                             total: 0, alive: 0, facets: {}, page, sort, took_ms: Date.now() - t0 };
  }

  const [{ rows, mode, searchedAs }, fct] = await Promise.all([
    recall(env, q, filters, allowed),
    facetCounts(env, q, allowed),
  ]);
  // facet 是全命中口径 (含筛选前); 展示的总数用 facetTotal 与筛选的并存关系见 README
  const total = fct.facetTotal;
  const alive = (fct.facets.health && fct.facets.health.alive) || 0;

  const ranked = rerank(rows, sort);
  const pageRows = ranked.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // 作品聚合 (FR-LIST-04): 本页内同 title 命中 >=2 条 -> 聚合卡在前
  const byTitle = new Map();
  for (const r of pageRows) {
    if (r.title_id != null) {
      if (!byTitle.has(r.title_id)) byTitle.set(r.title_id, []);
      byTitle.get(r.title_id).push(r);
    }
  }
  const groupIds = [...byTitle.entries()].filter(([, v]) => v.length >= 2).map(([k]) => k);
  let titleCards = [];
  if (groupIds.length) {
    const ph = groupIds.map(() => "?").join(",");
    const trows = await q1(env,
      `SELECT id, canonical_title, original_title, year, poster_thumb, torrent_count, alive_count, best_health, category_id
       FROM titles WHERE id IN (${ph})`, groupIds);
    const tmap = new Map(trows.map((t) => [t.id, t]));
    titleCards = groupIds.map((id) => {
      const t = tmap.get(id);
      const members = byTitle.get(id);
      const best = [...members].sort((a, b) => recScore(b) - recScore(a))[0];
      return {
        id, title: t ? t.canonical_title : best.name_clean,
        original_title: t ? t.original_title : null,
        year: t ? t.year : best.year,
        poster_thumb: t ? t.poster_thumb : null,
        category: catById(cats, t ? t.category_id : best.category_id)?.code || null,
        matched_versions: members.length,
        torrent_count: t ? t.torrent_count : members.length,
        alive_count: t ? t.alive_count : members.filter((m) => m.health_band === "alive").length,
        best_health: t ? t.best_health : Math.max(...members.map((m) => m.health_score || 0)),
        best: torrentJson(best, cats),
        best_reasons: recReasons(best, members),
      };
    }).filter((c) => c.id != null);
    titleCards.sort((a, b) => (b.best_health || 0) - (a.best_health || 0));
  }

  return {
    q, searched_as: searchedAs, mode, sort, page, page_size: PAGE_SIZE,
    total, alive,
    facets: {
      category: Object.fromEntries(Object.entries(fct.facets.category || {})
        .map(([id, n]) => [catById(cats, Number(id))?.code || id, n])),
      resolution: fct.facets.resolution || {},
      health: fct.facets.health || {},
    },
    titles: titleCards,
    torrents: pageRows.map((r) => torrentJson(r, cats)),
    took_ms: Date.now() - t0,
  };
}

// ---------------- 其它数据接口 ----------------

async function doAutocomplete(env, rawQ, allowed) {
  const q = cleanQuery(rawQ || "");
  if ([...normalizedKey(q)].length < 2) return { titles: [], torrents: [] };
  const cats = await getCategories(env);
  let titleRows;
  if ([...normalizedKey(q)].length >= 3) {
    titleRows = await q1(env,
      `SELECT f.title_id AS id, f.canonical_title, t.year, t.torrent_count, t.poster_thumb
       FROM titles_fts f JOIN titles t ON t.id = f.title_id
       WHERE titles_fts MATCH ? ORDER BY bm25(titles_fts) LIMIT 5`,
      ['"' + q.replace(/"/g, '""') + '"']);
  } else {
    const like = "%" + likeEscape(q) + "%";
    titleRows = await q1(env,
      `SELECT id, canonical_title, year, torrent_count, poster_thumb FROM titles
       WHERE canonical_title LIKE ? ESCAPE '\\' ORDER BY popularity_7d DESC LIMIT 5`, [like]);
  }
  const { rows } = await recall(env, q, {}, allowed, 5);
  return {
    titles: titleRows.map((t) => ({ id: t.id, title: t.canonical_title, year: t.year,
      torrent_count: t.torrent_count, poster_thumb: t.poster_thumb })),
    torrents: rows.map((r) => ({ infohash: r.infohash, name: r.name_clean, seeders: r.seeders })),
  };
}

async function doTitle(env, id, allowed) {
  const cats = await getCategories(env);
  const trows = await q1(env, "SELECT * FROM titles WHERE id = ?", [id]);
  if (!trows.length) return null;
  const t = trows[0];
  if (!allowed && (t.policy === "adult" || catById(cats, t.category_id)?.policy === "adult")) return null;
  const [extIds, versions] = await turso(env, [
    { sql: "SELECT source, external_id FROM title_external_ids WHERE title_id = ?", args: [id] },
    { sql: `SELECT ${TOR_COLS} ${TOR_JOIN} WHERE t.title_id = ? AND t.status = 'active' ORDER BY t.health_score DESC, t.seeders DESC LIMIT 200`,
      args: [id] },
  ]);
  const vrows = versions.map((r) => ({ ...r }));
  const ranked = [...vrows].sort((a, b) => recScore(b) - recScore(a));
  const bestHash = ranked.length ? ranked[0].infohash : null;
  return {
    title: {
      id: t.id, canonical_title: t.canonical_title, original_title: t.original_title,
      aliases: parseJsonArr(t.aliases), year: t.year, release_date: t.release_date,
      duration_min: t.duration_min, season_no: t.season_no, synopsis: t.synopsis,
      poster_url: t.poster_url, poster_thumb: t.poster_thumb, region: t.region,
      languages: parseJsonArr(t.languages),
      category: catById(cats, t.category_id)?.code || null,
      torrent_count: t.torrent_count, alive_count: t.alive_count, best_health: t.best_health,
      external_ids: extIds,
    },
    versions: vrows.map((r) => {
      const j = torrentJson(r, cats);
      j.is_recommended = r.infohash === bestHash;
      j.reasons = r.infohash === bestHash ? recReasons(r, vrows) : [];
      return j;
    }),
  };
}

async function doTorrent(env, infohash, allowed) {
  const cats = await getCategories(env);
  const rows = await q1(env, `SELECT ${TOR_COLS} ${TOR_JOIN} WHERE t.infohash = ?`, [infohash]);
  if (!rows.length) return null;
  const r = rows[0];
  if (!allowed && catById(cats, r.category_id)?.policy === "adult") return null;
  const [files, trackers, titleRows] = await turso(env, [
    { sql: "SELECT file_index, path, size FROM torrent_files WHERE infohash = ? ORDER BY file_index", args: [infohash] },
    { sql: "SELECT tracker_url FROM torrent_trackers WHERE infohash = ?", args: [infohash] },
    { sql: "SELECT id, canonical_title, year FROM titles WHERE id = ?", args: [r.title_id ?? -1] },
  ]);
  // 健康曲线: 云端按 §16.2 不存时序, 此查询多半为空 — 如实返回空数组, 前端显示「暂无历史」
  let scrapes = [];
  try {
    scrapes = await q1(env,
      "SELECT scraped_at, seeders, leechers, completed FROM scrape_records WHERE infohash = ? ORDER BY scraped_at DESC LIMIT 7",
      [infohash]);
  } catch { scrapes = []; }
  const filesSum = files.reduce((a, f) => a + (f.size || 0), 0);
  const j = torrentJson(r, cats, trackers.map((t) => t.tracker_url));
  return {
    torrent: {
      ...j,
      is_private: !!r.is_private, piece_length: r.piece_length,
      pieces: r.piece_length ? Math.ceil((r.total_size || 0) / r.piece_length) : null,
      size_mismatch: !!r.size_mismatch,
      created_at_src: r.created_at_src || null, last_seen_at: r.last_seen_at,
    },
    files,
    size_check: { declared: r.total_size, files_sum: filesSum, files_present: files.length > 0,
                  consistent: files.length ? filesSum === r.total_size : null },
    trackers: trackers.map((t) => t.tracker_url),
    health_history: scrapes.reverse(),
    title: titleRows.length ? { id: titleRows[0].id, canonical_title: titleRows[0].canonical_title, year: titleRows[0].year } : null,
  };
}

async function doStats(env, allowed) {
  const res = await turso(env, [
    { sql: `SELECT COUNT(*) AS torrents, SUM(CASE WHEN t.health_band='alive' THEN 1 ELSE 0 END) AS alive,
                   MAX(t.last_seen_at) AS updated_at ${TOR_JOIN} WHERE t.status = 'active'` + adultSql("t", allowed), args: [] },
    { sql: "SELECT COUNT(*) AS titles FROM titles" + (allowed ? "" : " WHERE policy != 'adult'"), args: [] },
    { sql: `SELECT t.category_id AS cid, COUNT(*) AS n ${TOR_JOIN} WHERE t.status='active'` +
           adultSql("t", allowed) + " GROUP BY t.category_id", args: [] },
  ]);
  const cats = await getCategories(env);
  const byCat = {};
  for (const r of res[2] || []) byCat[catById(cats, r.cid)?.code || r.cid] = r.n;
  return {
    torrents: res[0]?.[0]?.torrents || 0,
    titles: res[1]?.[0]?.titles || 0,
    alive: res[0]?.[0]?.alive || 0,
    updated_at: res[0]?.[0]?.updated_at || null,
    by_category: byCat,
  };
}

async function doList(env, kind, catCode, allowed) {
  const cats = await getCategories(env);
  const filters = { catId: catCode ? (catByCode(cats, catCode)?.id ?? -1) : null, resolution: null, health: null };
  const args = [];
  const order = kind === "latest" ? "t.first_seen_at DESC" : "t.popularity_7d DESC, t.seeders DESC";
  const limit = 20;   // 列表页上限 20 条 (2026-10-27 用户定, 不再 50/100)
  const sql = `SELECT ${TOR_COLS} ${TOR_JOIN} WHERE t.status = 'active'` +
    adultSql("t", allowed) + filterSql(filters, args) + ` ORDER BY ${order} LIMIT ?`;
  args.push(limit);
  const rows = await q1(env, sql, args);
  return { kind, category: catCode || null, torrents: rows.map((r) => torrentJson(r, cats)) };
}

let _statsCache = { off: null, on: null };
async function getStatsCached(env, allowed) {
  const key = allowed ? "on" : "off";
  const hit = _statsCache[key];
  if (hit && Date.now() - hit.at < 60000) return hit.val;
  const val = await doStats(env, allowed);
  _statsCache[key] = { at: Date.now(), val };
  return val;
}

async function doHome(env, allowed) {
  const [stats, trendRows, latest, top] = await Promise.all([
    doStats(env, allowed),
    q1(env, "SELECT term, search_count_7d FROM trending_terms ORDER BY search_count_7d DESC LIMIT 15", [])
      .catch(() => []),
    doList(env, "latest", null, allowed),
    doList(env, "top", null, allowed),
  ]);
  const trending = { source: trendRows.length ? "logs" : "none",
    terms: trendRows.map((r) => ({ term: r.term, count: r.search_count_7d })) };
  return { stats, trending, latest: latest.torrents.slice(0, 10), top: top.torrents.slice(0, 12) };
}

// FR-SRCH-04: 只记规范化词/结果数, IP 只存 sha256(ip + 日期 + 盐) 哈希; fire-and-forget
async function logSearch(env, ctx, request, qRaw, qNorm, resultCount, catId) {
  try {
    const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
    const day = new Date().toISOString().slice(0, 10);
    const salt = env.LOG_SALT || "torrent-search-v1";
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ip}|${day}|${salt}`));
    const ipHash = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const p = turso(env, [{
      sql: "INSERT INTO search_logs (query_raw, query_normalized, result_count, has_magnet_click, category_id, ip_hash) VALUES (?,?,?,?,?,?)",
      args: [String(qRaw || "").slice(0, 200), qNorm, resultCount, 0, catId ?? null, ipHash],
    }]).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(p);
  } catch { /* 日志失败不影响搜索 */ }
}

// ---------------- Cache API (stats / home 短 TTL) ----------------

async function cachedJson(ctx, request, ttlSec, producer) {
  let cache = null;
  try { cache = typeof caches !== "undefined" ? caches.default : null; } catch { cache = null; }
  const key = new Request(new URL(request.url).toString(), { method: "GET" });
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  const data = await producer();
  const resp = new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${ttlSec}` },
  });
  if (cache && ctx && ctx.waitUntil) ctx.waitUntil(cache.put(key, resp.clone()));
  return resp;
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// ---------------- 前端 (内嵌; 中文 UI; 苹果设计语言; 一页一个搜索入口; 桌面居中 980px) ----------------

const CSS = `
*{box-sizing:border-box}
html{scrollbar-gutter:stable;-webkit-text-size-adjust:100%;color-scheme:light;
--bg:#f5f5f6;--bgimg:linear-gradient(#ffffff,#efeff1);
--ink:#1d1d1f;--mut:#6e6e73;--faint:#86868b;--link:#0066cc;
--bar-bg:linear-gradient(#545456,#333335 50%,#242426 50%,#2e2e30);--bar-border:#101012;
--bar-shadow:inset 0 1px 0 rgba(255,255,255,.28),inset 0 -1px 0 rgba(0,0,0,.4),0 1px 5px rgba(0,0,0,.28);
--logo-ink:#ffffff;--logo-shadow:0 -1px 0 rgba(0,0,0,.55);--nav-ink:#d9d9de;
--surface:#fff;--surface-border:#d2d2d6;--surface-shadow:0 1px 2px rgba(0,0,0,.05);--radius:8px;
--row-sep:#e6e6e8;--row-hover:#f2f7ff;
--slot-bg:linear-gradient(#232325,#313133);--slot-border:#0d0d0f;
--slot-shadow:inset 0 2px 5px rgba(0,0,0,.65),inset 0 -1px 0 rgba(255,255,255,.16),0 1px 0 rgba(255,255,255,.14);
--slot-ring:0 0 0 3px rgba(70,150,255,.5),inset 0 2px 5px rgba(0,0,0,.6);--slot-ink:#f5f5f7;--ph:#8e8e96;
--btn-bg:linear-gradient(#74bcff,#2f8bf6 48%,#1171e8 52%,#0a63d8);--btn-border:#0a4da6;--btn-ink:#fff;
--btn-shadow:inset 0 1px 0 rgba(255,255,255,.65),inset 0 -10px 16px rgba(255,255,255,.16),0 1px 3px rgba(0,0,0,.28);
--btn-tshadow:0 -1px 0 rgba(0,30,80,.45);--btn-hover:linear-gradient(#85c6ff,#43a0ff 48%,#2280f2 52%,#1070e2);--btn-active:linear-gradient(#4aa3f5,#1c78e8 48%,#0d63cc 52%,#0a56b4);
--abtn-bg:linear-gradient(#6a6a6e,#434347 50%,#35353a 50%,#2c2c30);--abtn-border:#1c1c1f;--abtn-ink:#fff;--abtn-hover:linear-gradient(#78787e,#4e4e53 50%,#404046 50%,#36363b);--abtn-tshadow:0 -1px 0 rgba(0,0,0,.5);--abtn-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 1px 2px rgba(0,0,0,.25);
--chip-bg:linear-gradient(#ffffff,#ededf0);--chip-border:#9d9da3;--chip-shadow:0 1px 1px rgba(0,0,0,.10),inset 0 1px 0 #fff;--chip-ink:#26262a;
--tag-bg:#f2f2f4;--tag-border:#d4d4d8;--tag-ink:#6e6e73;
--sel-bg:linear-gradient(#ffffff,#ececf0);
--field-bg:#fff;--field-border:#b9b9be;--field-shadow:inset 0 1px 3px rgba(0,0,0,.10);
--th-bg:linear-gradient(#fafafb,#efeff1);
--cur-bg:linear-gradient(#6c6c72,#434348);--cur-ink:#fff;--cur-border:#333338;
--ac-bg:#fff;--ac-hover:#eef4ff;
--notice-bg:#eef4fb;--notice-border:#c3d6ee;--notice-ink:#274a77;
--err-bg:#fdecea;--err-border:#e0b3ad;--err-ink:#7a1d16;
--spark-bg:linear-gradient(#7ee2a0,#28b445);
--foot-border:#d2d2d6;
--seg-track:linear-gradient(#17171a,#222224);--seg-border:#0a0a0c;--seg-shadow:inset 0 2px 4px rgba(0,0,0,.6),inset 0 -1px 0 rgba(255,255,255,.12);
--seg-on-bg:linear-gradient(#6a6a6e,#4a4a4e);--seg-on-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 1px 2px rgba(0,0,0,.4);--seg-ink:#a9a9ae;--seg-on-ink:#fff;--seg-radius:980px}
html[data-theme="flat"]{color-scheme:dark;
--bg:#070708;--bgimg:radial-gradient(1200px 520px at 50% -80px,rgba(255,255,255,.055),transparent 60%);
--ink:#f4f4f6;--mut:#a2a2aa;--faint:#62626a;--link:#fff;
--bar-bg:rgba(8,8,10,.88);--bar-border:rgba(255,255,255,.16);--bar-shadow:none;--logo-ink:#f4f4f6;--logo-shadow:none;--nav-ink:#d8d8de;--slot-ink:#f4f4f6;
--surface:#0b0b0d;--surface-border:rgba(255,255,255,.14);--surface-shadow:none;--radius:3px;
--row-sep:rgba(255,255,255,.09);--row-hover:rgba(255,255,255,.045);
--slot-bg:transparent;--slot-border:rgba(255,255,255,.30);--slot-shadow:none;--slot-ring:0 0 0 1px rgba(255,255,255,.8);--ph:#5f5f66;
--btn-bg:#f4f4f6;--btn-border:#f4f4f6;--btn-ink:#000;--btn-shadow:none;--btn-tshadow:none;--btn-hover:#ffffff;--btn-active:#d8d8de;
--abtn-bg:#2e2e34;--abtn-border:rgba(255,255,255,.28);--abtn-ink:#f4f4f6;--abtn-hover:#3a3a41;--abtn-tshadow:none;--abtn-shadow:none;
--chip-bg:transparent;--chip-border:rgba(255,255,255,.25);--chip-shadow:none;--chip-ink:#e8e8ec;
--tag-bg:transparent;--tag-border:rgba(255,255,255,.22);--tag-ink:#a2a2aa;
--sel-bg:#0b0b0d;--field-bg:#0b0b0d;--field-border:rgba(255,255,255,.25);--field-shadow:none;
--th-bg:rgba(255,255,255,.05);
--cur-bg:#f4f4f6;--cur-ink:#000;--cur-border:#f4f4f6;
--ac-bg:#101013;--ac-hover:rgba(255,255,255,.07);
--notice-bg:rgba(255,255,255,.04);--notice-border:rgba(255,255,255,.2);--notice-ink:#d8d8de;
--err-bg:rgba(255,60,50,.08);--err-border:rgba(255,90,80,.4);--err-ink:#ff9d94;
--spark-bg:#e8e8ec;--foot-border:rgba(255,255,255,.14);
--seg-track:transparent;--seg-border:rgba(255,255,255,.32);--seg-shadow:none;--seg-on-bg:#f4f4f6;--seg-on-shadow:none;--seg-ink:#a2a2aa;--seg-on-ink:#000;--seg-radius:2px}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","Helvetica Neue","PingFang SC","Hiragino Sans GB","Microsoft YaHei",Arial,sans-serif;background-color:var(--bg);background-image:var(--bgimg);background-attachment:fixed;color:var(--ink);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
body{display:flex;flex-direction:column;min-height:100vh}
main{flex:1 0 auto;width:100%}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:980px;margin:0 auto;padding:0 22px}
header.top{background:var(--bar-bg);border-bottom:1px solid var(--bar-border);box-shadow:var(--bar-shadow);-webkit-backdrop-filter:saturate(160%) blur(14px);backdrop-filter:saturate(160%) blur(14px);position:sticky;top:0;z-index:20}
.top-in{display:flex;align-items:center;gap:18px;height:52px}
.logo{font-weight:700;font-size:17px;letter-spacing:-.01em;color:var(--logo-ink);white-space:nowrap;text-shadow:var(--logo-shadow)}
.logo:hover{text-decoration:none}
.top nav{display:flex;gap:20px;font-size:12.5px;white-space:nowrap;margin-left:auto}
.top nav a{color:var(--nav-ink);opacity:.85}
.top nav a:hover{opacity:1;text-decoration:none}
.seg{display:flex;flex:none;background:var(--seg-track);border:1px solid var(--seg-border);border-radius:var(--seg-radius);box-shadow:var(--seg-shadow);padding:2px;gap:2px}
.seg button{border:0;background:transparent;color:var(--seg-ink);font-size:12px;line-height:1;padding:5px 11px;border-radius:var(--seg-radius);cursor:pointer;font-family:inherit}
html[data-theme="jobs"] .seg [data-th="jobs"],html[data-theme="flat"] .seg [data-th="flat"]{background:var(--seg-on-bg);color:var(--seg-on-ink);box-shadow:var(--seg-on-shadow);font-weight:600}
.hero{padding:72px 0 4px;text-align:center}
.hero h1{font-size:54px;line-height:1.08;font-weight:700;letter-spacing:-.018em;margin:0}
html[data-theme="flat"] .hero h1{font-weight:200;letter-spacing:.14em;text-shadow:none}
.hero p{font-size:18px;color:var(--mut);margin:14px 0 8px;font-weight:400}
.stats-line{text-align:center;color:var(--mut);font-size:13px;margin:20px 0 2px}
.stats-line b{color:var(--ink);font-weight:700}
.chips{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin:14px 0 2px}
.chip{border:1px solid var(--chip-border);background:var(--chip-bg);box-shadow:var(--chip-shadow);border-radius:980px;padding:6px 14px;font-size:13px;color:var(--chip-ink)}
.chip:hover{text-decoration:none;filter:brightness(1.03)}
html[data-theme="flat"] .chip:hover{border-color:rgba(255,255,255,.55)}
section{margin:26px 0}
h2.sec{font-size:21px;font-weight:700;letter-spacing:-.01em;margin:38px 0 14px}
html[data-theme="flat"] h2.sec{font-weight:300;letter-spacing:.22em;font-size:15px}
h1.ptitle{font-size:32px;font-weight:700;letter-spacing:-.015em;margin:34px 0 16px}
html[data-theme="flat"] h1.ptitle{font-weight:300;letter-spacing:.04em}
.card{background:var(--surface);border:1px solid var(--surface-border);border-radius:var(--radius);box-shadow:var(--surface-shadow);padding:22px 24px;margin:0 0 10px}
.list{background:var(--surface);border:1px solid var(--surface-border);border-radius:var(--radius);box-shadow:var(--surface-shadow);overflow:hidden}
.row2{display:block;padding:14px 20px;border-bottom:1px solid var(--row-sep);color:var(--ink)}
.row2:last-child{border-bottom:0}
.row2:hover{background:var(--row-hover);text-decoration:none}
.r1{display:flex;gap:9px;align-items:center}
.r1 .nm{flex:1;min-width:0;font-weight:600;font-size:15px;color:var(--ink);word-break:break-all}
.r1 .nm:hover{color:var(--link);text-decoration:none}
.r2{display:flex;gap:12px;flex-wrap:wrap;color:var(--mut);font-size:12.5px;margin-top:4px;align-items:center;font-variant-numeric:tabular-nums}
.tag{display:inline-block;border:1px solid var(--tag-border);border-radius:6px;padding:1px 7px;font-size:11px;color:var(--tag-ink);background:var(--tag-bg)}
html[data-theme="flat"] .tag{border-radius:2px}
.tag.hdr{color:#8a6d00;background:rgba(255,204,0,.16);border-color:rgba(217,164,0,.4)}
html[data-theme="flat"] .tag.hdr{color:#e8c34a;background:rgba(255,204,0,.08)}
.hdot{display:inline-block;width:9px;height:9px;border-radius:50%;flex:none}
.h-alive{background:radial-gradient(circle at 35% 30%,#b6f4c6,#2fbf4f 60%,#1d9e40);border:1px solid rgba(0,60,20,.35);box-shadow:inset 0 -2px 3px rgba(0,0,0,.18),0 1px 1px rgba(0,0,0,.15)}
.h-weak{background:radial-gradient(circle at 35% 30%,#ffedb0,#f5c81e 60%,#d9a400);border:1px solid rgba(90,70,0,.35);box-shadow:inset 0 -2px 3px rgba(0,0,0,.18),0 1px 1px rgba(0,0,0,.15)}
.h-dead{background:radial-gradient(circle at 35% 30%,#ececf0,#a9a9b0 60%,#83838a);border:1px solid rgba(0,0,0,.25);box-shadow:inset 0 -2px 3px rgba(0,0,0,.15),0 1px 1px rgba(0,0,0,.12)}
.h-unknown{background:radial-gradient(circle at 35% 30%,#f4f4f6,#cfcfd4 60%,#aeaeb4);border:1px solid rgba(0,0,0,.18)}
html[data-theme="flat"] .hdot{border-radius:0;border:0;box-shadow:none}
html[data-theme="flat"] .h-alive{background:#3fae6a}html[data-theme="flat"] .h-weak{background:#d9b64a}html[data-theme="flat"] .h-dead{background:#4a4a52}html[data-theme="flat"] .h-unknown{background:#2c2c31}
.hbadge{font-size:11px;border-radius:980px;padding:1px 8px;border:1px solid}
html[data-theme="flat"] .hbadge{border-radius:2px;background:transparent!important}
.hb-alive{color:#14632e;border-color:#7cc48f}
.hb-weak{color:#6e5700;border-color:#d3ba55}
.hb-dead{color:#55555a;border-color:#b9b9be}
.hb-unknown{color:#6e6e73;border-color:#c2c2c8}
html[data-theme="flat"] .hb-alive{color:#3fae6a;border-color:rgba(63,174,106,.55)}
html[data-theme="flat"] .hb-weak{color:#d9b64a;border-color:rgba(217,182,74,.55)}
html[data-theme="flat"] .hb-dead{color:#8a8a92;border-color:rgba(255,255,255,.25)}
html[data-theme="flat"] .hb-unknown{color:#62626a;border-color:rgba(255,255,255,.18)}
.mag{flex:none;border:1px solid var(--chip-border);background:var(--chip-bg);color:var(--chip-ink);box-shadow:var(--chip-shadow);border-radius:980px;padding:5px 13px;font-size:12.5px;cursor:pointer}
.mag:hover{filter:brightness(1.04)}
html[data-theme="flat"] .mag{border-radius:2px}
.filters{background:var(--surface);border:1px solid var(--surface-border);border-radius:var(--radius);box-shadow:var(--surface-shadow);padding:16px 20px;margin:22px 0 12px}
.filters form{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.filters select{height:36px;padding:0 10px;border:1px solid var(--field-border);border-radius:8px;font-size:14px;background:var(--sel-bg);color:var(--ink);box-shadow:var(--chip-shadow)}
html[data-theme="flat"] .filters select{border-radius:2px}
.filters button{height:36px;padding:0 18px;border:1px solid var(--btn-border);background:var(--btn-bg);color:var(--btn-ink);text-shadow:var(--btn-tshadow);box-shadow:var(--btn-shadow);border-radius:980px;font-size:14px;cursor:pointer}
.filters button:hover{background:var(--btn-hover)}
html[data-theme="flat"] .filters button{border-radius:2px}
.filters .mut{margin-top:10px}
.result-head{color:var(--mut);font-size:14px;margin:14px 2px 10px}
.result-head b{color:var(--ink)}
.tblwrap{background:var(--surface);border:1px solid var(--surface-border);border-radius:var(--radius);box-shadow:var(--surface-shadow);overflow-x:auto}
table.versions{width:100%;border-collapse:collapse;font-size:13.5px}
table.versions th,table.versions td{border-bottom:1px solid var(--row-sep);padding:10px 14px;text-align:left;vertical-align:top}
table.versions tr:last-child td{border-bottom:0}
table.versions th{background:var(--th-bg);color:var(--mut);font-weight:600;font-size:12px;white-space:nowrap}
tr.rec td{background:rgba(10,86,196,.05)}
html[data-theme="flat"] tr.rec td{background:rgba(255,255,255,.05)}
.kv{display:grid;grid-template-columns:104px 1fr;gap:7px 16px;font-size:14px}
.kv dt{color:var(--mut)}.kv dd{margin:0;word-break:break-all}
textarea.magnet{width:100%;min-height:64px;font-family:ui-monospace,SF Mono,Menlo,Consolas,monospace;font-size:12px;border:1px solid var(--field-border);border-radius:8px;padding:10px 12px;background:var(--field-bg);color:var(--ink);box-shadow:var(--field-shadow)}
html[data-theme="flat"] textarea.magnet{border-radius:2px}
.bigmag{display:inline-block;background:var(--btn-bg);color:var(--btn-ink);text-shadow:var(--btn-tshadow);padding:12px 28px;border-radius:980px;font-size:15px;border:1px solid var(--btn-border);box-shadow:var(--btn-shadow);cursor:pointer}
.bigmag:hover{background:var(--btn-hover);text-decoration:none}
html[data-theme="flat"] .bigmag{border-radius:2px}
.f-inp{width:100%;height:40px;border:1px solid var(--field-border);border-radius:8px;padding:0 12px;font-size:14px;background:var(--field-bg);color:var(--ink);box-shadow:var(--field-shadow)}
html[data-theme="flat"] .f-inp{border-radius:2px}
.pager{display:flex;gap:8px;justify-content:center;margin:22px 0;align-items:center}
.pager a,.pager span{border:1px solid var(--chip-border);background:var(--chip-bg);box-shadow:var(--chip-shadow);border-radius:980px;padding:6px 15px;font-size:13.5px;color:var(--chip-ink)}
html[data-theme="flat"] .pager a,html[data-theme="flat"] .pager span{border-radius:2px}
.pager span.cur{background:var(--cur-bg);border-color:var(--cur-border);color:var(--cur-ink)}
.pager a:hover{text-decoration:none;filter:brightness(1.04)}
footer{border-top:1px solid var(--foot-border);color:var(--mut);font-size:12px;line-height:1.6;padding:18px 0 30px;margin-top:44px}
footer a{color:var(--ink);opacity:.75;margin-right:14px}
.chipbtn{border:1px solid var(--chip-border);background:var(--chip-bg);box-shadow:var(--chip-shadow);border-radius:980px;padding:3px 12px;font-size:12px;color:var(--chip-ink);cursor:pointer}
html[data-theme="flat"] .chipbtn{border-radius:2px}
.ac{position:absolute;left:0;top:calc(100% + 8px);width:100%;background:var(--ac-bg);border:1px solid var(--surface-border);border-radius:12px;box-shadow:0 14px 34px rgba(0,0,0,.22);z-index:50;padding:6px;overflow:hidden}
html[data-theme="flat"] .ac{border-radius:3px;box-shadow:none}
.ac div{padding:8px 10px;cursor:pointer;border-radius:7px;border:0;font-size:14px;color:var(--ink)}
.ac div:hover,.ac div.on{background:var(--ac-hover)}
.ac .sub{color:var(--faint);font-size:12px}
.notice{background:var(--notice-bg);border:1px solid var(--notice-border);color:var(--notice-ink);border-radius:10px;padding:12px 16px;font-size:13.5px;margin:14px 0}
html[data-theme="flat"] .notice{border-radius:3px}
.err{background:var(--err-bg);border:1px solid var(--err-border);border-radius:10px;padding:14px 16px;margin:16px 0;color:var(--err-ink)}
html[data-theme="flat"] .err{border-radius:3px}
.mut{color:var(--faint);font-size:12.5px}
.mut a{color:var(--link)}
.spark{display:flex;gap:2px;align-items:flex-end;height:28px}.spark i{flex:1;background:var(--spark-bg);min-height:2px;border-radius:1px}
.toggle{font-size:12px;color:var(--mut)}
@media (max-width:734px){
 .top nav{display:none}
 .top-in{gap:10px}
 .logo{font-size:15px}
 .seg button{padding:5px 8px;font-size:11.5px}
 .hero{padding:48px 0 2px}
 .hero h1{font-size:34px}
 html[data-theme="flat"] .hero h1{letter-spacing:.08em}
 .hero p{font-size:16px;margin:10px 0 6px}
 h1.ptitle{font-size:26px;margin:26px 0 12px}
 h2.sec{font-size:19px;margin:30px 0 12px}
 html[data-theme="flat"] h2.sec{font-size:13.5px}
 .card{padding:18px 16px}
 .row2{padding:12px 16px}
 .kv{grid-template-columns:82px 1fr}
 table.versions{font-size:12.5px}
 .wrap{padding:0 14px}
}
.tblwrap .mut{display:block;padding:14px 20px}
/* 居中搜索 (2026-10-27: 搜索框撤出抬头栏回页面中央; 首页大号, 内页同组件) */
.search-hero{display:flex;max-width:640px;margin:24px auto 4px;border:1px solid var(--field-border);background:var(--field-bg);box-shadow:var(--field-shadow);position:relative}
.search-hero input[type=search]{flex:1;min-width:0;border:0;background:transparent;outline:0;font-size:16px;color:var(--ink);height:42px;padding:0 16px}
.search-hero input::placeholder{color:var(--ph)}
.search-hero button{flex:none;border:0;border-left:1px solid var(--abtn-border);background:var(--abtn-bg);color:var(--abtn-ink);text-shadow:var(--abtn-tshadow);font-size:15px;padding:0 26px;cursor:pointer;font-family:inherit}
.search-hero button:hover{background:var(--abtn-hover)}
.search-hero.big input[type=search]{height:42px;font-size:16px}
/* 收藏按钮 */
.favbtn{flex:none;border:1px solid var(--chip-border);background:var(--chip-bg);color:var(--chip-ink);box-shadow:var(--chip-shadow);padding:5px 11px;font-size:12.5px;cursor:pointer;font-family:inherit;text-decoration:none}
.favbtn.on{color:#a87b00;border-color:#a87b00;font-weight:700}
html[data-theme="flat"] .favbtn.on{color:#e8c34a;border-color:#e8c34a}
/* 账号 */
.acct-btns{display:flex;gap:8px;align-items:center;flex:none}
.acct-btn{font-size:12.5px;font-weight:600;padding:6px 13px;white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis;border:1px solid var(--chip-border);background:var(--chip-bg);color:var(--chip-ink);box-shadow:var(--chip-shadow)}
.acct-btn:hover{text-decoration:none;filter:brightness(1.04)}
.acct-btn.primary{border-color:var(--btn-border);background:var(--btn-bg);color:var(--btn-ink);text-shadow:var(--btn-tshadow);box-shadow:var(--btn-shadow)}
.acct-btn.primary:hover{background:var(--btn-hover)}
@media (max-width:734px){.acct-btn{padding:6px 9px;font-size:12px}}
.auth-card{max-width:420px;margin:30px auto}
.auth-card .f-inp{margin:0 0 12px}
.auth-card label{display:block;font-size:13px;color:var(--mut);margin:0 0 5px}
.auth-btn{width:100%;height:42px;border:1px solid var(--abtn-border);background:var(--abtn-bg);color:var(--abtn-ink);text-shadow:var(--abtn-tshadow);box-shadow:var(--abtn-shadow);font-size:15px;cursor:pointer;font-family:inherit}
.auth-btn:hover{background:var(--abtn-hover)}
/* 全站矩形 (2026-10-27 用户定: 控件与视觉一律不用圆角) */
*,*::before,*::after{border-radius:0!important}
/* 分页头: 与首页同一布局语言 — 标题居中, 搜索在其下, 静态不重叠 (2026-10-27 晚定, 撤固定头) */
.page-head{text-align:center;padding:12px 0 2px}
.page-head .ptitle{margin:0}
/* 分类页 热门/最新 段控 (与顶栏外观段控同一套变量, 风格统一) */
.tabs-wrap{text-align:center;margin:18px 0 2px}
.tabs{display:inline-flex;background:var(--seg-track);border:1px solid var(--seg-border);box-shadow:var(--seg-shadow);padding:2px;gap:2px}
.tabs a{padding:6px 20px;font-size:13px;line-height:1.25;color:var(--seg-ink)}
.tabs a:hover{text-decoration:none}
.tabs a.on{background:var(--seg-on-bg);color:var(--seg-on-ink);box-shadow:var(--seg-on-shadow);font-weight:600}
/* 登录/注册: 卡片在主区正中 */
.center-main{display:flex;align-items:center;justify-content:center}
.center-main .auth-card{margin:0;width:100%}
/* 细节 (Rams: 少但是更好; Jobs: 设计是它如何运作) */
::selection{background:rgba(0,102,204,.16)}
:focus-visible{outline:2px solid var(--link);outline-offset:1px}
*{-webkit-tap-highlight-color:transparent}
`;

const CLIENT_JS = `
function bindAutocomplete(input){
  if(!input) return;
  var box=document.createElement('div'); box.className='ac'; box.style.display='none';
  input.parentElement.style.position='relative'; input.parentElement.appendChild(box);
  var timer=null, items=[], idx=-1;
  function hide(){box.style.display='none'; idx=-1;}
  input.addEventListener('input',function(){
    clearTimeout(timer);
    var q=input.value.trim();
    if(q.length<2){hide();return;}
    timer=setTimeout(function(){
      fetch('/api/autocomplete?q='+encodeURIComponent(q)).then(function(r){return r.json();}).then(function(d){
        items=[];
        var html='';
        (d.titles||[]).forEach(function(t){ items.push('/title/'+t.id); html+='<div data-i="'+(items.length-1)+'"><b>'+escapeHtml(t.title)+'</b> <span class="sub">'+(t.year||'')+' · '+t.torrent_count+' 个版本</span></div>'; });
        (d.torrents||[]).forEach(function(t){ items.push('/torrent/'+t.infohash); html+='<div data-i="'+(items.length-1)+'">'+escapeHtml(t.name)+' <span class="sub">做种 '+(t.seeders==null?'未知':t.seeders)+'</span></div>'; });
        box.innerHTML=html; box.style.display=items.length?'block':'none';
        Array.prototype.forEach.call(box.children,function(el){ el.addEventListener('click',function(){ location.href=items[+el.dataset.i]; }); });
      }).catch(function(){hide();});
    },150);
  });
  input.addEventListener('keydown',function(e){
    if(box.style.display==='none')return;
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){ e.preventDefault(); idx=e.key==='ArrowDown'?Math.min(idx+1,items.length-1):Math.max(idx-1,0);
      Array.prototype.forEach.call(box.children,function(el,i){ el.className=i===idx?'on':''; }); }
    else if(e.key==='Enter'&&idx>=0){ e.preventDefault(); location.href=items[idx]; }
    else if(e.key==='Escape'){ hide(); }
  });
  document.addEventListener('click',function(e){ if(!box.contains(e.target)&&e.target!==input) hide(); });
}
function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
document.querySelectorAll('input[data-ac]').forEach(bindAutocomplete);
document.querySelectorAll('[data-copy]').forEach(function(btn){
  btn.addEventListener('click',function(e){
    e.preventDefault(); e.stopPropagation();
    var text=btn.getAttribute('data-copy');
    function done(){ var old=btn.textContent; btn.textContent='已复制'; setTimeout(function(){btn.textContent=old;},1500); }
    if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(text).then(done).catch(function(){fallback();}); } else fallback();
    function fallback(){ var ta=document.createElement('textarea'); ta.value=text; document.body.appendChild(ta); ta.select(); try{document.execCommand('copy');done();}catch(_){} ta.remove(); }
  });
});
document.querySelectorAll('.seg [data-th]').forEach(function(b){
  b.addEventListener('click',function(){
    var t=b.getAttribute('data-th');
    document.documentElement.setAttribute('data-theme',t);
    document.cookie='theme='+t+'; path=/; max-age=31536000';
  });
});
var at=document.getElementById('adult-toggle');
if(at){ at.addEventListener('click',function(){
  var on=/(?:^|;\\s*)adult=1(?:;|$)/.test(document.cookie);
  if(on){ document.cookie='adult=; path=/; max-age=0'; location.reload(); }
  else if(confirm('成人分类包含成人内容。确认你已年满 18 周岁并主动开启?')){
    document.cookie='adult=1; path=/; max-age=2592000'; location.reload();
  }
});}
// 账号入口: td_user 仅供显示, 登录态以 HttpOnly 的 td_session 为准
var acct=document.getElementById('acct-btns');
var mu=document.cookie.match(/(?:^|;\\s*)td_user=([^;]*)/);
if(acct&&mu){ acct.innerHTML=''; var aa=document.createElement('a'); aa.className='acct-btn'; aa.href='/account'; aa.textContent=decodeURIComponent(mu[1]); acct.appendChild(aa); }
// 收藏: 状态由 /api/favorites/ids 回填; 未登录点击跳登录页
var favBtns=document.querySelectorAll('[data-fav]');
if(favBtns.length){
  if(mu){ fetch('/api/favorites/ids').then(function(r){return r.ok?r.json():null;}).then(function(d){
    if(d&&d.ids){ favBtns.forEach(function(b){ var on=d.ids.indexOf(b.getAttribute('data-fav'))>=0;
      b.classList.toggle('on',on); b.textContent=on?'★ 已收藏':'☆ 收藏'; }); }
  }).catch(function(){}); }
  favBtns.forEach(function(b){ b.addEventListener('click',function(e){
    e.preventDefault(); e.stopPropagation();
    if(!mu){ location.href='/login?next='+encodeURIComponent(location.pathname+location.search); return; }
    fetch('/api/favorites/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({infohash:b.getAttribute('data-fav')})})
      .then(function(r){ if(r.status===401){ location.href='/login?next='+encodeURIComponent(location.pathname+location.search); return null; } return r.json(); })
      .then(function(d){ if(!d) return; var on=!!d.fav; b.classList.toggle('on',on); b.textContent=on?'★ 已收藏':'☆ 收藏'; })
      .catch(function(){});
  }); });
}
`;

// 全站统一头部区块 (2026-10-27 用户定: 除登录/注册外每页完全一样, 位置一致):
// 站名大标题 + 标语 + 中央大搜索 + 统计行, 由 layout 统一渲染, 页面不得自备。
function heroHtml(stats, q) {
  const updated = stats && stats.updated_at ? fmtTime(stats.updated_at).slice(11, 16) : "--:--";
  return `<div class="hero"><h1>TorrDex</h1>
<p>搜得到 · 判得准 · 拿得走 —— 全部数字为实测真数</p>
</div>
${searchHeroHtml(q || "", true)}${stats ? `
<div class="stats-line">已索引 <b>${esc(fmtNum(stats.torrents))}</b> 条种子 · <b>${esc(fmtNum(stats.titles))}</b> 部作品 · 其中存活 ${esc(fmtNum(stats.alive))} 条 · 更新于 ${esc(updated)}</div>` : ""}`;
}

// 居中搜索组件 (2026-10-27: 搜索框只放页面中央, 不进抬头栏)
function searchHeroHtml(q, big) {
  return `<form class="search-hero${big ? " big" : ""}" action="/search" method="get" role="search">` +
    `<input type="search" name="q" data-ac placeholder="搜索片名 / 番号 / IMDb ID / infohash" value="${esc(q || "")}" autocomplete="off" aria-label="搜索"${big ? " autofocus" : ""}>` +
    `<button type="submit">搜索</button></form>`;
}

function layout({ title, body, adultOn, q, home, ptitle, nosearch, center, stats }) {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="jobs"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><script>(function(){try{var m=document.cookie.match(/(?:^|;\s*)theme=(flat|jobs)/);document.documentElement.setAttribute('data-theme',m?m[1]:'jobs');}catch(e){}})();</script><style>${CSS}</style></head>
<body>
<header class="top"><div class="wrap top-in">
<a class="logo" href="/">TorrDex</a>
<nav><a href="/top">Top20</a><a href="/latest">最新收录</a><a href="/browse/movie">电影</a><a href="/browse/tv">剧集</a><a href="/browse/anime">动漫</a><a href="/browse/software">软件</a></nav>
<span class="acct-btns" id="acct-btns"><a class="acct-btn" href="/login">登录</a><a class="acct-btn primary" href="/register">注册</a></span>
<div class="seg" role="group" aria-label="外观"><button type="button" data-th="jobs">浅色</button><button type="button" data-th="flat">深色</button></div>
</div></header>
<main class="wrap${center ? " center-main" : ""}">${nosearch ? "" : heroHtml(stats, q)}${!nosearch && ptitle ? `<div class="page-head"><h1 class="ptitle">${esc(ptitle)}</h1></div>` : ""}${body}</main>
<footer><div class="wrap">
<a href="/about">数据口径</a><a href="/takedown">权利投诉</a>
<button id="adult-toggle" class="chipbtn" type="button">成人分类：${adultOn ? "开" : "关"}</button>
<div style="margin-top:8px">本站只索引公开网络中的种子元数据，不托管任何文件本体。做种/下载数为实测快照并标注抓取时间，无数据时显示「未知」。</div>
</div></footer>
<script>${CLIENT_JS}</script>
</body></html>`;
}
function healthBadge(row) {
  const band = row.health_band || "unknown";
  const label = HEALTH_LABEL[band] || "未知";
  const score = row.health_score == null ? "" : ` ${row.health_score}`;
  return `<span class="hbadge hb-${esc(band)}" title="健康分（抓取于 ${esc(fmtTime(row.scraped_at))}）">${label}${score}</span>`;
}

function specTags(t) {
  const tags = [];
  if (t.resolution) tags.push(`<span class="tag">${esc(t.resolution)}</span>`);
  if (t.source_type) tags.push(`<span class="tag">${esc(t.source_type)}</span>`);
  if (t.video_codec) tags.push(`<span class="tag">${esc(t.video_codec)}</span>`);
  if (t.is_hdr) tags.push(`<span class="tag hdr">HDR</span>`);
  if (t.is_dolby_vision) tags.push(`<span class="tag hdr">Dolby Vision</span>`);
  if (t.edition) tags.push(`<span class="tag">${esc(t.edition)}</span>`);
  const subs = t.subtitles || [];
  if (subs.includes("chs")) tags.push(`<span class="tag">中字</span>`);
  if (subs.includes("cht")) tags.push(`<span class="tag">繁中</span>`);
  if (subs.includes("chs+eng")) tags.push(`<span class="tag">中英双字</span>`);
  return tags.join(" ");
}

// 种子行 (移动端两行卡 / 桌面同结构): 第一行 标题+磁力, 第二行 规格/大小/做种 — §9
function torrentRow(t, cats) {
  const catName = catById(cats, t.category_id)?.name_zh || "";
  return `<div class="row2">
  <div class="r1"><span class="hdot h-${esc(t.health_band || "unknown")}"></span>
  <a class="nm" href="/torrent/${esc(t.infohash)}">${esc(t.name_clean || t.name)}</a>
  <button class="mag" data-copy="${esc(t.magnet)}" title="复制磁力链接">磁力</button><button class="favbtn" data-fav="${esc(t.infohash)}" type="button">☆ 收藏</button></div>
  <div class="r2">${specTags(t)}
  <span>${esc(fmtSize(t.total_size))}</span><span>${t.file_count} 个文件</span>
  <span>做种 ${t.seeders == null ? "未知" : esc(fmtNum(t.seeders))} / 下载 ${t.leechers == null ? "未知" : esc(fmtNum(t.leechers))}</span>
  ${healthBadge(t)}
  <span>${esc(fmtAge(t.first_seen_at))}收录</span>${catName ? `<span>${esc(catName)}</span>` : ""}
  ${t.group_name ? `<span class="tag">${esc(t.group_name)}${t.group_verified ? " ✓认证" : ""}</span>` : ""}
  </div></div>`;
}

function pageHome(home, cats, adultOn) {
  const s = home.stats;
  const chips = home.trending.terms.map((t) =>
    `<a class="chip" href="/search?q=${encodeURIComponent(t.term)}${adultOn ? "&adult=1" : ""}">${esc(t.term)}</a>`).join("");
  const catCards = Object.entries(s.by_category || {}).map(([code, n]) => {
    const c = cats.find((x) => x.code === code);
    return `<a class="chip" href="/browse/${esc(code)}">${esc(c ? c.name_zh : code)} ${esc(fmtNum(n))}</a>`;
  }).join("");
  const body = `
${home.trending.terms.length ? `<div class="chips">${chips}</div>` : ""}
<section><h2 class="sec">分类</h2><div class="chips" style="justify-content:flex-start">${catCards}</div></section>
<section><h2 class="sec">最新收录</h2>${home.latest.length ? `<div class="list">${home.latest.map((t) => torrentRow(t, cats)).join("")}</div>` : `<div class="mut">暂无数据</div>`}</section>
<section><h2 class="sec">热门种子</h2>${home.top.length ? `<div class="list">${home.top.map((t) => torrentRow(t, cats)).join("")}</div>` : `<div class="mut">暂无数据</div>`}</section>`;
  return layout({ title: "TorrDex — Torrent 全品类搜索", body, adultOn, stats: s });
}
function pageSearch(res, cats, adultOn, rawParams, stats) {
  const p = rawParams;
  const catOpts = [`<option value="">全部分类</option>`].concat(cats
    .filter((c) => adultOn || c.policy !== "adult")
    .map((c) => `<option value="${esc(c.code)}"${p.cat === c.code ? " selected" : ""}>${esc(c.name_zh)}</option>`)).join("");
  const resOpts = ["", "2160p", "1080p", "720p", "480p"].map((r) =>
    `<option value="${r}"${p.resolution === r ? " selected" : ""}>${r || "全部画质"}</option>`).join("");
  const healthOpts = [["", "全部健康"], ["alive", "只看存活"], ["weak", "弱"], ["dead", "死种"], ["unknown", "未知"]]
    .map(([v, l]) => `<option value="${v}"${p.health === v ? " selected" : ""}>${l}</option>`).join("");
  const sortOpts = [["relevance", "相关性"], ["recommended", "推荐"], ["seeders", "做种数"], ["size", "文件大小"], ["newest", "最新收录"]]
    .map(([v, l]) => `<option value="${v}"${(p.sort || "relevance") === v ? " selected" : ""}>${l}</option>`).join("");
  const qs = (over) => {
    const u = new URLSearchParams({ q: res.q, cat: p.cat || "", resolution: p.resolution || "",
      health: p.health || "", sort: p.sort || "relevance", page: String(over.page ?? res.page) });
    if (adultOn) u.set("adult", "1");
    return "/search?" + u.toString();
  };
  const facetLine = (obj, key, label) => {
    const entries = Object.entries(obj || {}).slice(0, 8);
    if (!entries.length) return "";
    return `<div class="mut">${label}：` + entries.map(([k, n]) => {
      const over = { page: 1 };
      if (key === "category") over.cat = k;
      const u = new URLSearchParams({ q: res.q, cat: key === "category" ? k : (p.cat || ""),
        resolution: key === "resolution" ? k : (p.resolution || ""),
        health: key === "health" ? k : (p.health || ""), sort: p.sort || "relevance", page: "1" });
      if (adultOn) u.set("adult", "1");
      return `<a href="/search?${u.toString()}">${esc(k)} (${esc(fmtNum(n))})</a>`;
    }).join(" · ") + `</div>`;
  };
  let inner = "";
  if (res.direct) {
    inner = `<div class="notice">已识别为${res.direct.type === "torrent" ? " infohash" : " IMDb ID"}，正在跳转…<script>location.href=${JSON.stringify(res.direct.type === "torrent" ? "/torrent/" + res.direct.infohash : "/title/" + res.direct.id)}</script></div>`;
  } else if (!res.torrents.length && !res.titles.length) {
    // FR-SRCH-03 零结果三件套 (纠错候选为 P2, 此处给去过滤重试 + 相似入口)
    inner = `<div class="card"><b>没有找到「${esc(res.q)}」的结果。</b>
    <p class="mut">可以试试：去掉筛选条件、缩短关键词、或用作品原名 / 年份搜索。</p>
    <p><a href="/search?q=${encodeURIComponent(res.q)}${adultOn ? "&adult=1" : ""}">去掉全部筛选重试</a> · <a href="/latest">看最新收录</a> · <a href="/top">看热门榜单</a></p></div>`;
  } else {
    const cards = (res.titles || []).map((c) => `
    <div class="card tcard"><div class="r1"><a class="nm" href="/title/${c.id}">${esc(c.title)}${c.year ? ` (${esc(c.year)})` : ""}</a>
    <button class="mag" data-copy="${esc(c.best.magnet)}">磁力</button></div>
    <div class="r2"><span>作品 · 共 ${esc(fmtNum(c.torrent_count))} 个版本（本次命中 ${c.matched_versions}）</span>
    <span>存活 ${esc(fmtNum(c.alive_count))}</span>${healthBadge(c.best)}
    <span>推荐版：${esc(c.best.name_clean)}</span>
    ${c.best_reasons && c.best_reasons.length ? `<span class="tag">${esc(c.best_reasons.join(" · "))}</span>` : ""}</div></div>`).join("");
    inner = cards + (res.torrents.length ? `<div class="list">${res.torrents.map((t) => torrentRow(t, cats)).join("")}</div>` : "");
  }
  const body = `
<div class="filters"><form action="/search" method="get">
<input type="hidden" name="q" value="${esc(res.q)}">
<select name="cat">${catOpts}</select><select name="resolution">${resOpts}</select>
<select name="health">${healthOpts}</select><select name="sort">${sortOpts}</select>
${adultOn ? `<input type="hidden" name="adult" value="1">` : ""}
<button type="submit">应用筛选</button></form>
${facetLine(res.facets.category, "category", "分类")}
${facetLine(res.facets.resolution, "resolution", "画质")}
${facetLine(res.facets.health, "health", "健康")}
</div>
${res.searched_as && res.searched_as !== res.q ? `<div class="notice">已按「${esc(res.searched_as)}」搜索（编号规范化）。<a href="/search?q=${encodeURIComponent(res.q)}&strict=1">改回原词</a></div>` : ""}
<div class="result-head">共 <b>${esc(fmtNum(res.total))}</b> 条（其中存活 ${esc(fmtNum(res.alive))} 条），用时 ${(res.took_ms / 1000).toFixed(2)} 秒</div>
${inner}
<div class="pager">${res.page > 1 ? `<a href="${esc(qs({ page: res.page - 1 }))}">上一页</a>` : ""}
<span class="cur">第 ${res.page} 页</span>
${res.torrents.length >= (res.page_size || 25) ? `<a href="${esc(qs({ page: res.page + 1 }))}">下一页</a>` : ""}</div>`;
  return layout({ title: `${res.q} — 搜索结果`, body, adultOn, q: res.q, stats });
}

function pageTitle(data, cats, adultOn, stats) {
  const t = data.title;
  const ext = (t.external_ids || []).map((e) => {
    const url = e.source === "imdb" ? `https://www.imdb.com/title/${encodeURIComponent(e.external_id)}/` : null;
    return url ? `<a href="${url}" rel="nofollow noopener">${esc(e.source)}: ${esc(e.external_id)}</a>` : `${esc(e.source)}: ${esc(e.external_id)}`;
  }).join(" · ");
  const rowsHtml = data.versions.map((v) => `
  <tr${v.is_recommended ? ` class="rec"` : ""}>
    <td><a href="/torrent/${esc(v.infohash)}">${esc(v.name_clean)}</a>
    ${v.is_recommended ? `<div class="mut">★ 推荐${v.reasons && v.reasons.length ? "：" + esc(v.reasons.join(" · ")) : ""}</div>` : ""}</td>
    <td>${specTags(v)}</td>
    <td>${esc(fmtSize(v.total_size))}</td>
    <td>${v.seeders == null ? "未知" : esc(fmtNum(v.seeders))} / ${v.leechers == null ? "未知" : esc(fmtNum(v.leechers))}</td>
    <td>${healthBadge(v)}</td>
    <td>${v.group_name ? esc(v.group_name) + (v.group_verified ? " ✓" : "") : "—"}</td>
    <td>${esc(fmtAge(v.first_seen_at))}</td>
    <td><button class="mag" data-copy="${esc(v.magnet)}">磁力</button></td></tr>`).join("");
  const body = `
<section><div class="card">
<h1 style="margin:0 0 6px;font-size:28px;font-weight:700;letter-spacing:-.01em">${esc(t.canonical_title)}${t.year ? ` <span class="mut">(${esc(t.year)})</span>` : ""}</h1>
${t.original_title ? `<div class="mut">原名：${esc(t.original_title)}</div>` : ""}
${t.aliases && t.aliases.length ? `<div class="mut">别名：${t.aliases.map(esc).join(" / ")}</div>` : ""}
<dl class="kv" style="margin-top:8px">
<dt>分类</dt><dd>${esc(cats.find((c) => c.code === t.category)?.name_zh || t.category || "")}</dd>
${t.duration_min ? `<dt>时长</dt><dd>${esc(t.duration_min)} 分钟</dd>` : ""}
${t.region ? `<dt>地区</dt><dd>${esc(t.region)}</dd>` : ""}
<dt>版本数</dt><dd>${esc(fmtNum(t.torrent_count))}（存活 ${esc(fmtNum(t.alive_count))}）</dd>
${ext ? `<dt>外部 ID</dt><dd>${ext}</dd>` : ""}
</dl>
${t.synopsis ? `<p style="margin-top:10px">${esc(t.synopsis)}</p>` : ""}
</div></section>
<section><h2 class="sec">版本对比（按推荐分排序）</h2>
<div class="tblwrap"><table class="versions"><thead><tr>
<th>标题</th><th>规格</th><th>大小</th><th>做种/下载</th><th>健康</th><th>发布组</th><th>收录</th><th></th>
</tr></thead><tbody>${rowsHtml || `<tr><td colspan="8" class="mut">暂无存活版本</td></tr>`}</tbody></table></div>
<p class="mut">推荐依据（PRD §7.3）：健康分 ×0.5 + 做种项 ×0.3 + 规格命中（字幕/主流编码/1080p·2160p）×0.2。做种数为实测快照，悬停健康徽章可见抓取时间。</p>
</section>`;
  return layout({ title: `${t.canonical_title} — 作品页`, body, adultOn, stats });
}

function pageTorrent(data, cats, adultOn, stats) {
  const t = data.torrent;
  const filesHtml = data.files.length
    ? `<table class="versions"><thead><tr><th>文件</th><th>大小</th></tr></thead><tbody>` +
      data.files.map((f) => `<tr><td>${esc(f.path)}</td><td>${esc(fmtSize(f.size))}</td></tr>`).join("") + `</tbody></table>`
    : `<p class="mut">该种子的文件清单未上云（冷门种子只存文件数与总大小，见 PRD §16.2）。共 ${t.file_count} 个文件。</p>`;
  const sizeNote = data.size_check.files_present
    ? (data.size_check.consistent
        ? `文件大小之和与声明总大小一致 ✓`
        : `⚠ 文件大小之和（${esc(fmtSize(data.size_check.files_sum))}）与声明总大小（${esc(fmtSize(data.size_check.declared))}）不一致，已按实测标注`)
    : "";
  const spark = data.health_history.length >= 2
    ? `<div class="spark" title="近 ${data.health_history.length} 次抓取做种数">` +
      data.health_history.map((h) => {
        const max = Math.max(...data.health_history.map((x) => x.seeders || 0), 1);
        return `<i style="height:${Math.max(8, Math.round(((h.seeders || 0) / max) * 100))}%"></i>`;
      }).join("") + `</div>`
    : `<span class="mut">暂无抓取历史（云端只存最新快照）</span>`;
  const body = `
<section><div class="card">
<h1 style="margin:0 0 8px;font-size:22px;font-weight:700;letter-spacing:-.01em;word-break:break-all">${esc(t.name)}</h1>
${t.name_raw && t.name_raw !== t.name ? `<div class="mut">原始名：${esc(t.name_raw)}</div>` : ""}
${data.title ? `<div style="margin-top:4px">所属作品：<a href="/title/${data.title.id}">${esc(data.title.canonical_title)}${data.title.year ? ` (${esc(data.title.year)})` : ""}</a></div>` : ""}
<div style="margin:14px 0;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="bigmag" data-copy="${esc(t.magnet)}">复制磁力链接</button><button class="favbtn" data-fav="${esc(t.infohash)}" type="button" style="padding:11px 18px;font-size:14px">☆ 收藏</button></div>
<textarea class="magnet" readonly onclick="this.select()">${esc(t.magnet)}</textarea>
<dl class="kv" style="margin-top:12px">
<dt>infohash</dt><dd><code>${esc(t.infohash)}</code></dd>
<dt>总大小</dt><dd>${esc(fmtSize(t.total_size))}（${t.file_count} 个文件）${sizeNote ? `<div class="mut">${sizeNote}</div>` : ""}</dd>
<dt>规格</dt><dd>${specTags(t) || "—"} ${t.video_codec ? esc(t.video_codec) : ""} ${t.audio_codec ? "/ " + esc(t.audio_codec) : ""}</dd>
<dt>健康</dt><dd>${healthBadge(t)} 做种 ${t.seeders == null ? "未知" : esc(fmtNum(t.seeders))} · 下载 ${t.leechers == null ? "未知" : esc(fmtNum(t.leechers))} · 完成 ${t.completed == null ? "未知" : esc(fmtNum(t.completed))}<div style="margin-top:4px">${spark}</div><div class="mut">最近抓取：${esc(fmtTime(t.scraped_at))}</div></dd>
<dt>收录</dt><dd>首次 ${esc(fmtTime(t.first_seen_at))} · 最近见到 ${esc(fmtTime(t.last_seen_at))}</dd>
${t.pieces ? `<dt>分片</dt><dd>${esc(fmtNum(t.pieces))} 片 × ${esc(fmtSize(t.piece_length))}</dd>` : ""}
<dt>私有种子</dt><dd>${t.is_private ? "是" : "否"}</dd>
${t.group_name ? `<dt>发布组</dt><dd>${esc(t.group_name)}${t.group_verified ? "（已认证）" : ""}</dd>` : ""}
</dl></div></section>
<section><h2 class="sec">文件清单</h2><div class="tblwrap">${filesHtml}</div></section>
<section><h2 class="sec">Tracker（${data.trackers.length} 个种子自带 + 公共列表）</h2>
<div class="card" style="font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all">${data.trackers.map(esc).join("<br>") || '<span class="mut">无自带 tracker，磁力中已附公共 tracker 列表</span>'}</div></section>`;
  return layout({ title: `${t.name} — 种子详情`, body, adultOn, stats });
}

function pageList(listData, cats, adultOn, heading, stats) {
  const body = `<section>
${listData.torrents.length ? `<div class="list">${listData.torrents.map((t) => torrentRow(t, cats)).join("")}</div>` : `<div class="mut">暂无数据</div>`}</section>`;
  return layout({ title: heading, body, adultOn, ptitle: heading, stats });
}

function pageTakedown(adultOn, stats) {
  const body = `<section><div class="card">
<h1 style="font-size:22px;font-weight:700;margin:0 0 10px">权利投诉 / 下架申请</h1>
<p>如你是权利人或其代理人，请填写下表。我们将在收到后核查处理（目标 72 小时内），处理全程留痕（FR-ADM-02）。确认侵权的内容将被隐藏，作品页会显示「部分版本因投诉隐藏」。</p>
<form method="post" action="/api/takedown">
<dl class="kv">
<dt>权利人*</dt><dd><input name="claimant" required class="f-inp"></dd>
<dt>联系方式*</dt><dd><input name="contact" required class="f-inp"></dd>
<dt>作品说明</dt><dd><input name="work_desc" class="f-inp"></dd>
<dt>infohash</dt><dd><input name="infohash" class="f-inp" placeholder="40 位 hex（可选）"></dd>
<dt>页面链接</dt><dd><input name="url" class="f-inp"></dd>
<dt>备注</dt><dd><input name="note" class="f-inp"></dd>
</dl>
<p><button class="bigmag" type="submit">提交投诉</button></p></form>
</div></section>`;
  return layout({ title: "权利投诉", body, adultOn, stats });
}

function pageAbout(adultOn, stats) {
  const body = `<section><div class="card">
<h1 style="font-size:22px;font-weight:700;margin:0 0 10px">数据口径说明</h1>
<dl class="kv">
<dt>做种/下载数</dt><dd>来自 tracker scrape 与 DHT 查询的实测快照，每条种子都标注最近抓取时间；抓不到就显示「未知」，本站从不估算或编造。</dd>
<dt>健康分</dt><dd>0–100 分：做种数（0–50）+ 抓取新鲜度（0–20）+ 完成/下载比（0–15）+ 社区验证（−30~+15）。≥70 为「活」，30–69 为「弱」，其余为「死/未知」。公式版本 health_v=1（PRD §7.4）。</dd>
<dt>热度</dt><dd>近 7 日站内行为衰减值（磁力点击 ×3 + 详情浏览 ×1 + 收藏 ×5，半衰期 3 天），与做种数分开计算、分开展示。</dd>
<dt>索引量</dt><dd>首页数字为库内实时计数（状态为有效的种子），不是宣传数字。</dd>
<dt>隐私</dt><dd>不接第三方统计与广告 SDK；搜索日志只记规范化查询词与结果数，IP 只存加盐哈希且 30 天滚动删除（FR-SRCH-04）。</dd>
<dt>本站性质</dt><dd>只索引公开网络中的种子元数据（名称、大小、infohash），不托管、不分发任何文件本体。</dd>
</dl></div></section>`;
  return layout({ title: "数据口径", body, adultOn, stats });
}

function htmlResp(html, status = 200) {
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}


// ---------------- 账号 (邮箱注册/登录 + 收藏种子 + 搜索历史; 2026-10-27 用户点名新增) ----------------
// users 表已在 data-model 里 (email 唯一, password_hash 存 PBKDF2 格式串);
// sessions / user_favorites(收藏种子, 区别于模型里按作品的 favorites) / user_search_history 按需自建 (幂等)。
const AUTH_DDL = [
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
     expires_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS user_favorites (
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     infohash TEXT NOT NULL REFERENCES torrents(infohash) ON DELETE CASCADE,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
     PRIMARY KEY (user_id, infohash))`,
  `CREATE TABLE IF NOT EXISTS user_search_history (
     id INTEGER PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     query_raw TEXT NOT NULL,
     query_normalized TEXT NOT NULL,
     result_count INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')))`,
  `CREATE INDEX IF NOT EXISTS idx_ush_user ON user_search_history(user_id, id DESC)`,
];
let authReady = false;
async function ensureAuthTables(env) {
  if (authReady) return;
  await turso(env, AUTH_DDL.map((sql) => ({ sql, args: [] })));
  authReady = true;
}

const PBKDF2_ITER = 100000;
function b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function unb64(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: "SHA-256" }, key, 256);
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt)}$${b64(bits)}`;
}
export async function verifyPassword(password, stored) {
  try {
    const [scheme, iter, saltB64, hashB64] = String(stored || "").split("$");
    if (scheme !== "pbkdf2") return false;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: unb64(saltB64), iterations: parseInt(iter, 10) || PBKDF2_ITER, hash: "SHA-256" }, key, 256);
    const got = new Uint8Array(bits), want = unb64(hashB64);
    if (got.length !== want.length) return false;
    let diff = 0;
    for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
    return diff === 0;
  } catch { return false; }
}
async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
async function getUser(env, request) {
  const tok = parseCookies(request).td_session;
  if (!tok) return null;
  await ensureAuthTables(env);
  const rows = await q1(env,
    `SELECT u.id, u.email, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ','now')`, [await sha256hex(tok)]);
  return rows.length ? rows[0] : null;
}
async function createSession(env, userId) {
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const expires = new Date(Date.now() + 30 * 864e5).toISOString().replace(/\.\d+Z$/, "Z");
  await turso(env, [{ sql: "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)",
    args: [await sha256hex(token), userId, expires] }]);
  return token;
}
function sessionCookies(token, email) {
  return [
    `td_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
    `td_user=${encodeURIComponent(email)}; Path=/; Secure; SameSite=Lax; Max-Age=2592000`,
  ];
}
function clearCookies() {
  return ["td_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
          "td_user=; Path=/; Secure; SameSite=Lax; Max-Age=0"];
}
function redirectResp(location, cookies) {
  const h = new Headers({ Location: location });
  for (const c of cookies || []) h.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers: h });
}
function safeNext(next) {
  const n = String(next || "/");
  return n.startsWith("/") && !n.startsWith("//") ? n : "/";
}

function pageAuth(mode, opts, adultOn) {
  const isLogin = mode === "login";
  const { error, next, email } = opts || {};
  const body = `<div class="card auth-card">
<h1 class="ptitle" style="margin:4px 0 16px;font-size:24px">${isLogin ? "登录" : "注册"}</h1>
${error ? `<div class="err" style="margin:0 0 14px">${esc(error)}</div>` : ""}
<form method="post" action="/${isLogin ? "login" : "register"}">
<input type="hidden" name="next" value="${esc(next || "/")}">
<label>邮箱</label><input class="f-inp" type="email" name="email" required autocomplete="email" value="${esc(email || "")}" placeholder="you@example.com">
<label>密码${isLogin ? "" : "（至少 8 位）"}</label><input class="f-inp" type="password" name="password" required autocomplete="${isLogin ? "current-password" : "new-password"}">
${isLogin ? "" : `<label>再输一次密码</label><input class="f-inp" type="password" name="password2" required autocomplete="new-password">`}
<button class="auth-btn" type="submit">${isLogin ? "登录" : "注册并登录"}</button>
</form>
<p class="mut" style="margin-top:14px">${isLogin
  ? `还没有账号？<a href="/register?next=${encodeURIComponent(next || "/")}">注册</a>`
  : `已有账号？<a href="/login?next=${encodeURIComponent(next || "/")}">直接登录</a>`}</p>
</div>`;
  return layout({ title: `${isLogin ? "登录" : "注册"} — TorrDex`, body, adultOn, nosearch: true, center: true });
}

function pageAccount(user, adultOn, stats) {
  const body = `<section>
<div class="card">
<div style="font-size:16px;font-weight:600">${esc(user.email)}</div>
<div class="mut" style="margin-top:4px">注册于 ${esc(fmtTime(user.created_at))}</div>
<div style="margin-top:18px;display:flex;gap:10px;flex-wrap:wrap">
<a class="favbtn" style="padding:8px 16px;font-size:13px" href="/favorites">★ 我的收藏</a>
<a class="favbtn" style="padding:8px 16px;font-size:13px" href="/history">搜索历史</a>
<a class="favbtn" style="padding:8px 16px;font-size:13px" href="/logout">退出登录</a>
</div></div>
<div class="card">
<div style="font-weight:600;margin-bottom:6px">注销账号</div>
<p class="mut">删除账号及其收藏、搜索历史与全部登录会话，不可恢复。</p>
<form method="post" action="/account/delete" onsubmit="return confirm('确定注销账号？此操作不可恢复。')">
<button class="favbtn" type="submit" style="color:#b3261e;border-color:#b3261e">注销账号</button></form>
</div></section>`;
  return layout({ title: "我的账号 — TorrDex", body, adultOn, ptitle: "我的账号", stats });
}

// ---------------- 路由 ----------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const allowed = adultAllowed(request, url);
    let heroStats = null;
    try {
      if (!env.TURSO_URL || !env.TURSO_TOKEN) {
        const msg = { error: "server_not_configured" };
        return path.startsWith("/api/") ? jsonResp(msg, 503)
          : htmlResp(layout({ title: "未配置", body: `<div class="err">服务器尚未配置数据库凭据（TURSO_URL / TURSO_TOKEN）。请按 README 完成部署步骤。</div>`, adultOn: false, nosearch: true }), 503);
      }

      // ---------- API ----------
      if (path === "/api/search") {
        const params = Object.fromEntries(url.searchParams.entries());
        const res = await doSearch(env, params, allowed);
        const cats = await getCategories(env);
        ctx && ctx.waitUntil && logSearch(env, ctx, request, params.q || "", normalizedKey(cleanQuery(params.q || "")),
          res.total || 0, params.cat ? (catByCode(cats, params.cat)?.id ?? null) : null);
        return jsonResp(res);
      }
      if (path === "/api/autocomplete") {
        return jsonResp(await doAutocomplete(env, url.searchParams.get("q") || "", allowed));
      }
      if (path === "/api/stats") {
        return await cachedJson(ctx, request, 300, () => doStats(env, allowed));
      }
      if (path === "/api/home") {
        return await cachedJson(ctx, request, 300, () => doHome(env, allowed));
      }
      if (path === "/api/top") return jsonResp(await doList(env, "top", url.searchParams.get("cat"), allowed));
      if (path === "/api/latest") return jsonResp(await doList(env, "latest", url.searchParams.get("cat"), allowed));
      if (path.startsWith("/api/browse/")) {
        const code = decodeURIComponent(path.slice("/api/browse/".length));
        return jsonResp(await doList(env, "top", code, allowed));
      }
      if (path.startsWith("/api/title/")) {
        const id = parseInt(path.slice("/api/title/".length), 10);
        const data = Number.isFinite(id) ? await doTitle(env, id, allowed) : null;
        return data ? jsonResp(data) : jsonResp({ error: "not_found" }, 404);
      }
      if (path.startsWith("/api/torrent/")) {
        const ih = path.slice("/api/torrent/".length).toLowerCase();
        const data = /^[0-9a-f]{40}$/.test(ih) ? await doTorrent(env, ih, allowed) : null;
        return data ? jsonResp(data) : jsonResp({ error: "not_found" }, 404);
      }
      if (path === "/api/takedown" && request.method === "POST") {
        const form = await request.formData();
        const claimant = String(form.get("claimant") || "").trim();
        const contact = String(form.get("contact") || "").trim();
        if (!claimant || !contact) return jsonResp({ error: "claimant_and_contact_required" }, 400);
        await turso(env, [{
          sql: "INSERT INTO takedown_requests (claimant, contact, work_desc, infohash, url, note) VALUES (?,?,?,?,?,?)",
          args: [claimant.slice(0, 200), contact.slice(0, 200), String(form.get("work_desc") || "").slice(0, 500) || null,
                 String(form.get("infohash") || "").slice(0, 40) || null, String(form.get("url") || "").slice(0, 500) || null,
                 String(form.get("note") || "").slice(0, 1000) || null],
        }]);
        return htmlResp(layout({ title: "已提交", body: `<div class="card"><b>投诉已提交</b><p class="mut">我们会核查处理（目标 72 小时），处理结果将通过你留下的联系方式反馈。</p><p><a href="/">回首页</a></p></div>`, adultOn: allowed, stats: await getStatsCached(env, allowed) }));
      }
      if (path === "/api/favorites/ids") {
        const user = await getUser(env, request);
        if (!user) return jsonResp({ error: "unauthorized" }, 401);
        const rows = await q1(env, "SELECT infohash FROM user_favorites WHERE user_id = ?", [user.id]);
        return jsonResp({ ids: rows.map((r) => r.infohash) });
      }
      if (path === "/api/favorites/toggle" && request.method === "POST") {
        const user = await getUser(env, request);
        if (!user) return jsonResp({ error: "unauthorized" }, 401);
        const payload = await request.json().catch(() => ({}));
        const ih = String(payload.infohash || "").toLowerCase();
        if (!/^[0-9a-f]{40}$/.test(ih)) return jsonResp({ error: "bad_infohash" }, 400);
        const exists = await q1(env, "SELECT 1 AS x FROM user_favorites WHERE user_id = ? AND infohash = ?", [user.id, ih]);
        if (exists.length) {
          await turso(env, [{ sql: "DELETE FROM user_favorites WHERE user_id = ? AND infohash = ?", args: [user.id, ih] }]);
          return jsonResp({ ok: true, fav: false });
        }
        const t = await q1(env, "SELECT infohash FROM torrents WHERE infohash = ?", [ih]);
        if (!t.length) return jsonResp({ error: "not_found" }, 404);
        await turso(env, [{ sql: "INSERT INTO user_favorites (user_id, infohash) VALUES (?,?)", args: [user.id, ih] }]);
        return jsonResp({ ok: true, fav: true });
      }
      if (path.startsWith("/api/")) return jsonResp({ error: "not_found" }, 404);

      // ---------- 页面 ----------
      const cats = await getCategories(env);
      heroStats = await getStatsCached(env, allowed);
      if (path === "/") {
        const home = await doHome(env, allowed);
        return htmlResp(pageHome(home, cats, allowed));
      }
      if (path === "/search") {
        const params = Object.fromEntries(url.searchParams.entries());
        const res = await doSearch(env, params, allowed);
        logSearch(env, ctx, request, params.q || "", normalizedKey(cleanQuery(params.q || "")),
          res.total || 0, params.cat ? (catByCode(cats, params.cat)?.id ?? null) : null);
        const sessUser = await getUser(env, request).catch(() => null);
        if (sessUser && (params.q || "").trim()) {
          const hp = turso(env, [
            { sql: "INSERT INTO user_search_history (user_id, query_raw, query_normalized, result_count) VALUES (?,?,?,?)",
              args: [sessUser.id, String(params.q).slice(0, 200), normalizedKey(cleanQuery(params.q)), res.total || 0] },
            { sql: "DELETE FROM user_search_history WHERE user_id = ? AND id NOT IN (SELECT id FROM user_search_history WHERE user_id = ? ORDER BY id DESC LIMIT 200)",
              args: [sessUser.id, sessUser.id] },
          ]).catch(() => {});
          if (ctx && ctx.waitUntil) ctx.waitUntil(hp);
        }
        return htmlResp(pageSearch(res, cats, allowed, params, heroStats));
      }
      const titleMatch = path.match(/^\/title\/(?:.*-)?(\d+)$/);
      if (titleMatch) {
        const data = await doTitle(env, parseInt(titleMatch[1], 10), allowed);
        return data ? htmlResp(pageTitle(data, cats, allowed, heroStats))
          : htmlResp(layout({ title: "未找到", body: `<div class="err">作品不存在或不可见。</div>`, adultOn: allowed, stats: heroStats }), 404);
      }
      const torMatch = path.match(/^\/torrent\/([0-9a-fA-F]{40})$/);
      if (torMatch) {
        const data = await doTorrent(env, torMatch[1].toLowerCase(), allowed);
        return data ? htmlResp(pageTorrent(data, cats, allowed, heroStats))
          : htmlResp(layout({ title: "未找到", body: `<div class="err">种子不存在或不可见。</div>`, adultOn: allowed, stats: heroStats }), 404);
      }
      if (path === "/top") return htmlResp(pageList(await doList(env, "top", url.searchParams.get("cat"), allowed), cats, allowed, "Top 20 热门种子", heroStats));
      if (path === "/latest") return htmlResp(pageList(await doList(env, "latest", url.searchParams.get("cat"), allowed), cats, allowed, "最新收录", heroStats));
      const browseMatch = path.match(/^\/browse\/([a-z]+)$/);
      if (browseMatch) {
        const c = catByCode(cats, browseMatch[1]);
        if (!c || (!allowed && c.policy === "adult")) {
          return htmlResp(layout({ title: "未找到", body: `<div class="err">分类不存在或不可见。</div>`, adultOn: allowed, stats: heroStats }), 404);
        }
        const tab = url.searchParams.get("tab") === "latest" ? "latest" : "top";
        const data = await doList(env, tab, c.code, allowed);
        const body = `<section>
<div class="tabs-wrap"><span class="tabs"><a href="/browse/${c.code}?tab=top"${tab === "top" ? ` class="on"` : ""}>热门</a><a href="/browse/${c.code}?tab=latest"${tab === "latest" ? ` class="on"` : ""}>最新收录</a></span></div>
${data.torrents.length ? `<div class="list">${data.torrents.map((t) => torrentRow(t, cats)).join("")}</div>` : `<div class="mut">暂无数据</div>`}</section>`;
        return htmlResp(layout({ title: `${c.name_zh} — 浏览`, body, adultOn: allowed, ptitle: `${c.name_zh} · ${tab === "latest" ? "最新收录" : "热门"}`, stats: heroStats }));
      }
      if (path === "/register" || path === "/login") {
        const isLogin = path === "/login";
        if (request.method === "GET" && (await getUser(env, request))) {
          return redirectResp(safeNext(url.searchParams.get("next")));
        }
        if (request.method === "POST") {
          const form = await request.formData();
          const email = String(form.get("email") || "").trim().toLowerCase();
          const password = String(form.get("password") || "");
          const next = safeNext(form.get("next"));
          const fail = (msg) => htmlResp(pageAuth(isLogin ? "login" : "register", { error: msg, next, email }, allowed), 400);
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail("邮箱格式不正确。");
          if (password.length < 8) return fail("密码至少 8 位。");
          await ensureAuthTables(env);
          if (isLogin) {
            const rows = await q1(env, "SELECT id, password_hash FROM users WHERE email = ?", [email]);
            if (!rows.length || !(await verifyPassword(password, rows[0].password_hash))) return fail("邮箱或密码不正确。");
            await turso(env, [{ sql: "UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?", args: [rows[0].id] }]);
            const token = await createSession(env, rows[0].id);
            return redirectResp(next, sessionCookies(token, email));
          }
          if (password !== String(form.get("password2") || "")) return fail("两次输入的密码不一致。");
          const exists = await q1(env, "SELECT id FROM users WHERE email = ?", [email]);
          if (exists.length) return fail("该邮箱已注册，请直接登录。");
          const hash = await hashPassword(password);
          await turso(env, [{ sql: "INSERT INTO users (email, password_hash) VALUES (?,?)", args: [email, hash] }]);
          const rows = await q1(env, "SELECT id FROM users WHERE email = ?", [email]);
          const token = await createSession(env, rows[0].id);
          return redirectResp(next, sessionCookies(token, email));
        }
        return htmlResp(pageAuth(isLogin ? "login" : "register", { next: url.searchParams.get("next") || "/" }, allowed));
      }
      if (path === "/logout") {
        const tok = parseCookies(request).td_session;
        if (tok) {
          await turso(env, [{ sql: "DELETE FROM sessions WHERE token_hash = ?", args: [await sha256hex(tok)] }]).catch(() => {});
        }
        return redirectResp("/", clearCookies());
      }
      if (path === "/account") {
        const user = await getUser(env, request);
        if (!user) return redirectResp("/login?next=/account");
        return htmlResp(pageAccount(user, allowed, heroStats));
      }
      if (path === "/account/delete" && request.method === "POST") {
        const user = await getUser(env, request);
        if (!user) return redirectResp("/login");
        await turso(env, [
          { sql: "DELETE FROM user_favorites WHERE user_id = ?", args: [user.id] },
          { sql: "DELETE FROM user_search_history WHERE user_id = ?", args: [user.id] },
          { sql: "DELETE FROM sessions WHERE user_id = ?", args: [user.id] },
          { sql: "DELETE FROM users WHERE id = ?", args: [user.id] },
        ]);
        return redirectResp("/", clearCookies());
      }
      if (path === "/favorites") {
        const user = await getUser(env, request);
        if (!user) return redirectResp("/login?next=/favorites");
        const rows = await q1(env, `SELECT ${TOR_COLS} ${TOR_JOIN} JOIN user_favorites f ON f.infohash = t.infohash
          WHERE f.user_id = ? AND t.status = 'active'` + adultSql("t", allowed) + " ORDER BY f.created_at DESC LIMIT 20", [user.id]);
        const favList = rows.map((r) => torrentJson(r, cats));
        const body = `<section>${favList.length
          ? `<div class="list">${favList.map((t) => torrentRow(t, cats)).join("")}</div>${favList.length >= 20 ? `<div class="mut" style="margin-top:10px">仅显示最近 20 条收藏。</div>` : ""}`
          : `<div class="mut">还没有收藏。在种子行或详情页点「☆ 收藏」即可加入。</div>`}</section>`;
        return htmlResp(layout({ title: "我的收藏 — TorrDex", body, adultOn: allowed, ptitle: "我的收藏", stats: heroStats }));
      }
      if (path === "/history") {
        const user = await getUser(env, request);
        if (!user) return redirectResp("/login?next=/history");
        if (request.method === "POST") {
          await turso(env, [{ sql: "DELETE FROM user_search_history WHERE user_id = ?", args: [user.id] }]);
          return redirectResp("/history");
        }
        const rows = await q1(env, "SELECT query_raw, result_count, created_at FROM user_search_history WHERE user_id = ? ORDER BY id DESC LIMIT 100", [user.id]);
        const items = rows.map((r) => `<div class="row2"><div class="r1"><a class="nm" href="/search?q=${encodeURIComponent(r.query_raw)}">${esc(r.query_raw)}</a></div><div class="r2"><span>${esc(fmtNum(r.result_count))} 条结果</span><span>${esc(fmtTime(r.created_at))}</span></div></div>`).join("");
        const body = `<section>${rows.length
          ? `<div class="list">${items}</div><form method="post" action="/history" style="margin-top:14px" onsubmit="return confirm('清空全部搜索历史？')"><button class="favbtn" type="submit">清空历史</button></form>`
          : `<div class="mut">暂无搜索记录。登录状态下搜索会自动记录到这里。</div>`}</section>`;
        return htmlResp(layout({ title: "搜索历史 — TorrDex", body, adultOn: allowed, ptitle: "搜索历史", stats: heroStats }));
      }
      if (path === "/takedown") return htmlResp(pageTakedown(allowed, heroStats));
      if (path === "/about" || path === "/dmca" || path === "/faq") return htmlResp(pageAbout(allowed, heroStats));
      return htmlResp(layout({ title: "404", body: `<div class="err">页面不存在。<a href="/">回首页</a></div>`, adultOn: allowed, stats: heroStats }), 404);
    } catch (err) {
      // 不外泄 SQL/内部信息 (仅服务端日志)
      console.error("worker_error", err && err.message);
      return path.startsWith("/api/")
        ? jsonResp({ error: "internal_error" }, 500)
        : htmlResp(layout({ title: "出错了", body: `<div class="err">服务器内部错误，请稍后再试。</div>`, adultOn: false, stats: heroStats }), 500);
    }
  },
};

// 测试钩子 (不影响 Worker 运行)
export const __test = {
  normalizedKey, cleanQuery, buildMagnet, rerank, relevanceScore, recScore,
  adultAllowed, recall, turso, fmtSize, hashPassword, verifyPassword,
};
