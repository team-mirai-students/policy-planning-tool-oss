// MTG日程・議事録・ICS
import { HttpError, readJson, clean, longText, reqDateTime, optDate, int, nowJst, shortDateTime } from "../util.js";
import { notifyProject } from "../notify.js";
import { trashStatement, meetingSnapshot } from "./trash.js";
import { ASSIGNEE_COLUMNS, readAssignees, setAssigneeStatements, notifyNewAssignees } from "../task-assignees.js";
import { addDays } from "../project-types.js";
import { regularOccurrences, parseWeekdays } from "../schedule.js";
import { buildIcs, icsResponse, weeklyRule } from "../ics.js";
import { loadProject, requireEditor, assertUsers, canEdit } from "./common.js";
import { notionConfigured, notionPageId, minutesBlocks, exchangeBlocks, createNotionPage, replaceNotionPage, setNotionArchived } from "../notion.js";

export const routes = [
  ["POST", "/api/projects/:id/exchange", startExchange],
  ["POST", "/api/projects/:id/meetings", createMeeting],
  ["GET", "/api/projects/:id/regular.ics", regularIcs],
  ["GET", "/api/meetings/:id", getMeeting],
  ["GET", "/api/ics/series", seriesIcs],
  ["POST", "/api/meetings/:id/notion", createNotionMinutes],
  ["POST", "/api/projects/:id/notion", setProjectNotion],
  ["PATCH", "/api/meetings/:id", updateMeeting],
  ["DELETE", "/api/meetings/:id", deleteMeeting],
  ["PUT", "/api/meetings/:id/minutes", saveMinutes],
  ["GET", "/api/meetings/:id/revisions", listRevisions],
  ["PUT", "/api/meetings/:id/draft", saveDraft],
  ["POST", "/api/meetings/:id/live", liveMinutes],
];

async function createMeeting({ request, env, user, params }) {
  const project = await loadProject(env, params.id);
  await requireEditor(env, user, project.id);
  const body = await readJson(request);
  const row = await env.DB.prepare(
    `INSERT INTO meetings (project_id, starts_at, duration_min, kind, place, created_by, created_at)
     VALUES (?, ?, ?, 'adhoc', ?, ?, ?) RETURNING id`
  ).bind(project.id, reqDateTime(body.starts_at, "日時"),
    int(body.duration_min, { min: 15, max: 480, fallback: project.meeting_duration, label: "MTGの長さ" }),
    clean(body.place, 200) || project.meeting_place, user.id, Date.now()).first();
  await notifyProject(env, project, `MTGが入りました：${shortDateTime(body.starts_at)}`, `#/meetings/${row.id}`, user.id, { dm: true });
  return { id: row.id };
}

async function loadMeeting(env, id) {
  const meeting = await env.DB.prepare("SELECT * FROM meetings WHERE id = ?").bind(id).first();
  if (!meeting) throw new HttpError(404, "MTGが見つかりません");
  return meeting;
}

async function updateMeeting({ request, env, user, params }) {
  const meeting = await loadMeeting(env, params.id);
  await requireEditor(env, user, meeting.project_id);
  const body = await readJson(request);
  const next = { ...meeting };
  if ("starts_at" in body) next.starts_at = reqDateTime(body.starts_at, "日時");
  if ("duration_min" in body) next.duration_min = int(body.duration_min, { min: 15, max: 480, label: "MTGの長さ" });
  if ("place" in body) next.place = clean(body.place, 200);
  if ("cancelled" in body) next.cancelled = body.cancelled ? 1 : 0;
  await env.DB.prepare("UPDATE meetings SET starts_at=?, duration_min=?, place=?, cancelled=? WHERE id=?")
    .bind(next.starts_at, next.duration_min, next.place, next.cancelled, meeting.id).run();
  const project = await loadProject(env, meeting.project_id);
  if (next.cancelled !== meeting.cancelled) {
    await notifyProject(env, project, `${shortDateTime(meeting.starts_at)} のMTGを${next.cancelled ? "中止にしました" : "やることに戻しました"}`, "", user.id, { dm: true });
  } else if (next.starts_at !== meeting.starts_at) {
    await notifyProject(env, project, `MTGの日時が変わりました：${shortDateTime(meeting.starts_at)} → ${shortDateTime(next.starts_at)}`, `#/meetings/${meeting.id}`, user.id, { dm: true });
  }
  return { ok: true };
}

