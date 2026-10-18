// 部門の定例：事務連絡（部門長・副部門長）・各PJの進捗共有（PJメンバー）・メモ・定例のあとのイベント
import { HttpError, readJson, clean, int, oneOf, assertUpdated, todayJst, reqDate, reqDateTime, longText } from "../util.js";
import { addDays } from "../project-types.js";
import { regularOccurrences } from "../schedule.js";
import { loadProject, requireAdmin, requireEditor } from "./common.js";
import { cleanLayout } from "../teirei-layout.js";
import { notionConfigured, fillTeireiPage, createTeireiPage, findTeireiPage, replaceNotionPage, replaceToolSection, teireiBlocks } from "../notion.js";

export const routes = [
  ["GET", "/api/dept-meetings", listDeptMeetings],
  ["POST", "/api/dept-meetings", startDeptMeeting],
  ["GET", "/api/dept-meetings/:id", getDeptMeeting],
  ["PATCH", "/api/dept-meetings/:id", updateDeptMeeting],
  ["GET", "/api/dept-reports", listReportTargets],
  ["GET", "/api/projects/:id/dept-report", getReport],
  ["PUT", "/api/projects/:id/dept-report", saveReport],
  ["GET", "/api/dept-notice", getNotice],
  ["PUT", "/api/dept-notice", saveNotice],
  ["GET", "/api/dept-schedules", listSchedules],
  ["POST", "/api/dept-schedules", createSchedule],
  ["DELETE", "/api/dept-schedules/:id", deleteSchedule],
  ["GET", "/api/teirei-targets", listTeireiTargets],
  ["GET", "/api/dept-event", getEvent],
  ["PUT", "/api/dept-event", saveEvent],
];

const EVENTS = ["news", "exchange"]; // ニュース勉強会・意見交換会
const EVENT_LABELS = { news: "ニュース勉強会", exchange: "意見交換会" };
// 定例の前に書いておける欄（事務連絡・ニュース勉強会・意見交換会）
const NOTE_FIELDS = ["notice", "news", "exchange"];

// 定例の「日付」：夜の定例（22時〜翌1時など）が日付をまたいでも同じ日の定例として続くよう、朝6時で切り替える
const TEIREI_DAY_STARTS_AT = 6;
const teireiDay = () => todayJst(Date.now() - TEIREI_DAY_STARTS_AT * 3600 * 1000);

// 進行中の定例（または「定例を始める」で前もって作った次回の定例）：終えていない、今日以降でいちばん近いもの
// 進捗共有はここに入る。なければ次の定例に向けたもの（始めたときにまとめる）
async function openMeeting(env) {
  return env.DB.prepare("SELECT id, held_on FROM dept_meetings WHERE held_on >= ? AND ended_at IS NULL ORDER BY held_on LIMIT 1")
    .bind(teireiDay()).first();
}

// 状態：進行中（今日の定例）／準備中（前もって作った先の定例）
const withState = (m, today) => ({ ...m, is_open: !m.ended_at && m.held_on === today, is_ready: !m.ended_at && m.held_on > today });
// 第◯回（Notionの議事録の回数と同じ数え方）
const firstNumber = (env) => Number(env.TEIREI_FIRST_NUMBER) || 1;
// PJのメンバーの名前（「A・B・C」）
const MEMBER_NAMES = "(SELECT GROUP_CONCAT(mu.name, '・') FROM project_members pm JOIN users mu ON mu.id = pm.user_id WHERE pm.project_id = p.id)";
const NUMBER_SQL = "(SELECT COUNT(*) FROM dept_meetings x WHERE x.held_on < d.held_on)";

