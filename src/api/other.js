// その他のMTG：PJ・定例以外のMTG。カテゴリー（いまは「その他」だけ）→ プロジェクト → MTGの議事録
// 議事録は、Notionの「その他」ページの「プロジェクト」欄に作ったプロジェクトのページの中へ、1回ずつページとして入る
import { HttpError, readJson, required, int, longText, reqDateTime, assertUpdated } from "../util.js";
import { requireAdmin } from "./common.js";
import { notionConfigured, notionPageId, findOtherParent, createGroupPage, createNotionPage, replaceNotionPage, noteBlocks } from "../notion.js";

export const routes = [
  ["GET", "/api/other-groups", listGroups],
  ["POST", "/api/other-groups", createGroup],
  ["POST", "/api/other-groups/:id/meetings", startMeeting],
  ["GET", "/api/other-meetings", listMeetings],
  ["GET", "/api/other-meetings/:id", getMeeting],
  ["PUT", "/api/other-meetings/:id", saveMeeting],
  ["GET", "/api/admin/notion-check", checkNotion],
];

// カテゴリー：いまは「その他」だけ（あとで代表・副代表・企画部門・広報部門・デザイン部門などを足せる）
// page：Notionでそのカテゴリーのページ（設定 NOTION_OTHER_PAGE）
export const CATEGORIES = [{ key: "other", label: "その他", pageVar: "NOTION_OTHER_PAGE" }];
const category = (key) => {
  const c = CATEGORIES.find((x) => x.key === key);
  if (!c) throw new HttpError(400, "カテゴリーを選んでください");
  return c;
};
const notionOn = (env, c) => notionConfigured(env) && Boolean(env[c.pageVar]);