// MTGを削除する。議事録があるとき（間違えて開いた・二重に始めた など）は、with_minutes: true で議事録ごと消す
// （この議事録の「次回までにやること」から作ったタスクも消す）。定例の回は消すと作り直されるので、中止扱いにする
async function deleteMeeting({ request, env, user, params, ctx }) {
  const meeting = await loadMeeting(env, params.id);
  await requireEditor(env, user, meeting.project_id);
  const body = await readJson(request).catch(() => ({}));
  const minute = await env.DB.prepare("SELECT id FROM minutes WHERE meeting_id = ?").bind(meeting.id).first();
  if (minute && !body.with_minutes) throw new HttpError(400, "議事録のあるMTGです。議事録ごと削除してよいか確認してください");
  const stmts = [];
  // 「最近削除した項目」に残す（議事録があるとき・臨時の回を消すとき。定例の回の中止だけなら「中止を取り消す」で戻せる）
  if (minute || meeting.kind !== "regular") {
    stmts.push(trashStatement(env, { kind: "meeting", projectId: meeting.project_id, title: `${shortDateTime(meeting.starts_at)} のMTG${minute ? "（議事録あり）" : ""}`,
      data: await meetingSnapshot(env, meeting), userId: user.id }));
  }
  if (minute) {
    stmts.push(env.DB.prepare("DELETE FROM tasks WHERE source_minute_id = ?").bind(minute.id));
    stmts.push(env.DB.prepare("DELETE FROM minutes WHERE id = ?").bind(minute.id));
  }
  stmts.push(env.DB.prepare("UPDATE checklist_items SET meeting_id = NULL WHERE meeting_id = ?").bind(meeting.id));
  stmts.push(env.DB.prepare("UPDATE schedule_polls SET meeting_id = NULL WHERE meeting_id = ?").bind(meeting.id));
  stmts.push(meeting.kind === "regular"
    ? env.DB.prepare("UPDATE meetings SET cancelled = 1, started_at = NULL WHERE id = ?").bind(meeting.id)
    : env.DB.prepare("DELETE FROM meetings WHERE id = ?").bind(meeting.id));
  await env.DB.batch(stmts);
  // Notionの議事録ページもNotionのゴミ箱へ（「最近削除した項目」から戻すと、Notionも戻る）
  if (meeting.notion_url && notionConfigured(env)) {
    ctx?.waitUntil(setNotionArchived(env, meeting.notion_url, true).catch((err) => console.error("notion archive failed", err?.status, err?.code)));
  }
  // これからのMTGを取りやめたときだけ知らせる（始めてしまったMTG・過ぎたMTGを消したときは知らせない）
  if (!meeting.started_at && meeting.starts_at > nowJst()) {
    const project = await loadProject(env, meeting.project_id);
    await notifyProject(env, project, `${shortDateTime(meeting.starts_at)} のMTGは${meeting.kind === "regular" ? "中止" : "取りやめ"}になりました`, "", user.id, { dm: true });
  }
  return { ok: true };
}

const TASK_COLUMNS = `t.id, t.title, t.status, t.due_date, t.assignee_id, t.notified_assignee, t.version, ${ASSIGNEE_COLUMNS},
  COALESCE((SELECT GROUP_CONCAT(ta.user_id) FROM task_assignees ta WHERE ta.task_id = t.id AND ta.notified = 1), '') AS notified_ids`;