async function listDeptMeetings({ env }) {
  const [{ results }, drafts] = await Promise.all([
    env.DB.prepare(
      `SELECT d.id, d.held_on, d.starts_at, d.event, d.ended_at, (SELECT COUNT(*) FROM dept_reports r WHERE r.dept_meeting_id = d.id) AS reports,
              ${NUMBER_SQL} + ? AS number
       FROM dept_meetings d ORDER BY d.held_on DESC LIMIT 50`
    ).bind(firstNumber(env)).all(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM dept_reports WHERE dept_meeting_id IS NULL").first(),
  ]);
  // 進行中＝今日の定例で、まだ「定例を終わる」を押していないもの（押し忘れた過去の定例は終わった扱い）
  const today = teireiDay();
  return { today, meetings: results.map((m) => withState(m, today)), drafts: drafts.n };
}

// 定例を作る（すでにあればそれを開く）。starts_at があれば予定の日時、なければ予定外で今日。
// 次の定例に向けて書かれていた進捗共有・事務連絡を、この定例にまとめる
async function startDeptMeeting({ request, env, user }) {
  requireAdmin(user, "定例を始められるのは、部門長・副部門長です");
  const body = await readJson(request).catch(() => ({}));
  const startsAt = body.starts_at ? reqDateTime(body.starts_at, "定例の日時") : null;
  const heldOn = startsAt ? startsAt.slice(0, 10) : teireiDay();
  if (heldOn < teireiDay()) throw new HttpError(400, "過ぎた日の定例は始められません");
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO dept_meetings (held_on, starts_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(heldOn, startsAt, user.id, now, now).run();
  const meeting = await env.DB.prepare("SELECT id, ended_at FROM dept_meetings WHERE held_on = ?").bind(heldOn).first();
  if (!meeting.ended_at) await env.DB.batch(collectStatements(env, meeting.id, heldOn, now));
  return { id: meeting.id };
}

// 次の定例に向けて書かれていた進捗共有と事務連絡を、この定例にまとめる（定例を始める・再開するとき）
function collectStatements(env, meetingId, heldOn, now) {
  // 書き置きの事務連絡を、この定例の事務連絡に移して空にする（定例側にすでに書いてあれば後ろに足す）
  const moveNotice = (src, where) => NOTE_FIELDS.map((f) => {
    const from = `SELECT ${f} FROM ${src} WHERE ${where}`;
    return `${f} = CASE WHEN COALESCE((${from}), '') = '' THEN ${f} WHEN ${f} = '' THEN (${from}) ELSE ${f} || char(10) || (${from}) END`;
  }).join(", ");
  const moveLayout = (src, where) => `layout = CASE WHEN COALESCE((SELECT layout FROM ${src} WHERE ${where}), '') = '' OR layout != '' THEN layout ELSE (SELECT layout FROM ${src} WHERE ${where}) END`;
  const move = (src, where) => env.DB.prepare(`UPDATE dept_meetings SET ${moveNotice(src, where)}, ${moveLayout(src, where)}, version = version + 1 WHERE id = ?1`);
  // 進捗共有の書き置き：この日に向けて書いたもの（held_on = その日）と、日を決めずに書いたもの（held_on = ''）
  // 同じPJで両方あれば、日を決めずに書いたほうを、この日に向けて書いたほうの後ろに足して1つにする
  const pending = "dept_meeting_id IS NULL AND held_on IN ('', ?2)";
  const generic = (k) => `(SELECT g.${k} FROM dept_reports g WHERE g.dept_meeting_id IS NULL AND g.held_on = '' AND g.project_id = dept_reports.project_id)`;
  const join = (k) => `${k} = CASE WHEN COALESCE(${generic(k)}, '') = '' THEN ${k} WHEN ${k} = '' THEN ${generic(k)} ELSE ${k} || char(10) || ${generic(k)} END`;
  return [
    env.DB.prepare(
      `UPDATE dept_reports SET ${["done", "next", "issues"].map(join).join(", ")}
       WHERE dept_meeting_id IS NULL AND held_on = ?1 AND ?1 != ''
         AND EXISTS (SELECT 1 FROM dept_reports g WHERE g.dept_meeting_id IS NULL AND g.held_on = '' AND g.project_id = dept_reports.project_id)`
    ).bind(heldOn),
    env.DB.prepare(
      `DELETE FROM dept_reports WHERE dept_meeting_id IS NULL AND held_on = '' AND ?1 != ''
       AND project_id IN (SELECT project_id FROM dept_reports WHERE dept_meeting_id IS NULL AND held_on = ?1)`
    ).bind(heldOn),
    // 再開したとき：定例を終えたあとに書き直したPJは、新しいほうを残す
    env.DB.prepare(
      `DELETE FROM dept_reports WHERE dept_meeting_id = ?1
       AND project_id IN (SELECT project_id FROM dept_reports WHERE ${pending})`
    ).bind(meetingId, heldOn),
    env.DB.prepare(`UPDATE dept_reports SET dept_meeting_id = ?1, held_on = '' WHERE ${pending}`).bind(meetingId, heldOn),
    // その日の定例に向けて書いた事務連絡 → 日付を決めずに書いた事務連絡、の順に移す
    move("dept_notice_days", "held_on = ?2").bind(meetingId, heldOn),
    env.DB.prepare(
      `UPDATE dept_meetings SET notion_url = (SELECT notion_url FROM dept_notice_days WHERE held_on = ?2)
       WHERE id = ?1 AND COALESCE(notion_url, '') = '' AND COALESCE((SELECT notion_url FROM dept_notice_days WHERE held_on = ?2), '') != ''`
    ).bind(meetingId, heldOn),
    env.DB.prepare("DELETE FROM dept_notice_days WHERE held_on = ?").bind(heldOn),
    move("dept_notice_draft", "id = 1").bind(meetingId),
    env.DB.prepare("UPDATE dept_notice_draft SET notice = '', news = '', exchange = '', layout = '', version = version + 1, updated_at = ? WHERE id = 1 AND (notice != '' OR news != '' OR exchange != '' OR layout != '')").bind(now),
  ];
}

async function getDeptMeeting({ env, user, params }) {
  const meeting = await env.DB.prepare(
    `SELECT d.*, u.name AS updated_by_name, ${NUMBER_SQL} + ? AS number FROM dept_meetings d LEFT JOIN users u ON u.id = d.updated_by WHERE d.id = ?`
  ).bind(firstNumber(env), params.id).first();
  if (!meeting) throw new HttpError(404, "定例が見つかりません");
  const { results: reports } = await env.DB.prepare(
    `SELECT r.*, p.name AS project_name, p.type, p.current_stage, u.name AS updated_by_name, ${MEMBER_NAMES} AS member_names
     FROM dept_reports r JOIN projects p ON p.id = r.project_id LEFT JOIN users u ON u.id = r.updated_by
     WHERE r.dept_meeting_id = ? ORDER BY p.created_at`
  ).bind(meeting.id).all();
  Object.assign(meeting, withState(meeting, teireiDay()), { is_today: meeting.held_on === teireiDay() });
  // まだ書いていないPJも、トグル（PJ名とメンバー）だけ並べておく（中身は空。書いたら入る）
  // その定例の日までに始まっていた、アーカイブしていないPJ
  const { results: missing } = await env.DB.prepare(
    `SELECT p.id, p.name, p.type, p.current_stage, ${MEMBER_NAMES} AS member_names FROM projects p
     WHERE p.status != 'archived' AND (p.status = 'active' OR p.updated_at >= ?2) AND p.created_at < ?2
       AND NOT EXISTS (SELECT 1 FROM dept_reports r WHERE r.project_id = p.id AND r.dept_meeting_id = ?1) ORDER BY p.created_at`
  ).bind(meeting.id, Date.parse(`${meeting.held_on}T23:59:59+09:00`)).all();
  return { meeting, reports, missing, canEdit: user.isAdmin };
}

// 議事録の保存（事務連絡・メモ・イベント）。end: true なら「定例を終わる」
// 定例の議事録を、Notionの部門の「議事録」データベースにも入れる（保存・定例を終わるたび）
// 1回目：同じ題名のページがなければ作る。2回目から：作ったページを書き直す
// 同じ題名のページが手で作ってあれば（第57回など）、二重に作らずそのページを使う。手で書いた中身は残し、最後に足す「ツールの議事録」の部分だけを書き直す
// NOTION_TEIREI_FROM より前の回は何もしない
// userId：「保存する」を押した人（はじめてページを作るとき、Notionの作成者の欄に入れる）
export async function syncTeireiNotion(env, id, userId = null) {
  const meeting = await env.DB.prepare(`SELECT d.*, ${NUMBER_SQL} + ? AS number FROM dept_meetings d WHERE d.id = ?`).bind(firstNumber(env), id).first();
  if (!meeting) return;
  // 決めた回より前の定例は入れない（まとめて入れるときに、もう数えないよう印を付ける）
  if (meeting.number < (Number(env.NOTION_TEIREI_FROM) || Infinity)) {
    await env.DB.prepare("UPDATE dept_meetings SET notion_url = 'skip' WHERE id = ? AND (notion_url IS NULL OR notion_url = '')").bind(meeting.id).run();
    return;
  }
  const { results: reports } = await env.DB.prepare(
    `SELECT r.*, p.name AS project_name FROM dept_reports r JOIN projects p ON p.id = r.project_id WHERE r.dept_meeting_id = ? ORDER BY p.created_at`
  ).bind(meeting.id).all();
  const { results: missing } = await env.DB.prepare(
    `SELECT name FROM projects p WHERE status = 'active' AND NOT EXISTS (SELECT 1 FROM dept_reports r WHERE r.project_id = p.id AND r.dept_meeting_id = ?) ORDER BY created_at`
  ).bind(meeting.id).all();
  const children = teireiBlocks({ ...meeting, reports, missing, appUrl: env.APP_URL ? `${env.APP_URL}/#/teirei/${meeting.id}` : "" });
  if (meeting.notion_url === "skip") return;
  await putTeireiNotion(env, { number: meeting.number, date: meeting.held_on, children, current: meeting.notion_url, author: await notionUser(env, userId),
    save: (url) => env.DB.prepare("UPDATE dept_meetings SET notion_url = ? WHERE id = ? AND (notion_url IS NULL OR notion_url = '')").bind(url, meeting.id).run() });
}

// Notionの定例の議事録ページを書く：作ってあれば書き直す。同じ題名のページが手で作ってあれば、そのページの最後に足す。なければ作る
async function putTeireiNotion(env, { number, date, children, current, save, author = "" }) {
  const title = `${String(number).padStart(3, "0")}_政策立案部門定例第${number}回`;
  if (current) {
    if (current.startsWith("merge:")) return replaceToolSection(env, current.slice(6), children);
    await replaceNotionPage(env, current, title, children);
    return fillTeireiPage(env, current, author);
  }
  const existing = await findTeireiPage(env, title);
  if (existing) {
    await save(`merge:${existing}`);
    return replaceToolSection(env, existing, children);
  }
  await save(await createTeireiPage(env, { title, date, children, author }));
}

// ツールのユーザーに対応づけたNotionアカウント（管理者メニュー「メンバーのアカウント」）
async function notionUser(env, userId) {
  if (!userId) return "";
  const u = await env.DB.prepare("SELECT notion_user_id FROM users WHERE id = ?").bind(userId).first();
  return u?.notion_user_id || "";
}

// まだ始めていない定例（day）に向けて書いた事務連絡・イベントを、Notionの定例の議事録にも入れる（事務連絡を「保存する」とき）
// 第◯回は、その日より前の定例（作ってある定例と、予定でまだ作っていない定例）の数から数える。定例を始めると、このページを引き継ぐ
export async function syncTeireiDayNotion(env, day, userId = null) {
  const row = await env.DB.prepare("SELECT * FROM dept_notice_days WHERE held_on = ?").bind(day).first();
  if (!row) return;
  const [{ n }, slots] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM dept_meetings WHERE held_on < ?").bind(day).first(),
    upcomingSlots(env, 10),
  ]);
  const number = n + slots.filter((s) => !s.meeting && s.starts_at.slice(0, 10) < day).length + firstNumber(env);
  if (number < (Number(env.NOTION_TEIREI_FROM) || Infinity)) return;
  const { results: reports } = await env.DB.prepare(
    `SELECT r.*, p.name AS project_name FROM dept_reports r JOIN projects p ON p.id = r.project_id WHERE r.dept_meeting_id IS NULL AND r.held_on = ? ORDER BY p.created_at`
  ).bind(day).all();
  const { results: missing } = await env.DB.prepare(
    `SELECT name FROM projects p WHERE status = 'active' AND NOT EXISTS (SELECT 1 FROM dept_reports r WHERE r.project_id = p.id AND r.dept_meeting_id IS NULL AND r.held_on = ?) ORDER BY created_at`
  ).bind(day).all();
  const children = teireiBlocks({ ...row, memo: "", reports, missing, appUrl: "" });
  await putTeireiNotion(env, { number, date: day, children, current: row.notion_url, author: await notionUser(env, userId),
    save: (url) => env.DB.prepare("UPDATE dept_notice_days SET notion_url = ? WHERE held_on = ? AND (notion_url IS NULL OR notion_url = '')").bind(url, day).run() });
}
const syncLater = (env, ctx, job) => ctx?.waitUntil(job().catch((err) => console.error("teirei notion sync failed", err?.status, err?.code || err?.message)));
export const teireiNotionOn = (env) => notionConfigured(env) && Boolean(env.NOTION_TEIREI_DB);

