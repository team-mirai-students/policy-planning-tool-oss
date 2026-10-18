// Notion との連携：MTGの議事録を、PJのNotionページ（見出し「議事録」の下）に新しいページとして作る
// NOTION_TOKEN（Notionのインテグレーションのトークン。シークレット）が必要。PJのページをそのインテグレーションに「接続」しておく
import { HttpError } from "./util.js";
import { parseLayout, FIXED_TITLES } from "./teirei-layout.js";

const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

export function notionConfigured(env) {
  return Boolean(env.NOTION_TOKEN);
}

// NotionのページのURLから、ページID（32桁）を取り出す
export function notionPageId(url) {
  const m = String(url || "").replace(/-/g, "").match(/([0-9a-f]{32})(?:[?#]|$)/i);
  return m ? m[1] : null;
}

// Notionは1つの文字のかたまりが2000字まで。長い文章は切り捨てずに、1900字ずつに分けて送る
// 絵文字など2つ分の文字を途中で切らないよう、1文字ずつ数えて分ける
const chunks = (s) => {
  const out = [];
  let cur = "";
  for (const ch of s) {
    if (cur.length + ch.length > 1900) { out.push(cur); cur = ""; }
    cur += ch;
  }
  if (cur || !out.length) out.push(cur);
  return out;
};
const rich = (text) => chunks(String(text)).slice(0, 100).map((content) => ({ type: "text", text: { content } }));
// **太字** *斜体* ~~取り消し~~ `コード` [文字](URL) とURLを、Notionの書式つき文字にする（リンクはNotionでもクリックで開ける）
const INLINE = /\*\*([^*]+)\*\*|~~([^~]+)~~|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>"']+)|(?<![*])\*([^*\s][^*]*)\*/g;
function inline(text) {
  const out = [];
  const push = (content, annotations = {}, link = null) => {
    if (!content) return;
    for (const part of chunks(content)) out.push({ type: "text", text: { content: part, ...(link ? { link: { url: link } } : {}) }, annotations });
  };
  let last = 0;
  const s = String(text);
  for (const m of s.matchAll(INLINE)) {
    push(s.slice(last, m.index));
    if (m[1]) push(m[1], { bold: true });
    else if (m[2]) push(m[2], { strikethrough: true });
    else if (m[3]) push(m[3], { code: true });
    else if (m[4]) push(m[4], {}, m[5]);
    else if (m[6]) push(m[6], {}, m[6]);
    else if (m[7]) push(m[7], { italic: true });
    last = m.index + m[0].length;
  }
  push(s.slice(last));
  return out.length ? out.slice(0, 100) : rich("");
}
const heading = (text) => ({ object: "block", type: "heading_3", heading_3: { rich_text: rich(text) } });
const bullet = (text) => ({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: rich(text) } });
const todo = (text, checked = false) => ({ object: "block", type: "to_do", to_do: { rich_text: rich(text), checked } });
const para = (text) => ({ object: "block", type: "paragraph", paragraph: { rich_text: rich(text) } });

// 書式つきの文章（Markdown）を、行ごとにNotionのブロックにする
const lines = (text) => String(text || "").split("\n").filter((l) => l.trim());
const block = (type, text, extra = {}) => ({ object: "block", type, [type]: { rich_text: inline(text), ...extra } });
function mdBlock(line) {
  let m;
  if ((m = line.match(/^▶\s?(.*)$/))) return block("toggle", m[1]);
  if ((m = line.match(/^💡\s?(.*)$/u))) return block("callout", m[1], { icon: { type: "emoji", emoji: "💡" }, color: "gray_background" });
  if ((m = line.match(/^###\s+(.*)$/))) return block("heading_3", m[1]);
  if ((m = line.match(/^##\s+(.*)$/))) return block("heading_2", m[1]);
  if ((m = line.match(/^#\s+(.*)$/))) return block("heading_1", m[1]);
  if ((m = line.match(/^\s*(?:[-*]\s)?\[( |x|X)\]\s?(.*)$/))) return block("to_do", m[2], { checked: m[1].toLowerCase() === "x" });
  // 「- 」「* 」（後ろに空白）と「・」が箇条書き。行頭の **太字** は箇条書きにしない
  if ((m = line.match(/^\s*(?:[-*]\s|・\s?)(.*)$/))) return block("bulleted_list_item", m[1]);
  if ((m = line.match(/^\s*\d{1,3}[.)]\s+(.*)$/))) return block("numbered_list_item", m[1]);
  if ((m = line.match(/^>\s?(.*)$/))) return block("quote", m[1]);
  if (/^-{3,}$/.test(line.trim())) return { object: "block", type: "divider", divider: {} };
  if (/^https?:\/\/\S+$/.test(line.trim())) return { object: "block", type: "bookmark", bookmark: { url: line.trim() } };
  return block("bulleted_list_item", line.trim());
}

// 字下げ（行頭の空白2つで1段）を、Notionの入れ子（トグルの中身など）にする。1回で作れるのは2段まで
const CAN_NEST = ["toggle", "callout", "bulleted_list_item", "numbered_list_item", "to_do", "quote", "paragraph"];
function nest(text) {
  const out = [];
  const stack = [];
  for (const raw of lines(text)) {
    const indent = Math.min(2, Math.floor(raw.match(/^ */)[0].length / 2));
    const b = mdBlock(raw.trim());
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    // 1つのブロックの中身は100個まで（超えた分は、消さずに外に出す）
    const kids = parent && CAN_NEST.includes(parent.block.type) ? (parent.block[parent.block.type].children ||= []) : null;
    if (kids && kids.length < 100) kids.push(b);
    else out.push(b);
    stack.push({ indent, block: b });
  }
  return out;
}

// 議事録の中身 → Notionのブロック（見出し・箇条書き・チェックボックス）
export function minutesBlocks({ homework = [], agenda = "", summary = "", todos = [], appUrl = "" }) {
  const blocks = [];
  if (homework.length) {
    blocks.push(heading("前回の宿題"));
    for (const t of homework) blocks.push(todo(`${t.title}（${t.assignee_name || "担当未定"}）`, t.status === "done"));
  }
  blocks.push(heading("今回話し合うこと"));
  blocks.push(...(lines(agenda).length ? nest(agenda) : [para("（なし）")]));
  blocks.push(heading("概要"));
  blocks.push(...(lines(summary).length ? nest(summary) : [para("（なし）")]));
  blocks.push(heading("次回までにやること"));
  blocks.push(...(todos.length ? todos.map((t) => todo(`${t.title}（${t.assignee_name || "担当未定"}${t.due_date ? `・${t.due_date.slice(5).replace("-", "/")}まで` : ""}）`, t.status === "done")) : [para("（なし）")]));
  if (appUrl) blocks.push(para(`政策立案ツールの議事録：${appUrl}`));
  return blocks; // 100個を超えても切らない（送るときに100個ずつに分ける）
}

const headers = (env) => ({ Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": VERSION, "Content-Type": "application/json" });
async function call(env, path, method, body) {
  let res;
  // 混んでいる（429）・一時的な不調（5xx）のときは、少し待って3回までやり直す
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`${API}${path}`, { method, headers: headers(env), body: body ? JSON.stringify(body) : undefined });
    if (!(res.status === 429 || res.status >= 500) || attempt >= 3) break;
    const wait = Math.min(10, Number(res.headers.get("Retry-After")) || attempt + 1);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("notion api failed", method, path.replace(/[0-9a-f-]{32,36}/g, "…"), res.status, data.code);
    throw Object.assign(new Error("notion"), { status: res.status, code: data.code });
  }
  return data;
}

// PJページの「参加者」（人の欄）を、人事に合わせる
//   members：このPJのメンバーのNotionアカウント／known：ツールでNotionアカウントを対応づけた人全員
//   ツールが知らない人（対応づけていない人）は、Notionで手で入れたものとして残す
export async function syncProjectPeople(env, pageUrl, members, known) {
  const id = notionPageId(pageUrl);
  if (!id) return false;
  const page = await call(env, `/pages/${id}`, "GET");
  const people = Object.entries(page.properties || {}).filter(([, p]) => p.type === "people");
  const [name, prop] = people.find(([n]) => /参加|メンバー|member/i.test(n)) || people[0] || [];
  if (!name) return false;
  const now = (prop.people || []).map((u) => u.id);
  const keep = now.filter((uid) => !known.includes(uid));
  const next = [...new Set([...members, ...keep])];
  if (next.length === now.length && next.every((uid) => now.includes(uid))) return false;
  await call(env, `/pages/${id}`, "PATCH", { properties: { [name]: { people: next.map((uid) => ({ object: "user", id: uid })) } } });
  return true;
}

// MTGを消したら、Notionの議事録ページもNotionのゴミ箱へ（元に戻したら戻す）
export async function setNotionArchived(env, pageUrl, archived) {
  const id = notionPageId(pageUrl);
  if (!id) return;
  await call(env, `/pages/${id}`, "PATCH", { archived });
}

// 作ってあるNotionの議事録ページを、いまの内容で書き直す（題名と中身を入れ替える）
export async function replaceNotionPage(env, pageUrl, title, children) {
  const id = notionPageId(pageUrl);
  if (!id) return;
  await call(env, `/pages/${id}`, "PATCH", { properties: { title: { title: rich(title) } } });
  const old = (await listChildren(env, id)).map((b) => b.id);
  // 先に新しい中身を足してから、古い中身を消す（途中で失敗しても、ページが空にならないように）
  await appendBlocks(env, id, children);
  for (const b of old) await call(env, `/blocks/${b}`, "DELETE");
}

// ページの中身をすべて読む
async function listChildren(env, id) {
  let cursor;
  const all = [];
  do {
    const r = await call(env, `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`, "GET");
    all.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return all;
}

// ページの最後に足す（Notionは1回に100個までなので、分けて送る）
async function appendBlocks(env, id, blocks) {
  for (let i = 0; i < blocks.length; i += 100) await call(env, `/blocks/${id}/children`, "PATCH", { children: blocks.slice(i, i + 100) });
}

// ---------- メンバー（Notionのワークスペースに入っている人） ----------
// Notion がそのまま見せるのはワークスペースの「メンバー」だけ。ゲストの人は、PJページの「参加者」など、
// つないだページの「人」の欄に入っている人から集める（sampleUrls：PJのNotionページ。その親のデータベースも読む）
export async function listNotionUsers(env, { sampleUrls = [] } = {}) {
  const found = new Map();
  const add = (u) => { if (u?.object === "user" && u.type !== "bot" && u.id && u.name && !found.has(u.id)) found.set(u.id, { id: u.id, name: u.name, avatar: u.avatar_url || "" }); };
  const fromProps = (props) => {
    for (const p of Object.values(props || {})) {
      if (p.type === "people") (p.people || []).forEach(add);
      else if (p.type === "created_by" || p.type === "last_edited_by") add(p[p.type]);
    }
  };
  let cursor;
  do {
    const r = await call(env, `/users?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`, "GET");
    r.results.filter((u) => u.type === "person").forEach(add);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor && found.size < 1000);
  // PJページとその親のデータベース、定例の議事録のデータベースから
  const dbs = new Set([env.NOTION_PJ_DB, env.NOTION_TEIREI_DB].filter(Boolean));
  for (const url of sampleUrls.slice(0, 20)) {
    const id = notionPageId(url);
    if (!id) continue;
    const page = await call(env, `/pages/${id}`, "GET").catch(() => null);
    if (!page) continue;
    fromProps(page.properties);
    if (page.parent?.type === "database_id") dbs.add(page.parent.database_id.replace(/-/g, ""));
  }
  for (const db of dbs) {
    let next;
    for (let i = 0; i < 5; i++) {
      const r = await call(env, `/databases/${db}/query`, "POST", { page_size: 100, ...(next ? { start_cursor: next } : {}) }).catch(() => null);
      if (!r) break;
      r.results.forEach((pg) => fromProps(pg.properties));
      if (!r.has_more) break;
      next = r.next_cursor;
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

// ---------- PJのページ：今あるPJページと同じデータベースに「PJ名」のページを作り、参加者を入れ、見出し「議事録」を置く ----------
// データベースは、前のPJのNotionページ（sampleUrl）の親から調べる（NOTION_PJ_DB があればそれを使う）
export async function createProjectPage(env, { name, notionUserIds, sampleUrl }) {
  let dbId = env.NOTION_PJ_DB || "";
  if (!dbId && sampleUrl) {
    const sample = await call(env, `/pages/${notionPageId(sampleUrl)}`, "GET");
    dbId = sample.parent?.type === "database_id" ? sample.parent.database_id : "";
  }
  if (!dbId) return null;
  const db = await call(env, `/databases/${dbId}`, "GET");
  const props = {};
  const entries = Object.entries(db.properties || {});
  const title = entries.find(([, p]) => p.type === "title")?.[0];
  if (title) props[title] = { title: rich(name) };
  // 参加者の欄：人を入れる欄（名前に「参加」「メンバー」があればそれ、なければ最初の欄）
  const people = entries.filter(([, p]) => p.type === "people");
  const who = (people.find(([n]) => /参加|メンバー|member/i.test(n)) || people[0])?.[0];
  if (who && notionUserIds.length) props[who] = { people: notionUserIds.map((id) => ({ object: "user", id })) };
  const page = await call(env, "/pages", "POST", {
    parent: { database_id: dbId }, properties: props,
    children: [{ object: "block", type: "heading_2", heading_2: { rich_text: rich("議事録") } }],
  });
  return page.url;
}

// ---------- 定例の議事録 → 部門の「議事録」データベース ----------
// データベースの欄（タイトル・日付・種類・部門へのリンク）は名前が変わってもいいように、欄の種類で探す
// author：最初に「保存する」を押した人のNotionアカウント（人の欄に入れる）。アイコンは、手で作ったほかの回と同じものにする
export async function createTeireiPage(env, { title, date, children, author = "" }) {
  const db = await call(env, `/databases/${env.NOTION_TEIREI_DB}`, "GET");
  const props = {};
  const who = authorProp(db);
  if (who && author) props[who] = { people: [{ object: "user", id: author }] };
  for (const [name, p] of Object.entries(db.properties || {})) {
    if (p.type === "title") props[name] = { title: rich(title) };
    else if (p.type === "date" && !props.__date) { props[name] = { date: { start: date } }; props.__date = true; }
    else if (p.type === "select" && p.select.options.some((o) => o.name === "定例会議")) props[name] = { select: { name: "定例会議" } };
    else if (p.type === "relation" && env.NOTION_DEPT_PAGE) props[name] = { relation: [{ id: env.NOTION_DEPT_PAGE }] };
  }
  delete props.__date;
  const icon = await teireiIcon(env);
  const page = await call(env, "/pages", "POST", { parent: { database_id: env.NOTION_TEIREI_DB }, properties: props, ...(icon ? { icon } : {}), children: children.slice(0, 100) });
  await appendBlocks(env, page.id, children.slice(100));
  return page.url;
}

// 議事録の「人」の欄（作成者・記録者など）。名前で見つからなければ、人の欄が1つだけのときはそれ
function authorProp(db) {
  const people = Object.entries(db.properties || {}).filter(([, p]) => p.type === "people");
  return (people.find(([n]) => /作成|記録|書記|担当/.test(n)) || (people.length === 1 ? people[0] : null))?.[0] || null;
}

// 手で作ったほかの回のアイコン（同じデータベースの新しいページから、アイコンが付いているもの）
async function teireiIcon(env) {
  const r = await call(env, `/databases/${env.NOTION_TEIREI_DB}/query`, "POST", { page_size: 20, sorts: [{ timestamp: "created_time", direction: "descending" }] });
  const icon = r.results?.map((p) => p.icon).find((i) => i && ["emoji", "external", "custom_emoji"].includes(i.type));
  if (!icon) return null;
  return icon.type === "emoji" ? { type: "emoji", emoji: icon.emoji }
    : icon.type === "external" ? { type: "external", external: { url: icon.external.url } }
    : { type: "custom_emoji", custom_emoji: { id: icon.custom_emoji.id } };
}

// ツールで作った定例の議事録ページに、アイコンと作成者が入っていなければ入れる（前に作ったページも、次に保存したときに直る）
export async function fillTeireiPage(env, pageUrl, author = "") {
  const id = notionPageId(pageUrl);
  if (!id) return;
  const page = await call(env, `/pages/${id}`, "GET");
  const patch = {};
  if (!page.icon) {
    const icon = await teireiIcon(env);
    if (icon) patch.icon = icon;
  }
  const db = await call(env, `/databases/${env.NOTION_TEIREI_DB}`, "GET");
  const who = authorProp(db);
  if (who && author && !(page.properties?.[who]?.people || []).length) patch.properties = { [who]: { people: [{ object: "user", id: author }] } };
  if (Object.keys(patch).length) await call(env, `/pages/${id}`, "PATCH", patch);
}

// 管理者の確認用：定例の議事録データベースの「人」の欄（自動で入る「作成者」の欄は、ツールからは変えられない）
export async function teireiPeopleColumns(env) {
  const db = await call(env, `/databases/${env.NOTION_TEIREI_DB}`, "GET");
  return { people: Object.entries(db.properties || {}).filter(([, p]) => p.type === "people").map(([n]) => n),
    createdBy: Object.entries(db.properties || {}).filter(([, p]) => p.type === "created_by").map(([n]) => n), author: authorProp(db) };
}

// 同じ題名のページがもうあるか（手で作った回を二重に作らない）
export async function findTeireiPage(env, title) {
  const db = await call(env, `/databases/${env.NOTION_TEIREI_DB}`, "GET");
  const titleProp = Object.entries(db.properties || {}).find(([, p]) => p.type === "title")?.[0];
  if (!titleProp) return null;
  const r = await call(env, `/databases/${env.NOTION_TEIREI_DB}/query`, "POST", { filter: { property: titleProp, title: { equals: title } }, page_size: 1 });
  return r.results?.[0]?.url || null;
}

// 定例の議事録の中身：事務連絡／各PJの進捗共有（PJごとのトグル）／ニュース勉強会／意見交換会
export function teireiBlocks({ notice, reports, missing, news, exchange, memo, layout, appUrl }) {
  const section = (label, text) => [heading(label), ...(lines(text).length ? nest(text) : [para("（なし）")])];
  const l = parseLayout(layout);
  const text = { notice, news, exchange };
  const blocks = [];
  for (const k of l.order) {
    if (k === "reports") blocks.push(...reportBlocks(reports, missing));
    else if (FIXED_TITLES[k]) blocks.push(...section(FIXED_TITLES[k], text[k]));
    else blocks.push(...section(l.custom[k].title, l.custom[k].body));
  }
  if (lines(memo).length) blocks.push(...section("📝 メモ", memo));
  if (appUrl) blocks.push(para(`政策立案ツールの議事録：${appUrl}`));
  return blocks; // 100個を超えても切らない（送るときに100個ずつに分ける）
}

function reportBlocks(reports, missing) {
  const blocks = [heading("📊 各PJの進捗共有")];
  for (const r of reports) {
    // トグルの中は1段だけ（Notionに一度に作れる深さのため、字下げはなくす）
    const kids = [];
    for (const [k, label] of [["done", "前回の定例からやったこと"], ["next", "次の定例までにやること"], ["issues", "困っていること・相談したいこと"]]) {
      if (!lines(r[k]).length) continue;
      kids.push(block("paragraph", `**${label}**`));
      kids.push(...lines(r[k]).map((l) => mdBlock(l.trim())));
    }
    blocks.push({ object: "block", type: "toggle", toggle: { rich_text: inline(r.project_name), children: kids.length ? kids.slice(0, 90) : [para("（空欄）")] } });
  }
  for (const p of missing) blocks.push({ object: "block", type: "toggle", toggle: { rich_text: inline(`${p.name}（未記入）`), children: [para("まだ記入されていません")] } });
  if (!reports.length && !missing.length) blocks.push(para("（なし）"));
  return blocks;
}

// 手で作ってあったページに入れるとき：手で書いた中身は残し、ページの最後の「ツールの議事録」の見出しから下だけを書き直す
const MARK = "🔄 政策立案ツールの議事録（ここから下は、ツールで保存するたびに書き直されます）";
export async function replaceToolSection(env, pageUrl, children) {
  const id = notionPageId(pageUrl);
  if (!id) return;
  const all = await listChildren(env, id);
  const at = all.findIndex((b) => b.type === "heading_2" && b.heading_2.rich_text.map((t) => t.plain_text).join("") === MARK);
  // 前回足した区切り線（見出しのすぐ上）と、見出しから下が古い分
  const old = at >= 0 ? all.slice(at > 0 && all[at - 1].type === "divider" ? at - 1 : at) : [];
  const head = [{ object: "block", type: "divider", divider: {} }, { object: "block", type: "heading_2", heading_2: { rich_text: rich(MARK) } }];
  // 先に新しい分を足してから、古い分を消す（途中で失敗しても、空にならないように）
  await appendBlocks(env, id, [...head, ...children]);
  for (const b of old) await call(env, `/blocks/${b.id}`, "DELETE");
}

// parentUrl のページの最後（見出し「議事録」の下）に、新しいページを作る。作ったページのURLを返す
export async function createNotionPage(env, parentUrl, title, children) {
  const parent = notionPageId(parentUrl);
  if (!parent) throw new HttpError(400, "NotionのページのURLが正しくありません");
  const res = await fetch(`${API}/pages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": VERSION, "Content-Type": "application/json" },
    body: JSON.stringify({ parent: { page_id: parent }, properties: { title: { title: rich(title) } }, children: children.slice(0, 100) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("notion create page failed", res.status, data.code);
    if (res.status === 404 || data.code === "object_not_found") {
      throw new HttpError(400, "NotionのPJページが見つかりません。そのページの「…」→「接続」に、政策立案ツールのインテグレーションを追加してください");
    }
    if (res.status === 401) throw new HttpError(500, "Notionのトークンが正しくありません。管理者に連絡してください");
    throw new HttpError(502, "Notionにページを作れませんでした。少し待ってからもう一度試してください");
  }
  // 100個を超えた分は、作ったページの最後に足す
  await appendBlocks(env, data.id, children.slice(100));
  return data.url;
}

// ---------- その他のMTG ----------
// カテゴリーのページ（例：「その他」）の中の「プロジェクト」欄を探す：名前に「プロジェクト」が入ったデータベース（段組みの中も1段見る）
// 見つからなければ、そのページの中に直接ページを作る。ページに入れない（接続されていない）ときは、Notionのエラーをそのまま投げる
export async function findOtherParent(env, pageId) {
  if (!pageId) throw Object.assign(new Error("notion"), { status: 404, code: "object_not_found" });
  await call(env, `/pages/${pageId}`, "GET");
  const dbs = [];
  const walk = async (id, depth) => {
    for (const b of await listChildren(env, id)) {
      if (b.type === "child_database") dbs.push({ id: b.id, title: b.child_database.title || "" });
      else if (depth > 0 && (b.type === "column_list" || b.type === "column")) await walk(b.id, depth - 1);
    }
  };
  await walk(pageId, 2);
  const db = dbs.find((d) => /プロジェクト|project/i.test(d.title));
  return db ? { database_id: db.id, title: db.title } : { page_id: pageId };
}

// プロジェクトのページを作る（中に見出し「議事録」。MTGの議事録はこの下に1回ずつ入る）。作ったページのURLを返す
export async function createGroupPage(env, parent, name) {
  const children = [{ object: "block", type: "heading_2", heading_2: { rich_text: rich("議事録") } }];
  if (parent.database_id) {
    const db = await call(env, `/databases/${parent.database_id}`, "GET");
    const titleProp = Object.entries(db.properties || {}).find(([, p]) => p.type === "title")?.[0] || "title";
    const page = await call(env, "/pages", "POST", { parent: { database_id: parent.database_id }, properties: { [titleProp]: { title: rich(name) } }, children });
    return page.url;
  }
  const page = await call(env, "/pages", "POST", { parent: { page_id: parent.page_id }, properties: { title: { title: rich(name) } }, children });
  return page.url;
}

// 1つの欄の議事録（Markdown）をNotionのブロックにする
export function noteBlocks(md, appUrl = "") {
  const blocks = lines(md).length ? nest(md) : [para("（なし）")];
  if (appUrl) blocks.push(para(`政策立案ツールの議事録：${appUrl}`));
  return blocks;
}
