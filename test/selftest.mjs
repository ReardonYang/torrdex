// 自检: 用 mock fetch 模拟 Turso /v2/pipeline 响应, 验证
//  1) >=3 字符查询走 FTS MATCH + bm25; 2) 2 字 CJK 走 LIKE 兜底;
//  3) rerank 排序合理 (死种沉底); 4) 磁力含 xt+dn+tr 且去重;
//  5) 成人行在无 cookie 时被 SQL 层过滤, 有 cookie+adult=1 时放行。
// 运行: node test/selftest.mjs
import worker, { __test } from "../src/worker.js";

let failures = 0;
function ok(cond, label) {
  console.log((cond ? "PASS" : "FAIL") + "  " + label);
  if (!cond) failures++;
}

// ---- mock Turso ----
const seenSql = [];
function cell(v) {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "number") return Number.isInteger(v) ? { type: "integer", value: String(v) } : { type: "float", value: v };
  return { type: "text", value: String(v) };
}
function result(cols, rows) {
  return { type: "ok", response: { type: "execute", result: {
    cols: cols.map((name) => ({ name })), rows: rows.map((r) => r.map(cell)), affected_row_count: 0,
  } } };
}
const TOR_COL_NAMES = ["infohash","title_id","category_id","name_raw","name_clean","total_size","file_count",
  "year","season_no","episode_no","resolution","source_type","video_codec","audio_codec","is_hdr",
  "is_dolby_vision","subtitles","languages","edition","seeders","leechers","completed","health_score",
  "health_band","scraped_at","first_seen_at","last_seen_at","popularity_7d","magnet_clicks","size_mismatch",
  "is_private","piece_length","group_name","group_trust","group_verified","bm25"];
function torRow(over = {}) {
  const base = {
    infohash: "a".repeat(40), title_id: null, category_id: 1, name_raw: "Dune Part Two 2024 2160p",
    name_clean: "Dune Part Two 2024 2160p", total_size: 2e10, file_count: 2, year: 2024,
    season_no: null, episode_no: null, resolution: "2160p", source_type: "WEB-DL", video_codec: "x265",
    audio_codec: "Atmos", is_hdr: 1, is_dolby_vision: 0, subtitles: '["chs"]', languages: '["eng"]',
    edition: null, seeders: 500, leechers: 40, completed: 9000, health_score: 92, health_band: "alive",
    scraped_at: "2026-10-26T08:00:00Z", first_seen_at: "2026-10-20T00:00:00Z",
    last_seen_at: "2026-10-26T08:00:00Z", popularity_7d: 88.5, magnet_clicks: 300, size_mismatch: 0,
    is_private: 0, piece_length: 4194304, group_name: "FGT", group_trust: "trusted", group_verified: 1,
    bm25: -6.0,
  };
  return { ...base, ...over };
}
function torCells(o) { return TOR_COL_NAMES.map((c) => o[c]); }

globalThis.fetch = async (url, opts) => {
  if (!String(url).includes("/v2/pipeline")) throw new Error("unexpected fetch " + url);
  const body = JSON.parse(opts.body);
  const results = body.requests.filter((r) => r.type === "execute").map((r) => {
    const sql = r.stmt.sql;
    seenSql.push(sql);
    if (sql.startsWith("SELECT id, code, name_zh, name_en, policy FROM categories")) {
      return result(["id","code","name_zh","name_en","policy"], [
        [1, "movie", "电影", "Movies", "sfw"], [8, "adult", "成人", "Adult", "adult"],
      ]);
    }
    if (sql.includes("INSERT INTO search_logs")) return result([], []);
    if (sql.includes("GROUP BY t.category_id")) return result(["k","n"], [[1, 3]]);
    if (sql.includes("GROUP BY t.resolution")) return result(["k","n"], [["2160p", 3]]);
    if (sql.includes("GROUP BY t.health_band")) return result(["k","n"], [["alive", 2], ["dead", 1]]);
    if (sql.includes("torrents_fts") && sql.includes("MATCH")) {
      return result(TOR_COL_NAMES, [torCells(torRow())]);
    }
    if (sql.includes("LIKE ? ESCAPE")) {
      return result(TOR_COL_NAMES, [torCells(torRow({ bm25: null }))]);
    }
    if (sql.includes("FROM titles WHERE id IN")) return result([], []);
    return result([], []);
  });
  return new Response(JSON.stringify({ baton: null, results }), { status: 200 });
};

const env = { TURSO_URL: "https://db.example", TURSO_TOKEN: "test-token" };
const ctx = { waitUntil() {}, passThroughOnException() {} };

// ---- 1) >=3 字符: FTS MATCH ----
seenSql.length = 0;
{
  const res = await worker.fetch(new Request("https://x/api/search?q=" + encodeURIComponent("dune part")), env, ctx);
  const data = await res.json();
  ok(res.status === 200, "search >=3 chars returns 200");
  ok(seenSql.some((s) => s.includes("MATCH ?")), "FTS path uses MATCH");
  ok(seenSql.some((s) => s.includes("bm25(torrents_fts)")), "FTS path orders by bm25");
  ok(data.total === 3 && data.alive === 2, "facet totals parsed (total=3, alive=2), got total=" + data.total + " alive=" + data.alive);
  ok(data.torrents[0].magnet.startsWith("magnet:?xt=urn:btih:"), "torrent JSON carries magnet");
}