async function updateDeptMeeting({ request, env, user, params, ctx }) {
  requireAdmin(user, "定例の議事録を変えられるのは、管理者です");
  const body = await readJson(request);
  const cur = await env.DB.prepare("SELECT * FROM dept_meetings WHERE id = ?").bind(params.id).first();
  if (!cur) throw new HttpError(404, "定例が見つかりません");
  const notice = "notice" in body ? longText(body.notice, 30000, "事務連絡") : cur.notice;
  const memo = "memo" in body ? longText(body.memo, 50000, "メモ") : cur.memo;
  const news = "news" in body ? longText(body.news, 30000, "ニュース勉強会") : cur.news;
  const exchange = "exchange" in body ? longText(body.exchange, 30000, "意見交換会") : cur.exchange;
  const layout = "layout" in body ? cleanLayout(String(body.layout || "")) : cur.layout;
  const event = "event" in body ? (body.event ? oneOf(body.event, EVENTS, "イベント") : "") : cur.event;
  const now = Date.now();
  // 再開できるのは、今日の定例だけ（終えたあとに書かれた進捗共有・事務連絡もまとめ直す）
  if (body.reopen && cur.held_on !== teireiDay()) throw new HttpError(400, "再開できるのは今日の定例だけです");
  const endedAt = body.reopen ? null : body.end ? cur.ended_at || now : cur.ended_at;
  const version = int(body.version, { min: 1, label: "版" });
  const res = await env.DB.prepare(
    `UPDATE dept_meetings SET notice = ?, memo = ?, news = ?, exchange = ?, layout = ?, event = ?, ended_at = ?, updated_by = ?, updated_at = ?, version = version + 1
     WHERE id = ? AND version = ?`
  ).bind(notice, memo, news, exchange, layout, event, endedAt, user.id, now, cur.id, version).run();
  assertUpdated(res, "定例の議事録");
  if (body.reopen && cur.ended_at) await env.DB.batch(collectStatements(env, cur.id, cur.held_on, now));
  if (!body.reopen && !body.auto && teireiNotionOn(env)) ctx?.waitUntil(syncTeireiNotion(env, cur.id, user.id).catch((err) => console.error("teirei notion sync failed", err?.status, err?.code || err?.message)));
  return { ok: true, version: version + 1 };
}