// PJのNotionページ（議事録を作る先）を登録する
async function setProjectNotion({ request, env, user, params }) {
  const project = await loadProject(env, params.id);
  await requireEditor(env, user, project.id);
  const { url } = await readJson(request);
  const clean = String(url || "").trim();
  if (clean && (!/^https:\/\/([a-z0-9-]+\.)*notion\.(so|site|com)\//.test(clean) || !notionPageId(clean))) {
    throw new HttpError(400, "NotionのページのURLを貼ってください（https://www.notion.so/… や https://app.notion.com/p/…）");
  }
  await env.DB.prepare("UPDATE projects SET notion_url = ? WHERE id = ?").bind(clean, project.id).run();
  return { ok: true };
}

// このMTGの議事録を、PJのNotionページ（見出し「議事録」の下）に新しいページとして作る。作ってあれば、そのページを返す
async function createNotionMinutes({ env, user, params, url }) {
  const meeting = await loadMeeting(env, params.id);
  const project = await loadProject(env, meeting.project_id);
  await requireEditor(env, user, project.id);
  if (meeting.notion_url) return { url: meeting.notion_url, existed: true };
  if (!notionConfigured(env)) throw new HttpError(400, "Notion連携がまだ設定されていません（管理者がNotionのトークンを入れると使えます）");
  if (!project.notion_url) throw new HttpError(400, "このPJのNotionページが登録されていません");
  const { title, blocks } = await notionMinutes(env, meeting, project, url);
  const pageUrl = await createNotionPage(env, project.notion_url, title, blocks);
  await env.DB.prepare("UPDATE meetings SET notion_url = ? WHERE id = ?").bind(pageUrl, meeting.id).run();
  return { url: pageUrl };
}

// Notionに書く議事録（題名と中身）
async function notionMinutes(env, meeting, project) {
  const minute = await env.DB.prepare("SELECT * FROM minutes WHERE meeting_id = ?").bind(meeting.id).first();
  const prev = await env.DB.prepare(
    `SELECT n.id FROM minutes n JOIN meetings m ON m.id = n.meeting_id WHERE n.project_id = ? AND m.starts_at < ? AND m.kind != 'exchange' ORDER BY m.starts_at DESC LIMIT 1`
  ).bind(project.id, meeting.starts_at).first();
  const tasksOf = (minuteId) => env.DB.prepare(
    `SELECT ${TASK_COLUMNS} FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.source_minute_id = ? ORDER BY t.id`
  ).bind(minuteId).all().then((r) => r.results);
  const [homework, todos] = await Promise.all([prev ? tasksOf(prev.id) : [], minute ? tasksOf(minute.id) : []]);
  const d = meeting.starts_at;
  const appUrl = env.APP_URL ? `${env.APP_URL}/#/meetings/${meeting.id}?mode=view` : "";
  if (meeting.kind === "exchange") {
    return { title: `${d.slice(0, 4)}/${d.slice(5, 7)}/${d.slice(8, 10)} 意見交換会 議事録`, blocks: exchangeBlocks({ summary: minute?.summary, docUrl: project.memo_doc_url, appUrl }) };
  }
  const title = `${d.slice(0, 4)}/${d.slice(5, 7)}/${d.slice(8, 10)} MTG議事録`;
  return { title, blocks: minutesBlocks({ homework, agenda: minute?.agenda, summary: minute?.summary, todos, appUrl }) };
}

// 議事録を保存したら、Notionの「議事録」にも自動で入れる（1回目は新しいページを作る。2回目からは同じページを書き直す）
// Notionの返事を待たずに保存は終わる。失敗しても保存はそのまま（ログだけ残す）
export async function syncNotion(env, meetingId) {
  const meeting = await loadMeeting(env, meetingId);
  const project = await loadProject(env, meeting.project_id);
  if (!notionConfigured(env) || !project.notion_url) return;
  const { title, blocks } = await notionMinutes(env, meeting, project);
  if (meeting.notion_url) return replaceNotionPage(env, meeting.notion_url, title, blocks);
  const pageUrl = await createNotionPage(env, project.notion_url, title, blocks);
  await env.DB.prepare("UPDATE meetings SET notion_url = ? WHERE id = ? AND (notion_url IS NULL OR notion_url = '')").bind(pageUrl, meeting.id).run();
}

// 下書き：次回の日程・MTGの進め方の選びかけ（お知らせは送らない。決まるのは「保存する」「決める」のとき）
async function saveDraft({ request, env, user, params }) {
  const meeting = await loadMeeting(env, params.id);
  await requireEditor(env, user, meeting.project_id);
  const d = (await readJson(request)).draft || {};
  const dt = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? v : "");
  const plan = d.plan && typeof d.plan === "object" ? {
    mode: d.plan.mode === "regular" ? "regular" : "adhoc",
    weekdays: (Array.isArray(d.plan.weekdays) ? d.plan.weekdays : []).map(String).filter((w) => /^[0-6]$/.test(w)).slice(0, 7),
    time: typeof d.plan.time === "string" && /^\d{2}:\d{2}$/.test(d.plan.time) ? d.plan.time : "",
    interval: d.plan.interval === 2 || d.plan.interval === "2" ? 2 : 1,
  } : null;
  const draft = { next_starts_at: dt(d.next_starts_at), next_place: clean(d.next_place, 200), ...(plan ? { plan } : {}) };
  await env.DB.prepare("UPDATE meetings SET draft = ? WHERE id = ?").bind(JSON.stringify(draft), meeting.id).run();
  return { ok: true };
}