// ---- 2) 2 字 CJK: LIKE 兜底, 无 MATCH ----
seenSql.length = 0;
{
  const res = await worker.fetch(new Request("https://x/api/search?q=" + encodeURIComponent("沙丘")), env, ctx);
  const data = await res.json();
  ok(res.status === 200, "search 2-char CJK returns 200");
  ok(seenSql.some((s) => s.includes("name_clean LIKE")), "short query uses LIKE fallback");
  ok(!seenSql.some((s) => s.includes("MATCH")), "short query does NOT use FTS MATCH");
  ok(data.mode === "like", "mode reported as like");
}

// ---- 3) 成人过滤 ----
seenSql.length = 0;
{
  await worker.fetch(new Request("https://x/api/search?q=dune"), env, ctx);
  ok(seenSql.some((s) => s.includes("policy='adult'")), "without cookie: SQL excludes adult policy");
}
seenSql.length = 0;
{
  const req = new Request("https://x/api/search?q=dune&adult=1", { headers: { Cookie: "adult=1" } });
  await worker.fetch(req, env, ctx);
  ok(!seenSql.some((s) => s.includes("policy='adult'")), "with cookie+adult=1: no adult exclusion");
}
seenSql.length = 0;
{
  const req = new Request("https://x/api/search?q=dune&adult=1"); // 参数有、cookie 无
  await worker.fetch(req, env, ctx);
  ok(seenSql.some((s) => s.includes("policy='adult'")), "param without cookie: still excluded");
}
seenSql.length = 0;
{
  const req = new Request("https://x/api/search?q=dune", { headers: { Cookie: "adult=1" } }); // 只有 cookie (2026-10-27 单条件)
  await worker.fetch(req, env, ctx);
  ok(!seenSql.some((s) => s.includes("policy='adult'")), "cookie only (no param): adult allowed after fix");
}

// ---- 4) rerank: 健康高做种在前, 死种沉底 ----
{
  const rows = [
    torRow({ infohash: "d".repeat(40), health_band: "dead", health_score: 0, seeders: 9999, bm25: -9 }),
    torRow({ infohash: "b".repeat(40), health_band: "alive", health_score: 90, seeders: 100, bm25: -9.5 }),
    torRow({ infohash: "c".repeat(40), health_band: "alive", health_score: 60, seeders: 5, bm25: -4 }),
  ];
  const out = __test.rerank(rows, "relevance");
  ok(out[0].infohash === "b".repeat(40), "rerank: best healthy torrent first");
  ok(out[out.length - 1].infohash === "d".repeat(40), "rerank: dead sinks to bottom despite 9999 seeders");
  const bySeed = __test.rerank(rows, "seeders");
  ok(bySeed[0].seeders === 9999, "explicit seeders sort is honest (dead shown, not hidden)");
}

// ---- 5) 磁力拼装 ----
{
  const m = __test.buildMagnet("a".repeat(40), "名字 Test", ["udp://tracker.opentrackr.org:1337/announce", "udp://custom:6969/x"]);
  ok(m.includes("xt=urn:btih:" + "a".repeat(40)), "magnet has xt");
  ok(m.includes("dn=" + encodeURIComponent("名字 Test")), "magnet has dn");
  ok(m.includes("tr=" + encodeURIComponent("udp://custom:6969/x")), "magnet has stored tr");
  ok(m.split("opentrackr").length - 1 === 1, "duplicate tracker (stored ∩ public) deduped");
}

// ---- 6) 规范化与 adultAllowed ----
{
  ok(__test.normalizedKey("Ｄｕｎｅ．2024") === "dune2024", "normalizedKey: NFKC + strip punct");
  ok(__test.adultAllowed(new Request("https://x/", { headers: { Cookie: "adult=1" } }), new URL("https://x/")) === true,
     "adultAllowed: cookie alone allows (2026-10-27)");
  ok(__test.adultAllowed(new Request("https://x/?adult=1"), new URL("https://x/?adult=1")) === false,
     "adultAllowed: param alone does not allow");
}

// ---- 7) 密码哈希 (PBKDF2) ----
{
  const h = await __test.hashPassword("correct horse 9");
  ok(h.startsWith("pbkdf2$100000$"), "hashPassword format pbkdf2$iter$salt$hash");
  ok(await __test.verifyPassword("correct horse 9", h) === true, "verifyPassword: correct passes");
  ok(await __test.verifyPassword("wrong password", h) === false, "verifyPassword: wrong fails");
  ok(await __test.verifyPassword("correct horse 9", "garbage") === false, "verifyPassword: malformed stored fails closed");
  const h2 = await __test.hashPassword("correct horse 9");
  ok(h !== h2, "hashPassword: random salt -> different hashes");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL TESTS PASSED");
process.exit(failures ? 1 : 0);
