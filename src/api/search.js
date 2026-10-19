// 議事録を探す：PJのMTGの議事録・定例の議事録・発表の記録を、言葉で探す（ログインしていれば誰でも）
import { HttpError, clean, int, optDate } from "../util.js";
import { addDays } from "../project-types.js";

export const routes = [
  ["GET", "/api/search/minutes", searchMinutes],
];

const LIMIT = 60;

// LIKE の % と _ は文字として扱う
const like = (w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// 空白で区切った言葉が、すべて含まれるもの（AND）。columns のどれかに含まれていればよい
function whereAll(words, columns) {
  const cond = words.map(() => `(${columns.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(" OR ")})`).join(" AND ");
  const binds = words.flatMap((w) => columns.map(() => like(w)));
  return { cond, binds };
}

async function searchMinutes({ env, url }) {
  const q = clean(url.searchParams.get("q") || "", 100);
  const words = q.split(/[\s　]+/).filter(Boolean).slice(0, 5);
  const kind = url.searchParams.get("kind") || "all";
  if (!["all", "meeting", "teirei", "present"].includes(kind)) throw new HttpError(400, "種類が正しくありません");
  const projectId = url.searchParams.get("project") ? int(url.searchParams.get("project"), { label: "PJ" }) : null;
  // 日付で絞り込む（この日から・この日まで。時刻は見ない）
  const from = optDate(url.searchParams.get("from"), "いつから");
  const to = optDate(url.searchParams.get("to"), "いつまで");
  // 何も指定がないときは、最近の記録を新しい順に返す
  const dateCond = (col) => `${from ? ` AND ${col} >= '${from}'` : ""}${to ? ` AND ${col} < '${addDays(to, 1)}'` : ""}`;
  const msFrom = from ? Date.parse(`${from}T00:00:00+09:00`) : null;
  const msTo = to ? Date.parse(`${addDays(to, 1)}T00:00:00+09:00`) : null;

  const results = [];
  // PJのMTGの議事録：今回話し合うこと・概要・次回までにやること
  if (kind === "all" || kind === "meeting") {
    const todos = "(SELECT group_concat(t.title, '\n') FROM tasks t WHERE t.source_minute_id = n.id)";
    const w = whereAll(words, ["n.agenda", "n.summary", todos]);
    const { results: rows } = await env.DB.prepare(
      `SELECT n.meeting_id AS id, m.starts_at AS at, m.kind, p.id AS project_id, p.name AS project_name,
              n.agenda, n.summary, ${todos} AS todos
       FROM minutes n JOIN meetings m ON m.id = n.meeting_id JOIN projects p ON p.id = n.project_id
       WHERE p.status != 'archived' ${projectId ? "AND p.id = ?" : ""} ${words.length ? `AND ${w.cond}` : ""}${dateCond("m.starts_at")}
       ORDER BY m.starts_at DESC LIMIT ?`
    ).bind(...(projectId ? [projectId] : []), ...w.binds, LIMIT).all();
    for (const r of rows) {
      results.push({
        kind: "meeting", at: r.at, href: `#/meetings/${r.id}?mode=view`, project_id: r.project_id, project_name: r.project_name,
        title: r.kind === "exchange" ? "意見交換会の議事録" : "MTGの議事録",
        text: r.kind === "exchange" ? (r.summary ? `話したこと：${r.summary}` : "")
          : [r.agenda && `今回話し合うこと：${r.agenda}`, r.summary && `概要：${r.summary}`, r.todos && `次回までにやること：${r.todos}`].filter(Boolean).join("\n"),
      });
    }
  }
  // 定例の議事録：事務連絡・メモ・各PJの進捗共有（PJを選んだときは、そのPJの進捗共有だけ）
  if (kind === "all" || kind === "teirei") {
    if (projectId) {
      const w = whereAll(words, ["r.done", "r.next", "r.issues"]);
      const { results: rows } = await env.DB.prepare(
        `SELECT d.id, COALESCE(d.starts_at, d.held_on || 'T00:00') AS at, r.done, r.next, r.issues, p.name AS project_name
         FROM dept_reports r JOIN dept_meetings d ON d.id = r.dept_meeting_id JOIN projects p ON p.id = r.project_id
         WHERE r.project_id = ? ${words.length ? `AND ${w.cond}` : ""}${dateCond("d.held_on")} ORDER BY d.held_on DESC LIMIT ?`
      ).bind(projectId, ...w.binds, LIMIT).all();
      for (const r of rows) {
        results.push({
          kind: "teirei", at: r.at, href: `#/teirei/${r.id}`, title: "定例の議事録（進捗共有）", project_id: projectId, project_name: r.project_name,
          text: [r.done && `やったこと：${r.done}`, r.next && `次にやること：${r.next}`, r.issues && `困っていること：${r.issues}`].filter(Boolean).join("\n"),
        });
      }
    } else {
      const reports = "(SELECT group_concat(p2.name || '：' || r.done || ' ' || r.next || ' ' || r.issues, '\n') FROM dept_reports r JOIN projects p2 ON p2.id = r.project_id WHERE r.dept_meeting_id = d.id)";
      const w = whereAll(words, ["d.notice", "d.memo", reports]);
      const { results: rows } = await env.DB.prepare(
        `SELECT d.id, COALESCE(d.starts_at, d.held_on || 'T00:00') AS at, d.notice, d.memo, ${reports} AS reports
         FROM dept_meetings d WHERE 1 = 1 ${words.length ? `AND ${w.cond}` : ""}${dateCond("d.held_on")} ORDER BY d.held_on DESC LIMIT ?`
      ).bind(...w.binds, LIMIT).all();
      for (const r of rows) {
        results.push({
          kind: "teirei", at: r.at, href: `#/teirei/${r.id}`, title: "定例の議事録",
          text: [r.notice && `事務連絡：${r.notice}`, r.memo && `メモ：${r.memo}`, r.reports && `進捗共有：${r.reports}`].filter(Boolean).join("\n"),
        });
      }
    }
  }
  // 発表の記録：メモ
  if (kind === "all" || kind === "present") {
    const w = whereAll(words, ["r.memo"]);
    const { results: rows } = await env.DB.prepare(
      `SELECT r.id, r.created_at, r.kind, r.sub, r.memo, p.id AS project_id, p.name AS project_name
       FROM presentation_records r JOIN projects p ON p.id = r.project_id
       WHERE p.status != 'archived' ${projectId ? "AND p.id = ?" : ""} ${words.length ? `AND ${w.cond}` : ""}${msFrom ? ` AND r.created_at >= ${msFrom}` : ""}${msTo ? ` AND r.created_at < ${msTo}` : ""}
       ORDER BY r.created_at DESC LIMIT ?`
    ).bind(...(projectId ? [projectId] : []), ...w.binds, LIMIT).all();
    for (const r of rows) {
      results.push({
        kind: "present", at: new Date(r.created_at + 9 * 3600 * 1000).toISOString().slice(0, 16), href: `#/present/${r.project_id}`, project_id: r.project_id, project_name: r.project_name,
        title: r.kind === "seicho" ? `発表の記録（政調MTG・${r.sub === "policy" ? "政策発表" : "課題共有"}）` : "発表の記録（その他の発表）",
        text: r.memo ? `メモ：${r.memo}` : "",
      });
    }
  }
  // 新しい順にまとめる
  results.sort((x, y) => String(y.at).localeCompare(String(x.at)));
  return { results: results.slice(0, LIMIT), q, words };
}