async function getMeeting({ env, user, params }) {
  const meeting = await loadMeeting(env, params.id);
  const project = await loadProject(env, meeting.project_id);
  const minute = await env.DB.prepare(
    `SELECT n.*, u.name AS updated_by_name FROM minutes n LEFT JOIN users u ON u.id = n.updated_by WHERE n.meeting_id = ?`
  ).bind(meeting.id).first();

  // 前回の議事録の「次回までにやること」＝今回の宿題
  const prev = await env.DB.prepare(
    `SELECT n.id, m.starts_at FROM minutes n JOIN meetings m ON m.id = n.meeting_id
     WHERE n.project_id = ? AND m.starts_at < ? AND m.kind != 'exchange' ORDER BY m.starts_at DESC LIMIT 1`
  ).bind(project.id, meeting.starts_at).first();
  const tasksOf = (minuteId) =>
    env.DB.prepare(`SELECT ${TASK_COLUMNS} FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.source_minute_id = ? ORDER BY t.id`).bind(minuteId).all().then((r) => r.results);

  // このPJの初回のMTGか（中止していないMTGのうち、いちばん早いもの）。初回だけPMを決められる
  const earlier = await env.DB.prepare(
    "SELECT 1 FROM meetings WHERE project_id = ?1 AND cancelled = 0 AND kind != 'exchange' AND id != ?3 AND (starts_at < ?2 OR (starts_at = ?2 AND id < ?3)) LIMIT 1"
  ).bind(project.id, meeting.starts_at, meeting.id).first();
  const [members, homework, todos, nextMeeting, checklist] = await Promise.all([
    env.DB.prepare(
      `SELECT u.id, u.name, u.avatar FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? ORDER BY u.name`
    ).bind(project.id).all().then((r) => r.results),
    prev ? tasksOf(prev.id) : [],
    minute ? tasksOf(minute.id) : [],
    nextMeetingAfter(env, project.id, meeting.starts_at),
    // いまの工程のチェックリストと、このMTGに結び付いた項目（ほかの工程のものも）
    env.DB.prepare(
      `SELECT c.id, c.stage_no, c.label, c.hint, c.done_at, c.skipped_at, c.notify_leaders, c.meeting_id, m.starts_at AS meeting_starts_at
       FROM checklist_items c LEFT JOIN meetings m ON m.id = c.meeting_id
       WHERE c.project_id = ?1 AND (c.stage_no = ?2 OR c.meeting_id = ?3) ORDER BY c.stage_no, c.sort, c.id`
    ).bind(project.id, project.current_stage, meeting.id).all().then((r) => r.results),
  ]);
  // 意見交換会の議事録は、部門のだれでも書ける（PJの外の人も話すので）
  const canEdit = user.isAdmin || meeting.kind === "exchange" || members.some((m) => m.id === user.id);
  return {
    meeting, minute, members, canEdit,
    isFirst: !earlier,
    notion: notionConfigured(env),
    project: { id: project.id, name: project.name, type: project.type, memo_doc_url: project.memo_doc_url, meeting_mode: project.meeting_mode, current_stage: project.current_stage, pm_id: project.pm_id, notion_url: project.notion_url, meeting_weekdays: project.meeting_weekdays, meeting_time: project.meeting_time, meeting_interval: project.meeting_interval },
    previous: prev ? { starts_at: prev.starts_at, homework } : null,
    todos,
    nextMeeting,
    checklist,
  };
}

function nextMeetingAfter(env, projectId, startsAt) {
  return env.DB.prepare(
    "SELECT id, starts_at, place, kind FROM meetings WHERE project_id = ? AND cancelled = 0 AND kind != 'exchange' AND starts_at > ? ORDER BY starts_at LIMIT 1"
  ).bind(projectId, startsAt).first();
}

// ---------- 議事録の同時編集 ----------
// 書いた内容は数秒ごとに自動で保存され、同じ議事録を開いているほかの人の画面にも数秒で出る。
// 同じ項目を2人が同時に書いて内容がぶつからないよう、項目ごとに「いま書いている人」を1人にする
const LIVE_FIELDS = ["agenda", "summary", "todos"];
const LIVE_TTL = 12000; // この時間、合図がなければ「もう書いていない／開いていない」とみなす

// 自分が書ける項目なら押さえる（すでに自分のもの・空き・古いものは取れる）。取れなければ、書いている人を返す
async function claimField(env, meetingId, field, user, now) {
  await env.DB.prepare(
    `INSERT INTO minute_editors (meeting_id, field, user_id, seen_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(meeting_id, field) DO UPDATE SET user_id = excluded.user_id, seen_at = excluded.seen_at
     WHERE minute_editors.user_id = excluded.user_id OR minute_editors.seen_at < ?5`
  ).bind(meetingId, field, user.id, now, now - LIVE_TTL).run();
  const holder = await env.DB.prepare(
    "SELECT e.user_id, u.name FROM minute_editors e LEFT JOIN users u ON u.id = e.user_id WHERE e.meeting_id = ? AND e.field = ?"
  ).bind(meetingId, field).first();
  return holder && holder.user_id !== user.id ? holder : null;
}

// 同じ欄を別々に変えたとき：自分だけが変えたなら自分の、相手だけなら相手の内容。両方なら両方を残す（同じ行は二重にしない）
function mergeText(base, mine, theirs) {
  base = base || ""; mine = mine || ""; theirs = theirs || "";
  if (mine === theirs || theirs === base) return { text: mine, both: false };
  if (mine === base) return { text: theirs, both: false };
  if (mine.includes(theirs)) return { text: mine, both: false };
  if (theirs.includes(mine)) return { text: theirs, both: false };
  // 両方が書き足したとき：自分の内容のあとに、相手の内容のうち自分の方にない行を足す（同じ行は二重にしない）
  const have = new Set(mine.split("\n").map((l) => l.trim()));
  const extra = theirs.split("\n").filter((l) => l.trim() && !have.has(l.trim()));
  return { text: extra.length ? `${mine}\n${extra.join("\n")}` : mine, both: true };
}