// ---------- どの定例か選ぶ（進捗を書く・定例イベントのMTG） ----------
// 最近終わった定例（2回）／今日・これからの定例（作ってあるもの）／予定から次の3回。日付（held_on）ごとに1つ
async function listTeireiTargets({ env }) {
  const today = teireiDay();
  const [{ results: past }, { results: ahead }, slots] = await Promise.all([
    env.DB.prepare(`SELECT d.id, d.held_on, d.starts_at, d.ended_at, ${NUMBER_SQL} + ? AS number FROM dept_meetings d WHERE d.held_on < ? ORDER BY d.held_on DESC LIMIT 2`)
      .bind(firstNumber(env), today).all(),
    env.DB.prepare(`SELECT d.id, d.held_on, d.starts_at, d.ended_at, ${NUMBER_SQL} + ? AS number FROM dept_meetings d WHERE d.held_on >= ? ORDER BY d.held_on LIMIT 3`)
      .bind(firstNumber(env), today).all(),
    upcomingSlots(env, 3),
  ]);
  const byDay = new Map();
  for (const s of slots) byDay.set(s.starts_at.slice(0, 10), { day: s.starts_at.slice(0, 10), starts_at: s.starts_at, meeting: null });
  for (const m of [...past, ...ahead]) {
    byDay.set(m.held_on, { day: m.held_on, starts_at: m.starts_at || byDay.get(m.held_on)?.starts_at || "", meeting: { ...withState(m, today), number: m.number } });
  }
  const targets = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  // 初めに選んでおくもの：今日かこれからの、いちばん近い定例
  return { today, targets, suggested: targets.find((t) => t.day >= today)?.day || null };
}