async function listGroups({ env }) {
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.category, g.name, g.notion_url, u.name AS created_by_name,
            (SELECT MAX(m.starts_at) FROM other_meetings m WHERE m.group_id = g.id) AS last_at
     FROM other_groups g LEFT JOIN users u ON u.id = g.created_by ORDER BY last_at IS NULL, last_at DESC, g.created_at DESC`
  ).all();
  return { categories: CATEGORIES.map(({ key, label }) => ({ key, label })), groups: results };
}

// 新しいプロジェクト：ツールに作り、Notionの「その他」ページの「プロジェクト」欄にもページを作る（作れなくても、ツールには作る）
async function createGroup({ request, env, user, ctx }) {
  const body = await readJson(request);
  const c = category(body.category || "other");
  const name = required(body.name, 60, "プロジェクトの名前");
  const dup = await env.DB.prepare("SELECT id FROM other_groups WHERE category = ? AND name = ?").bind(c.key, name).first();
  if (dup) throw new HttpError(400, "同じ名前のプロジェクトがもうあります。一覧から選んでください");
  const row = await env.DB.prepare("INSERT INTO other_groups (category, name, created_by, created_at) VALUES (?, ?, ?, ?) RETURNING id")
    .bind(c.key, name, user.id, Date.now()).first();
  if (notionOn(env, c)) ctx?.waitUntil(ensureGroupPage(env, row.id).catch((err) => console.error("other group notion failed", err?.status, err?.code || err?.message)));
  return { id: row.id };
}

async function loadGroup(env, id) {
  const g = await env.DB.prepare("SELECT * FROM other_groups WHERE id = ?").bind(id).first();
  if (!g) throw new HttpError(404, "プロジェクトが見つかりません");
  return g;
}

// プロジェクトのNotionページ（なければ作る）
async function ensureGroupPage(env, groupId) {
  const g = await loadGroup(env, groupId);
  if (g.notion_url) return g.notion_url;
  const parent = await findOtherParent(env, notionPageId(env[category(g.category).pageVar]));
  const url = await createGroupPage(env, parent, g.name);
  await env.DB.prepare("UPDATE other_groups SET notion_url = ? WHERE id = ? AND notion_url = ''").bind(url, g.id).run();
  return (await loadGroup(env, groupId)).notion_url;
}

async function startMeeting({ request, env, user, params }) {
  const g = await loadGroup(env, params.id);
  const body = await readJson(request);
  const now = Date.now();
  const row = await env.DB.prepare(
    "INSERT INTO other_meetings (group_id, starts_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id"
  ).bind(g.id, reqDateTime(body.starts_at, "日時"), user.id, now, now).first();
  return { id: row.id };
}

const MEETING_SQL = `SELECT m.*, g.name AS group_name, g.category, g.notion_url AS group_notion_url, u.name AS updated_by_name
  FROM other_meetings m JOIN other_groups g ON g.id = m.group_id LEFT JOIN users u ON u.id = m.updated_by`;

async function listMeetings({ env }) {
  const { results } = await env.DB.prepare(`${MEETING_SQL} ORDER BY m.starts_at DESC LIMIT 100`).all();
  return { meetings: results.map(({ body, ...m }) => ({ ...m, has_minutes: Boolean(body.trim()) })) };
}

async function getMeeting({ env, params }) {
  const m = await env.DB.prepare(`${MEETING_SQL} WHERE m.id = ?`).bind(params.id).first();
  if (!m) throw new HttpError(404, "MTGが見つかりません");
  const c = CATEGORIES.find((x) => x.key === m.category);
  return { meeting: { ...m, category_label: c?.label || "" } };
}

// 保存（自動保存も）。sync: true（「保存する」「MTGを終える」）のとき、Notionにも入れる。end: true で「MTGを終える」
async function saveMeeting({ request, env, user, params, ctx }) {
  const cur = await env.DB.prepare("SELECT * FROM other_meetings WHERE id = ?").bind(params.id).first();
  if (!cur) throw new HttpError(404, "MTGが見つかりません");
  const body = await readJson(request);
  const text = longText(body.body, 50000, "議事録");
  const version = int(body.version, { min: 1, label: "版" });
  const now = Date.now();
  const res = await env.DB.prepare(
    "UPDATE other_meetings SET body = ?, ended_at = ?, updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?"
  ).bind(text, body.end ? cur.ended_at || now : cur.ended_at, user.id, now, cur.id, version).run();
  assertUpdated(res, "議事録");
  const g = await loadGroup(env, cur.group_id);
  if (body.sync && notionOn(env, category(g.category))) ctx?.waitUntil(syncMeeting(env, cur.id).catch((err) => console.error("other meeting notion failed", err?.status, err?.code || err?.message)));
  return { ok: true, version: version + 1 };
}

// 議事録をNotionへ：1回目はプロジェクトのページの中に新しいページを作る。2回目からは同じページを書き直す
async function syncMeeting(env, id) {
  const m = await env.DB.prepare("SELECT * FROM other_meetings WHERE id = ?").bind(id).first();
  const groupUrl = await ensureGroupPage(env, m.group_id);
  const d = m.starts_at;
  const title = `${d.slice(0, 4)}/${d.slice(5, 7)}/${d.slice(8, 10)} MTG議事録`;
  const blocks = noteBlocks(m.body, env.APP_URL ? `${env.APP_URL}/#/other-meetings/${m.id}` : "");
  if (m.notion_url) return replaceNotionPage(env, m.notion_url, title, blocks);
  const url = await createNotionPage(env, groupUrl, title, blocks);
  await env.DB.prepare("UPDATE other_meetings SET notion_url = ? WHERE id = ? AND notion_url = ''").bind(url, m.id).run();
}

// 管理者：Notionの「その他」ページに、ツールから入れるか確かめる（インテグレーションが「接続」されているか・「プロジェクト」欄が見つかるか）
async function checkNotion({ env, user }) {
  requireAdmin(user, "管理者だけが使えます");
  if (!notionConfigured(env)) return { ok: false, message: "Notionのトークンが入っていません" };
  const results = [];
  for (const c of CATEGORIES) {
    if (!env[c.pageVar]) { results.push({ label: c.label, ok: false, message: "ページが設定されていません" }); continue; }
    try {
      const parent = await findOtherParent(env, notionPageId(env[c.pageVar]));
      results.push({ label: c.label, ok: true, message: parent.database_id ? `ページの中のデータベース「${parent.title}」にプロジェクトのページを作ります` : "「プロジェクト」のデータベースが見つからないので、ページの中に直接プロジェクトのページを作ります" });
    } catch (err) {
      results.push({ label: c.label, ok: false, message: err?.status === 404 || err?.code === "object_not_found"
        ? "ページが見つかりません。Notionでそのページの「…」→「接続」に、インテグレーション（アクションボード）を追加してください"
        : `Notionにつながりませんでした（${err?.status || ""} ${err?.code || err?.message || ""}）` });
    }
  }
  return { ok: results.every((r) => r.ok), results };
}