// 履歴を残す：同じ人が続けて書いている間（2分以内）は同じ行を書き直し、それ以外は新しい行にする。
// 履歴がまだない欄は、書き換える前の内容も1行残す（この仕組みより前に書かれた内容を守るため）
const REVISION_GAP = 120000;
async function keepRevision(env, meetingId, field, text, userId, now, current, force = false) {
  const last = await env.DB.prepare(
    "SELECT id, body, user_id, updated_at FROM minute_revisions WHERE meeting_id = ? AND field = ? ORDER BY updated_at DESC, id DESC LIMIT 1"
  ).bind(meetingId, field).first();
  if (last && last.body === text) return;
  if (!last && current?.[field] && current[field] !== text) {
    await env.DB.prepare("INSERT INTO minute_revisions (meeting_id, field, body, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(meetingId, field, current[field], current.updated_by, current.updated_at, current.updated_at).run();
  }
  if (!text.trim()) return; // 空にしたときは、その前の内容が履歴に残っている
  if (!force && last && last.user_id === userId && now - last.updated_at < REVISION_GAP && !(last.body.length > 20 && text.length < last.body.length / 2)) {
    await env.DB.prepare("UPDATE minute_revisions SET body = ?, updated_at = ? WHERE id = ?").bind(text, now, last.id).run();
  } else {
    await env.DB.prepare("INSERT INTO minute_revisions (meeting_id, field, body, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(meetingId, field, text, userId, now, now).run();
  }
}

// 議事録の文章の履歴（新しい順）。PJメンバーと管理者が見て、戻せる
async function listRevisions({ env, user, params, url }) {
  const meeting = await loadMeeting(env, params.id);
  await requireMinutesEditor(env, user, meeting);
  const field = ["agenda", "summary"].includes(url.searchParams.get("field")) ? url.searchParams.get("field") : "summary";
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.body, r.created_at, r.updated_at, u.name FROM minute_revisions r LEFT JOIN users u ON u.id = r.user_id
     WHERE r.meeting_id = ? AND r.field = ? ORDER BY r.updated_at DESC, r.id DESC LIMIT 100`
  ).bind(meeting.id, field).all();
  return { revisions: results };
}

const MINUTES_MAX = 50000; // 議事録の1つの欄の上限（字）
const TODOS_MAX = 100; // 「次回までにやること」の上限（件）

// 議事録を保存する。送られてきた項目だけを書き換える（自動保存は1項目ずつ送る）
async function saveMinutes({ request, env, user, params, ctx }) {
  const meeting = await loadMeeting(env, params.id);
  await requireMinutesEditor(env, user, meeting);
  const project = await loadProject(env, meeting.project_id);
  const body = await readJson(request);
  const now = Date.now();
  const sent = LIVE_FIELDS.filter((f) => f in body);
  // ロックはしない（同時に書いても、文章は下の base で、やることは known_ids で両方残す）。「〇〇さんも書いています」の表示のためだけに記録する
  for (const f of sent) await claimField(env, meeting.id, f, user, now);
  const cols = [];
  if ("agenda" in body) cols.push(["agenda", longText(body.agenda, MINUTES_MAX, "今回話し合うこと")]);
  if ("summary" in body) cols.push(["summary", longText(body.summary, MINUTES_MAX, "話し合いの概要")]);
  // base：送った人の画面が最後に知っていた内容。そのあとDBの内容が変わっていたら（ほかの人の保存・古い画面からの保存）、
  // 上書きして消さずに両方を残す。merged：両方を残した項目 → その内容（画面に映し直す）
  const merged = {};
  const base = body.base && typeof body.base === "object" ? body.base : null;
  let minuteId;
  let current = null;
  if (cols.length) {
    // 読んでから書くまでのあいだに、ほかの人の保存が入ることがある。版（version）が読んだときと同じときだけ書き、
    // 違っていたら読み直して合わせ直す（同時に保存しても、どちらの内容も消えない）
    const names = cols.map(([c]) => c);
    for (let attempt = 0; ; attempt++) {
      current = await env.DB.prepare("SELECT id, agenda, summary, updated_by, updated_at, version FROM minutes WHERE meeting_id = ?").bind(meeting.id).first();
      const values = cols.map(([name, mine]) => (base && current && typeof base[name] === "string" ? mergeText(String(base[name]), mine, current[name]).text : mine));
      let done = false;
      if (!current) {
        const row = await env.DB.prepare(
          `INSERT INTO minutes (meeting_id, project_id, ${names.join(", ")}, created_by, updated_by, created_at, updated_at)
           VALUES (?, ?, ${names.map(() => "?").join(", ")}, ?, ?, ?, ?) ON CONFLICT(meeting_id) DO NOTHING RETURNING id`
        ).bind(meeting.id, project.id, ...values, user.id, user.id, now, now).first();
        if (row) { minuteId = row.id; done = true; }
      } else {
        const r = await env.DB.prepare(
          `UPDATE minutes SET ${names.map((c) => `${c} = ?`).join(", ")}, updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?`
        ).bind(...values, user.id, now, current.id, current.version).run();
        if (r.meta.changes === 1) { minuteId = current.id; done = true; }
      }
      if (done) {
        cols.forEach((c, i) => { if (values[i] !== c[1]) merged[c[0]] = values[i]; c[1] = values[i]; });
        break;
      }
      if (attempt >= 6) throw new HttpError(503, "ほかの人の保存と重なりました。自動でもう一度保存します");
    }
  } else {
    // 文章を送っていない（やることだけ・お知らせだけ）：議事録がなければ作る
    const row = await env.DB.prepare(
      `INSERT INTO minutes (meeting_id, project_id, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(meeting_id) DO UPDATE SET updated_by = excluded.updated_by, updated_at = excluded.updated_at, version = version + 1
       RETURNING id`
    ).bind(meeting.id, project.id, user.id, user.id, now, now).first();
    minuteId = row.id;
  }
  // restore：履歴から戻したとき。戻す前の内容が消えないよう、必ず新しい行にする
  for (const [field, text] of cols) await keepRevision(env, meeting.id, field, text, user.id, now, current, Boolean(body.restore));

  // 「次回までにやること」をタスクとして同期する（この議事録から作ったタスクだけが対象）
  // key：画面の行の目印。新しく作ったタスクの id を、どの行のものか返す（次の自動保存で同じタスクを二重に作らないため）
  const ids = {};
  if ("todos" in body) {
    const list = Array.isArray(body.todos) ? body.todos : [];
    if (list.length > TODOS_MAX) throw new HttpError(400, `「次回までにやること」が多すぎます（${TODOS_MAX}件まで）`);
    const rows = list.map((t) => ({
      key: typeof t.key === "string" ? t.key.slice(0, 40) : "",
      id: t.id ? int(t.id, { label: "タスク" }) : null,
      title: clean(t.title, 120),
      assignee_ids: readAssignees(t),
      due_date: optDate(t.due_date, "期限"),
      // changed：この画面で書き換えた行（false の行は、ほかの人の変更を古い内容で上書きしないよう書き直さない）
      changed: t.changed !== false,
    }));
    // 題名を消しただけの行（書き直している途中）は、タスクを消さずにそのまま残す
    const keep = new Set(rows.filter((t) => t.id).map((t) => t.id));
    const todos = rows.filter((t) => t.title);
    await assertUsers(env, todos.flatMap((t) => t.assignee_ids));
    for (const t of todos) t.assignee_id = t.assignee_ids[0] || null;
    const { results: current } = await env.DB.prepare("SELECT id, assignee_id, title, created_by FROM tasks WHERE source_minute_id = ?").bind(minuteId).all();
    // known_ids：この画面が知っているタスク。消すのは「知っていて、一覧から外した」ものだけ（ほかの人があとから足したタスクは消さない）
    const known = Array.isArray(body.known_ids) ? new Set(body.known_ids.map(Number)) : null;
    const currentIds = new Set(current.map((r) => r.id));
    const stmts = [];
    for (const r of current) {
      if (!keep.has(r.id) && (!known || known.has(r.id))) stmts.push(env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(r.id));
    }
    const update = todos.filter((t) => t.id && currentIds.has(t.id) && t.changed);
    for (const t of update) {
      stmts.push(env.DB.prepare(
        "UPDATE tasks SET title=?, assignee_id=?, due_date=?, updated_at=?, version = version + 1 WHERE id = ?"
      ).bind(t.title, t.assignee_id, t.due_date, now, t.id));
      stmts.push(...setAssigneeStatements(env, t.id, t.assignee_ids));
    }
    if (stmts.length) await env.DB.batch(stmts);
    // ほかの人が消した行で、この画面では触っていないものは作り直さない（書き換えていた行は、消えないよう作り直す）
    for (let i = todos.length - 1; i >= 0; i--) if (todos[i].id && !currentIds.has(todos[i].id) && !todos[i].changed) todos.splice(i, 1);
    // 前に送った新しい行の返事が届かず、送り直してきたとき：同じ人が作った同じ題名の、この画面がまだ知らないタスクがあれば、それを使う（二重に作らない）
    const unknownRows = known ? current.filter((r) => !keep.has(r.id) && !known.has(r.id) && r.created_by === user.id) : [];
    for (const t of todos) {
      if (t.id && currentIds.has(t.id)) continue;
      const dup = !t.id && unknownRows.find((r) => r.title === t.title);
      if (dup) {
        unknownRows.splice(unknownRows.indexOf(dup), 1);
        if (t.key) ids[t.key] = dup.id;
        t.id = dup.id;
        continue;
      }
      const created = await env.DB.prepare(
        `INSERT INTO tasks (project_id, stage_no, title, assignee_id, due_date, status, source_minute_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?) RETURNING id`
      ).bind(project.id, project.current_stage, t.title, t.assignee_id, t.due_date, minuteId, user.id, now, now).first();
      if (t.key) ids[t.key] = created.id;
      t.id = created.id;
      await env.DB.batch(setAssigneeStatements(env, created.id, t.assignee_ids));
    }
  }
  // 「次回までにやること」の担当のお知らせ：自動保存のたびには送らず、「保存する」「MTGを終える」のとき（notify_todos）にまとめて送る
  if (body.notify_todos) {
    const { results: pending } = await env.DB.prepare(
      "SELECT DISTINCT ta.task_id FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id WHERE t.source_minute_id = ? AND ta.notified = 0"
    ).bind(minuteId).all();
    for (const t of pending) await notifyNewAssignees(env, project, t.task_id);
  }

  // 毎回決めるPJ：議事録と一緒に送られた次回の日程を登録する（すでに次回があれば、その日時・場所を直す）
  let nextStartsAt = null;
  if (body.next_meeting && body.next_meeting.starts_at) {
    nextStartsAt = reqDateTime(body.next_meeting.starts_at, "次回の日時");
    if (nextStartsAt <= meeting.starts_at) throw new HttpError(400, "次回の日時は、このMTGより後にしてください");
    const place = clean(body.next_meeting.place, 200);
    const next = await nextMeetingAfter(env, project.id, meeting.starts_at);
    if (next && next.kind === "adhoc") {
      await env.DB.prepare("UPDATE meetings SET starts_at = ?, place = ? WHERE id = ?").bind(nextStartsAt, place, next.id).run();
      if (next.starts_at !== nextStartsAt) {
        await notifyProject(env, project, `次回MTGの日時が変わりました：${shortDateTime(next.starts_at)} → ${shortDateTime(nextStartsAt)}`, "", user.id, { dm: true });
      }
    } else if (!next || next.starts_at !== nextStartsAt) {
      await env.DB.prepare(
        `INSERT INTO meetings (project_id, starts_at, duration_min, kind, place, created_by, created_at) VALUES (?, ?, ?, 'adhoc', ?, ?, ?)`
      ).bind(project.id, nextStartsAt, project.meeting_duration, place, user.id, now).run();
      await notifyProject(env, project, `次回MTGが決まりました：${shortDateTime(nextStartsAt)}`, "", user.id, { dm: true });
    }
  }
  // 保存ボタン（body.notion）のときだけ。1秒ごとの自動保存では送らない
  const notion = Boolean(body.notion) && notionConfigured(env) && Boolean(project.notion_url);
  if (notion) ctx?.waitUntil(syncNotion(env, meeting.id).catch((err) => console.error("notion sync failed", err?.status, err?.code || err?.message)));
  return { ok: true, nextMeeting: nextStartsAt, ids, notion, merged };
}

// 議事録を開いているあいだ、数秒ごとに呼ぶ。field：いま自分が書いている項目（なければ null）
// 返すもの：議事録の最新の内容・宿題の完了状況・項目ごとに書いている人・開いている人
async function liveMinutes({ request, env, user, params }) {
  const meeting = await loadMeeting(env, params.id);
  const body = await readJson(request);
  const now = Date.now();
  const editable = meeting.kind === "exchange" || await canEdit(env, user, meeting.project_id);
  const field = editable && LIVE_FIELDS.includes(body.field) ? body.field : null;
  // MTGを始めた時刻（タイマーの起点）。書く画面で開いたときに記録し、4時間たっていたら始め直しとみなす
  if (editable && body.start) {
    await env.DB.prepare("UPDATE meetings SET started_at = ?1 WHERE id = ?2 AND (started_at IS NULL OR started_at < ?1 - 14400000)")
      .bind(now, meeting.id).run();
  }
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO minute_viewers (meeting_id, user_id, seen_at) VALUES (?, ?, ?)
       ON CONFLICT(meeting_id, user_id) DO UPDATE SET seen_at = excluded.seen_at`
    ).bind(meeting.id, user.id, now),
    // 書くのをやめた項目は手放す
    env.DB.prepare("DELETE FROM minute_editors WHERE meeting_id = ? AND user_id = ? AND field != ?").bind(meeting.id, user.id, field || ""),
    env.DB.prepare("DELETE FROM minute_viewers WHERE meeting_id = ? AND seen_at < ?").bind(meeting.id, now - 86400000),
  ]);
  const blockedBy = field ? await claimField(env, meeting.id, field, user, now) : null;

  const fresh = now - LIVE_TTL;
  const [minute, editors, viewers, prev] = await Promise.all([
    env.DB.prepare(
      `SELECT n.id, n.agenda, n.summary, n.updated_at, u.name AS updated_by_name FROM minutes n LEFT JOIN users u ON u.id = n.updated_by WHERE n.meeting_id = ?`
    ).bind(meeting.id).first(),
    env.DB.prepare(
      `SELECT e.field, e.user_id, u.name FROM minute_editors e LEFT JOIN users u ON u.id = e.user_id WHERE e.meeting_id = ? AND e.seen_at >= ?`
    ).bind(meeting.id, fresh).all().then((r) => r.results),
    env.DB.prepare(
      `SELECT v.user_id, u.name FROM minute_viewers v LEFT JOIN users u ON u.id = v.user_id WHERE v.meeting_id = ? AND v.seen_at >= ? ORDER BY u.name`
    ).bind(meeting.id, fresh).all().then((r) => r.results),
    env.DB.prepare(
      `SELECT n.id FROM minutes n JOIN meetings m ON m.id = n.meeting_id
       WHERE n.project_id = ? AND m.starts_at < ? AND m.kind != 'exchange' ORDER BY m.starts_at DESC LIMIT 1`
    ).bind(meeting.project_id, meeting.starts_at).first(),
  ]);
  const tasksOf = (minuteId) => env.DB.prepare(
    `SELECT ${TASK_COLUMNS} FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.source_minute_id = ? ORDER BY t.id`
  ).bind(minuteId).all().then((r) => r.results);
  const [todos, homework] = await Promise.all([minute ? tasksOf(minute.id) : [], prev ? tasksOf(prev.id) : []]);
  return {
    minute: minute ? { agenda: minute.agenda, summary: minute.summary, updated_at: minute.updated_at, updated_by_name: minute.updated_by_name } : null,
    todos,
    homework: homework.map((t) => ({ id: t.id, status: t.status })),
    editors: editors.filter((e) => e.user_id !== user.id),
    viewers: viewers.filter((v) => v.user_id !== user.id).map((v) => v.name),
    blocked: blockedBy ? blockedBy.name || "ほかの人" : null,
    started_at: body.start ? (await env.DB.prepare("SELECT started_at FROM meetings WHERE id = ?").bind(meeting.id).first())?.started_at : null,
  };
}

