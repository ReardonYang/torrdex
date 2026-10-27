// SQL 真值验证: 捕获 worker 实际生成的 SQL/参数, 在真实 DDL 建的本地库上执行。
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/worker.js";

const ddl = readFileSync(new URL("../../data-model-sqlite.sql", import.meta.url), "utf-8");
const db = new DatabaseSync(":memory:");
db.exec(ddl);
db.exec(`INSERT INTO categories (id, code, name_zh, name_en, policy, sort_order) VALUES
  (1,'movie','电影','Movies','sfw',1),(8,'adult','成人','Adult','adult',8);
INSERT INTO titles (id, category_id, canonical_title, normalized_key, year, torrent_count, alive_count, best_health)
  VALUES (1,1,'沙丘2','沙丘2',2024,1,1,92);
INSERT INTO torrents (infohash, title_id, category_id, name_raw, name_clean, normalized_key, total_size,
  file_count, resolution, source_type, video_codec, seeders, leechers, completed, health_score, health_band, source)
  VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,1,'Dune Part Two 2024 2160p WEB-DL','Dune Part Two 2024 2160p','duneparttwo20242160p',20000000000,2,'2160p','WEB-DL','x265',500,40,9000,92,'alive','dht');
INSERT INTO torrents_fts (infohash, title_id, category_id, status, name_clean, name_raw, aliases_text, group_name)
  VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,1,'active','Dune Part Two 2024 2160p','Dune Part Two 2024 2160p WEB-DL','','FGT');
INSERT INTO torrents (infohash, title_id, category_id, name_raw, name_clean, normalized_key, total_size,
  file_count, resolution, source_type, video_codec, seeders, leechers, completed, health_score, health_band, source)
  VALUES ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',1,1,'沙丘2.2024.2160p.WEB-DL.x265','沙丘2 2024 2160p','x220242160p',18000000000,1,'2160p','WEB-DL','x265',120,10,2000,85,'alive','dht');
INSERT INTO torrents_fts (infohash, title_id, category_id, status, name_clean, name_raw, aliases_text, group_name)
  VALUES ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',1,1,'active','沙丘2 2024 2160p','沙丘2.2024.2160p.WEB-DL.x265','','');`);

const captured = [];
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  const results = body.requests.filter((r) => r.type === "execute").map((r) => {
    captured.push(r.stmt);
    return { type: "ok", response: { type: "execute", result: { cols: [], rows: [], affected_row_count: 0 } } };
  });
  return new Response(JSON.stringify({ baton: null, results }), { status: 200 });
};

const env = { TURSO_URL: "https://db.example", TURSO_TOKEN: "x" };
const ctx = { waitUntil() {} };
await worker.fetch(new Request("https://x/api/search?q=" + encodeURIComponent("dune part")), env, ctx);
await worker.fetch(new Request("https://x/api/search?q=" + encodeURIComponent("沙丘")), env, ctx);
await worker.fetch(new Request("https://x/api/stats"), env, ctx);

let fails = 0, ran = 0;
for (const stmt of captured) {
  if (/INSERT INTO search_logs/.test(stmt.sql)) continue; // 写日志语句参数含哈希, 单独跳过
  const args = stmt.args.map((a) => (a.type === "null" ? null : a.type === "integer" ? Number(a.value) : a.value));
  try {
    const rows = db.prepare(stmt.sql).all(...args);
    ran++;
    if (/MATCH/.test(stmt.sql)) console.log("FTS MATCH rows:", rows.length, rows[0] ? "hit=" + String(rows[0].infohash).slice(0, 8) : "");
    if (/LIKE/.test(stmt.sql)) console.log("LIKE rows:", rows.length);
    if (/GROUP BY t\.health_band/.test(stmt.sql)) console.log("facet health rows:", JSON.stringify(rows));
  } catch (e) {
    fails++;
    console.log("SQL ERROR:", e.message, "\n  in:", stmt.sql.slice(0, 140));
  }
}
console.log(`executed ${ran} captured statements, ${fails} error(s)`);
process.exit(fails ? 1 : 0);