// day（'YYYY-MM-DD'）の定例：作ってあればその定例、まだなら「その日に向けた書き置き」。day がなければ今までどおり（進行中の定例か、次の定例）
async function reportTarget(env, day) {
  if (!day) {
    const meeting = await openMeeting(env);
    return { meeting, meetingId: meeting?.id || 0, heldOn: "" };
  }
  const meeting = await env.DB.prepare("SELECT id, held_on, ended_at FROM dept_meetings WHERE held_on = ?").bind(day).first();
  if (meeting) return { meeting, meetingId: meeting.id, heldOn: "" };
  if (day < teireiDay()) throw new HttpError(404, "その日の定例は見つかりません");
  return { meeting: null, meetingId: 0, heldOn: day };
}
const dayParam = (v) => (v ? reqDate(v, "定例の日") : null);

// 「進捗を書く」で選べるPJ（自分が参加している進行中のPJ。管理者はすべて）。?day= の定例に書いたかどうかも付ける
async function listReportTargets({ env, user, url }) {
  const t = await reportTarget(env, dayParam(url.searchParams.get("day")));
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.name, p.type, p.current_stage,
            EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?1) AS is_mine,
            (SELECT r.updated_at FROM dept_reports r WHERE r.project_id = p.id AND COALESCE(r.dept_meeting_id, 0) = ?2 AND r.held_on = ?3) AS written_at
     FROM projects p WHERE p.status = 'active' ORDER BY is_mine DESC, p.created_at DESC`
  ).bind(user.id, t.meetingId, t.heldOn).all();
  return { projects: results.filter((p) => p.is_mine || user.isAdmin), todayMeetingId: t.meeting?.id || null, meeting: t.meeting };
}

// ?day= の定例に向けた進捗共有（作ってある定例ならその中、まだならその日に向けた書き置き）
async function getReport({ env, user, params, url }) {
  const project = await loadProject(env, params.id);
  await requireEditor(env, user, project.id);
  const t = await reportTarget(env, dayParam(url.searchParams.get("day")));
  const [report, previous] = await Promise.all([
    env.DB.prepare(
      `SELECT r.*, u.name AS updated_by_name FROM dept_reports r LEFT JOIN users u ON u.id = r.updated_by
       WHERE r.project_id = ? AND COALESCE(r.dept_meeting_id, 0) = ? AND r.held_on = ?`
    ).bind(project.id, t.meetingId, t.heldOn).first(),
    env.DB.prepare(
      `SELECT r.done, r.next, r.issues, d.held_on FROM dept_reports r JOIN dept_meetings d ON d.id = r.dept_meeting_id
       WHERE r.project_id = ? AND d.id != ? AND d.held_on < ? ORDER BY d.held_on DESC LIMIT 1`
    ).bind(project.id, t.meetingId, t.meeting?.held_on || t.heldOn || "9999").first(),
  ]);
  return {
    project: { id: project.id, name: project.name, type: project.type, current_stage: project.current_stage },
    meeting: t.meeting,
    day: t.meeting?.held_on || t.heldOn || null,
    report: report || { done: "", next: "", issues: "", version: 0 },
    previous,
  };
}

// sync: true（「保存する」を押したとき）で、終わった定例に書いたなら、Notionの定例の議事録も書き直す
async function saveReport({ request, env, user, params, ctx }) {
  const project = await loadProject(env, params.id);
  await requireEditor(env, user, project.id);
  const body = await readJson(request);
  const t = await reportTarget(env, dayParam(body.day));
  const values = [longText(body.done, 20000, "やったこと"), longText(body.next, 20000, "次にやること"), longText(body.issues, 20000, "困っていること"), user.id, Date.now()];
  const version = int(body.version, { min: 0, label: "版" });
  const res = version === 0
    ? await env.DB.prepare(
        `INSERT OR IGNORE INTO dept_reports (done, next, issues, updated_by, updated_at, project_id, dept_meeting_id, held_on)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(...values, project.id, t.meetingId || null, t.heldOn).run()
    : await env.DB.prepare(
        `UPDATE dept_reports SET done = ?, next = ?, issues = ?, updated_by = ?, updated_at = ?, version = version + 1
         WHERE project_id = ? AND COALESCE(dept_meeting_id, 0) = ? AND held_on = ? AND version = ?`
      ).bind(...values, project.id, t.meetingId, t.heldOn, version).run();
  assertUpdated(res, "進捗共有");
  if (body.sync && t.meeting?.ended_at && teireiNotionOn(env)) ctx?.waitUntil(syncTeireiNotion(env, t.meeting.id, user.id).catch((err) => console.error("teirei notion sync failed", err?.status, err?.code || err?.message)));
  return { ok: true, version: version + 1 };
}

