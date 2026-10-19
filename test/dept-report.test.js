// 進捗を書く：定例を選べるようにする前に「次の定例」に向けて書いた進捗が、いちばん近い定例を選んだときに出る（src/api/dept.js）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { routes } from "../src/api/dept.js";

const sql = (name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, avatar TEXT, notion_user_id TEXT DEFAULT '')");
  db.exec("CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, type TEXT DEFAULT 'teigen', status TEXT DEFAULT 'active', current_stage INTEGER DEFAULT 1, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0, deleted_at INTEGER)");
  db.exec("CREATE TABLE project_members (project_id INTEGER, user_id TEXT)");
  for (const f of ["0011_dept_meetings.sql", "0012_dept_meeting_end.sql", "0014_dept_notice_draft.sql", "0016_dept_schedules.sql", "0017_dept_notice_days.sql",
    "0035_teirei_news_exchange.sql", "0036_teirei_notion.sql", "0041_teirei_layout.sql", "0049_report_target_day.sql"]) db.exec(sql(f));
  const prepare = (q) => {
    const st = {
      args: [],
      bind(...a) { st.args = a; return st; },
      async first() { return db.prepare(q).get(...st.args) ?? null; },
      async all() { return { results: db.prepare(q).all(...st.args) }; },
      async run() { const r = db.prepare(q).run(...st.args); return { meta: { changes: Number(r.changes) } }; },
    };
    return st;
  };
  return { prepare, async batch(list) { for (const s of list) await s.run(); }, raw: db };
}
const call = (method, path) => routes.find(([m, p]) => m === method && p === path)[2];

test("「次の定例」に向けて書いた進捗は、いちばん近い定例を選ぶとそのまま出る", async () => {
  const DB = fakeD1();
  const env = { DB };
  const user = { id: "u1", name: "テスト", isAdmin: true };
  DB.raw.exec("INSERT INTO projects (id, name) VALUES (1, '豪雨時の運休')");
  // 毎日22時の定例（どの曜日でも、次の定例が予定から出るように）
  for (let w = 0; w < 7; w++) DB.raw.exec(`INSERT INTO dept_schedules (weekday, time, from_date, to_date, created_by, created_at) VALUES (${w}, '22:00', '2020-01-01', '2099-12-31', 'u1', 0)`);
  // 選べるようにする前に書いた進捗（held_on = ''）
  DB.raw.exec("INSERT INTO dept_reports (project_id, dept_meeting_id, done, next, issues, updated_at, version) VALUES (1, NULL, '昨日書いた', '次', '困り', 0, 38)");
  const { suggested, targets } = await call("GET", "/api/teirei-targets")({ env, user, url: new URL("http://x/") });
  assert.ok(suggested);
  const get = (day) => call("GET", "/api/projects/:id/dept-report")({ env, user, params: { id: 1 }, url: new URL(`http://x/?day=${day}`) });
  const near = await get(suggested);
  assert.equal(near.report.done, "昨日書いた");
  assert.equal(near.report.version, 38);
  // その先の定例には出ない（いちばん近い定例のぶん）
  const later = targets.find((t) => t.day > suggested);
  if (later) assert.equal((await get(later.day)).report.done, "");
});