// 定例MTGを繰り返し予定として1件で入れるためのICS
// くり返しの予定を1つ書いたカレンダーファイル（スマホで開くと、くり返しのまま取り込める）
async function seriesIcs({ url }) {
  const q = url.searchParams;
  const start = q.get("start") || "";
  const rrule = q.get("rrule") || "";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(start)) throw new HttpError(400, "日時が正しくありません");
  if (!/^FREQ=WEEKLY;INTERVAL=[1-4];WKST=SU;BYDAY=(SU|MO|TU|WE|TH|FR|SA)(,(SU|MO|TU|WE|TH|FR|SA))*(;UNTIL=\d{8}T\d{6}Z)?$/.test(rrule)) {
    throw new HttpError(400, "くり返しの指定が正しくありません");
  }
  const body = buildIcs([{
    uid: `series-${start.replace(/\D/g, "")}-${rrule.replace(/\W/g, "")}@policy-planning`,
    start,
    durationMin: int(q.get("dur"), { min: 5, max: 600, fallback: 60, label: "長さ" }),
    title: clean(q.get("title"), 120) || "定例",
    location: clean(q.get("loc"), 200),
    rrule,
  }]);
  return icsResponse(body, "teirei.ics");
}

async function regularIcs({ env, params }) {
  const project = await loadProject(env, params.id);
  const weekdays = parseWeekdays(project.meeting_weekdays);
  if (project.meeting_mode !== "regular" || !weekdays.length) throw new HttpError(400, "このPJは定例MTGが設定されていません");
  const today = nowJst().slice(0, 10);
  const from = project.start_date > today ? project.start_date : today;
  const [first] = regularOccurrences(
    { weekdays, time: project.meeting_time, interval: project.meeting_interval, anchor: project.start_date },
    from, addDays(from, 7 * project.meeting_interval + 6)
  );
  const body = buildIcs([{
    uid: `regular-${project.id}@policy-planning`,
    start: first,
    durationMin: project.meeting_duration,
    title: `${project.name} 定例MTG`,
    location: project.meeting_place,
    rrule: weeklyRule(weekdays, project.meeting_interval),
  }]);
  return icsResponse(body, `regular-${project.id}.ics`);
}

// 議事録を書けるか：PJメンバーと管理者。意見交換会は部門のだれでも
async function requireMinutesEditor(env, user, meeting) {
  if (meeting.kind === "exchange") return;
  await requireEditor(env, user, meeting.project_id);
}

// 定例イベントの意見交換会：どのPJの意見交換会かを選んで始める。PJのMTG（種類：意見交換会）として、PJの議事録と同じ場所に残る
async function startExchange({ request, env, user, params }) {
  const project = await loadProject(env, params.id);
  const body = await readJson(request);
  const startsAt = typeof body.starts_at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(body.starts_at) ? body.starts_at : null;
  if (!startsAt) throw new HttpError(400, "日時が正しくありません");
  const row = await env.DB.prepare(
    `INSERT INTO meetings (project_id, starts_at, duration_min, kind, place, created_by, created_at) VALUES (?, ?, 60, 'exchange', '', ?, ?) RETURNING id`
  ).bind(project.id, startsAt, user.id, Date.now()).first();
  return { id: row.id };
}