// ---------- 定例イベント（ニュース勉強会・意見交換会）のMTG：選んだ定例の議事録の、そのイベントの欄に書く ----------
// 作ってある定例ならその議事録に直接、まだならその日に向けた書き置き（定例を始めると議事録に移る）。だれでも書ける
async function eventTarget(env, url, body) {
  const day = reqDate(body?.day ?? url.searchParams.get("day"), "定例の日");
  const field = oneOf(body?.event ?? url.searchParams.get("event"), EVENTS, "イベント");
  const meeting = await env.DB.prepare("SELECT id, held_on, ended_at, event, version FROM dept_meetings WHERE held_on = ?").bind(day).first();
  if (!meeting && day < teireiDay()) throw new HttpError(404, "その日の定例は見つかりません");
  return { day, field, meeting };
}

async function getEvent({ env, url }) {
  const { day, field, meeting } = await eventTarget(env, url);
  const row = meeting
    ? await env.DB.prepare(`SELECT d.${field} AS text, d.version, d.updated_at, u.name AS updated_by_name FROM dept_meetings d LEFT JOIN users u ON u.id = d.updated_by WHERE d.id = ?`).bind(meeting.id).first()
    : await env.DB.prepare(`SELECT d.${field} AS text, d.version, d.updated_at, u.name AS updated_by_name FROM dept_notice_days d LEFT JOIN users u ON u.id = d.updated_by WHERE d.held_on = ?`).bind(day).first();
  const number = meeting ? (await env.DB.prepare(`SELECT ${NUMBER_SQL} + ? AS n FROM dept_meetings d WHERE d.id = ?`).bind(firstNumber(env), meeting.id).first()).n : null;
  return {
    day, event: field, target: meeting ? "meeting" : "day", meeting: meeting ? { id: meeting.id, ended: Boolean(meeting.ended_at), number } : null,
    text: row?.text || "", version: row?.version ?? 0, updated_at: row?.updated_at || 0, updated_by_name: row?.updated_by_name || "",
  };
}

async function saveEvent({ request, env, user, url, ctx }) {
  const body = await readJson(request);
  const { day, field, meeting } = await eventTarget(env, url, body);
  // 開いたときと保存するときで行き先が変わった（そのあいだに定例が始まった）なら、読み込み直してもらう
  if (body.target !== (meeting ? "meeting" : "day")) throw new HttpError(409, "定例の状態が変わりました。画面を再読み込みしてください");
  const text = longText(body.text, 30000, EVENT_LABELS[field]);
  const version = int(body.version, { min: 0, label: "版" });
  const now = Date.now();
  const res = meeting
    ? await env.DB.prepare(`UPDATE dept_meetings SET ${field} = ?, event = CASE WHEN event = '' THEN ? ELSE event END, updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?`)
      .bind(text, field, user.id, now, meeting.id, version).run()
    : version === 0
      ? await env.DB.prepare(`INSERT OR IGNORE INTO dept_notice_days (held_on, ${field}, updated_by, updated_at) VALUES (?, ?, ?, ?)`).bind(day, text, user.id, now).run()
      : await env.DB.prepare(`UPDATE dept_notice_days SET ${field} = ?, updated_by = ?, updated_at = ?, version = version + 1 WHERE held_on = ? AND version = ?`)
        .bind(text, user.id, now, day, version).run();
  assertUpdated(res, EVENT_LABELS[field]);
  // 「保存する」「MTGを終える」のとき：作ってある定例なら、Notionの定例の議事録も書き直す
  if (body.sync && teireiNotionOn(env)) syncLater(env, ctx, () => (meeting ? syncTeireiNotion(env, meeting.id, user.id) : syncTeireiDayNotion(env, day, user.id)));
  return { ok: true, version: meeting || version > 0 ? version + 1 : 1 };
}

// ---------- 事務連絡を書く（部門長・副部門長＝管理者） ----------
// 進行中の定例があればその定例の事務連絡、なければ次の定例に向けて書いておく（定例を始めると移る）
async function noticeTarget(env, day) {
  if (day) {
    const meeting = await env.DB.prepare("SELECT id, held_on FROM dept_meetings WHERE held_on = ?").bind(day).first();
    return meeting ? { target: "meeting", meeting } : { target: "day" };
  }
  const meeting = await openMeeting(env);
  return meeting ? { target: "meeting", meeting } : { target: "next" };
}

async function getNotice({ env, user, url }) {
  requireAdmin(user, "事務連絡を書けるのは、部門長・副部門長です");
  const day = url.searchParams.get("day") ? reqDate(url.searchParams.get("day"), "定例の日") : null;
  const t = await noticeTarget(env, day);
  const by = (table, where) => env.DB.prepare(
    `SELECT d.notice, d.news, d.exchange, d.layout, d.version, d.updated_at, u.name AS updated_by_name FROM ${table} d LEFT JOIN users u ON u.id = d.updated_by WHERE ${where}`
  );
  const row = t.target === "meeting" ? await by("dept_meetings", "d.id = ?").bind(t.meeting.id).first()
    : t.target === "day" ? await by("dept_notice_days", "d.held_on = ?").bind(day).first()
    : await by("dept_notice_draft", "d.id = 1").first();
  return {
    target: t.target, day: day || t.meeting?.held_on || null, meeting: t.meeting || null,
    notice: row?.notice || "", news: row?.news || "", exchange: row?.exchange || "", layout: row?.layout || "", version: row?.version ?? 0, updated_at: row?.updated_at || 0, updated_by_name: row?.updated_by_name || "",
  };
}

async function saveNotice({ request, env, user, ctx }) {
  requireAdmin(user, "事務連絡を書けるのは、部門長・副部門長です");
  const body = await readJson(request);
  const day = body.day ? reqDate(body.day, "定例の日") : null;
  const notice = longText(body.notice, 30000, "事務連絡");
  const news = longText(body.news, 30000, "ニュース勉強会");
  const exchange = longText(body.exchange, 30000, "意見交換会");
  const layout = cleanLayout(String(body.layout || ""));
  const version = int(body.version, { min: 0, label: "版" });
  const now = Date.now();
  const t = await noticeTarget(env, day);
  // 開いたときと保存するときで行き先が変わった（そのあいだに定例が始まった・終わった）なら、読み込み直してもらう
  if (body.target !== t.target) throw new HttpError(409, "定例の状態が変わりました。画面を再読み込みしてください");
  const res = t.target === "meeting"
    ? await env.DB.prepare("UPDATE dept_meetings SET notice = ?, news = ?, exchange = ?, layout = ?, updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?")
      .bind(notice, news, exchange, layout, user.id, now, t.meeting.id, version).run()
    : t.target === "day"
      ? version === 0
        ? await env.DB.prepare("INSERT OR IGNORE INTO dept_notice_days (held_on, notice, news, exchange, layout, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(day, notice, news, exchange, layout, user.id, now).run()
        : await env.DB.prepare("UPDATE dept_notice_days SET notice = ?, news = ?, exchange = ?, layout = ?, updated_by = ?, updated_at = ?, version = version + 1 WHERE held_on = ? AND version = ?")
          .bind(notice, news, exchange, layout, user.id, now, day, version).run()
      : await env.DB.prepare("UPDATE dept_notice_draft SET notice = ?, news = ?, exchange = ?, layout = ?, updated_by = ?, updated_at = ?, version = version + 1 WHERE id = 1 AND version = ?")
        .bind(notice, news, exchange, layout, user.id, now, version).run();
  assertUpdated(res, "事務連絡");
  if (body.sync && teireiNotionOn(env)) {
    if (t.target === "meeting") syncLater(env, ctx, () => syncTeireiNotion(env, t.meeting.id, user.id));
    else if (t.target === "day") syncLater(env, ctx, () => syncTeireiDayNotion(env, day, user.id));
  }
  return { ok: true, version: version + 1 };
}

// ---------- 定例の予定（部門長・副部門長） ----------
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

// 予定から、今日以降の定例の日時を近い順に（すでに作った定例があれば、その状態も付ける）
async function upcomingSlots(env, limit) {
  const today = teireiDay();
  const { results: schedules } = await env.DB.prepare("SELECT * FROM dept_schedules WHERE to_date >= ?").bind(today).all();
  const slots = new Set();
  for (const s of schedules) {
    const from = s.from_date > today ? s.from_date : today;
    const to = s.to_date < addDays(today, 90) ? s.to_date : addDays(today, 90);
    for (const slot of regularOccurrences({ weekdays: [s.weekday], time: s.time, interval: 1, anchor: s.from_date }, from, to)) slots.add(slot);
  }
  const list = [...slots].sort().slice(0, limit);
  if (!list.length) return [];
  const { results: meetings } = await env.DB.prepare(
    `SELECT id, held_on, ended_at FROM dept_meetings WHERE held_on IN (${list.map(() => "?").join(",")})`
  ).bind(...list.map((x) => x.slice(0, 10))).all();
  const { results: notes } = await env.DB.prepare(
    `SELECT held_on FROM dept_notice_days WHERE (notice != '' OR news != '' OR exchange != '' OR layout != '') AND held_on IN (${list.map(() => "?").join(",")})`
  ).bind(...list.map((x) => x.slice(0, 10))).all();
  return list.map((starts_at) => {
    const m = meetings.find((x) => x.held_on === starts_at.slice(0, 10));
    return { starts_at, meeting: m ? withState(m, today) : null, has_notice: notes.some((n) => n.held_on === starts_at.slice(0, 10)) };
  });
}

async function listSchedules({ env }) {
  const { results } = await env.DB.prepare(
    "SELECT s.*, u.name AS created_by_name FROM dept_schedules s LEFT JOIN users u ON u.id = s.created_by ORDER BY s.to_date DESC, s.weekday"
  ).all();
  return { today: teireiDay(), schedules: results, upcoming: await upcomingSlots(env, 3) };
}

async function createSchedule({ request, env, user }) {
  requireAdmin(user, "定例を予定できるのは、部門長・副部門長です");
  const body = await readJson(request);
  const weekday = int(body.weekday, { min: 0, max: 6, label: "曜日" });
  const time = typeof body.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.time) ? body.time : null;
  if (!time) throw new HttpError(400, "時刻を入力してください");
  const from = reqDate(body.from_date, "開始日");
  const to = reqDate(body.to_date, "終了日");
  if (to < from) throw new HttpError(400, "終了日は開始日より後にしてください");
  if (to > addDays(from, 366)) throw new HttpError(400, "期間は1年以内にしてください");
  await env.DB.prepare(
    "INSERT INTO dept_schedules (weekday, time, from_date, to_date, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(weekday, time, from, to, user.id, Date.now()).run();
  return { ok: true, label: `毎週${WEEKDAYS[weekday]}曜 ${time}` };
}

async function deleteSchedule({ env, user, params }) {
  requireAdmin(user, "定例の予定を消せるのは、部門長・副部門長です");
  const res = await env.DB.prepare("DELETE FROM dept_schedules WHERE id = ?").bind(params.id).run();
  if (!res.meta.changes) throw new HttpError(404, "予定が見つかりません");
  return { ok: true };
}

// カレンダー用：from〜to の部門の定例。予定（毎週◯曜◯時）から出し、実際に開いた定例があればそれに結び付ける
// weekday・to_date はカレンダーで「定例をまとめて追加（くり返し）」に使う
export async function teireiEvents(env, from, to) {
  const [{ results: schedules }, { results: meetings }] = await Promise.all([
    env.DB.prepare("SELECT * FROM dept_schedules WHERE to_date >= ? AND from_date <= ?").bind(from, to).all(),
    env.DB.prepare("SELECT id, held_on, starts_at, ended_at FROM dept_meetings WHERE held_on >= ? AND held_on <= ?").bind(from, to).all(),
  ]);
  const byDay = new Map();
  for (const s of schedules) {
    const a = s.from_date > from ? s.from_date : from;
    const b = s.to_date < to ? s.to_date : to;
    for (const slot of regularOccurrences({ weekdays: [s.weekday], time: s.time, interval: 1, anchor: s.from_date }, a, b)) {
      byDay.set(slot.slice(0, 10), { starts_at: slot, weekday: s.weekday, until: s.to_date, meeting_id: null, ended: false });
    }
  }
  for (const m of meetings) {
    const cur = byDay.get(m.held_on);
    byDay.set(m.held_on, {
      ...(cur || { weekday: null, until: null }),
      starts_at: m.starts_at || cur?.starts_at || `${m.held_on}T22:00`,
      meeting_id: m.id,
      ended: Boolean(m.ended_at),
    });
  }
  return [...byDay.values()].sort((x, y) => x.starts_at.localeCompare(y.starts_at));
}
