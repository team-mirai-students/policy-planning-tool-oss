// ログインユーザー情報・ホーム・カレンダー
import { HttpError, optDate, nowJst, todayJst } from "../util.js";
import { addDays, typesForClient } from "../project-types.js";
import { ensureAllRegularMeetings, loadAllSchedules } from "./common.js";
import { teireiEvents } from "./dept.js";
import { ASSIGNEE_COLUMNS, ASSIGNED_TO } from "../task-assignees.js";

export const routes = [
  ["GET", "/api/me", getMe],
  ["GET", "/api/calendar", getCalendar],
  ["GET", "/api/meeting-start", getMeetingStart],
  ["GET", "/api/notices", getNotices],
  ["POST", "/api/notices/read", readNotices],
  ["GET", "/api/my-tasks", getMyTasks],
];

// お知らせ（自分あての通知。新しい順に50件）
async function getNotices({ env, url, user }) {
  const unread = await env.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL").bind(user.id).first();
  if (url.searchParams.get("count") === "1") return { unread: unread.n };
  const { results } = await env.DB.prepare(
    "SELECT id, body, link, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50"
  ).bind(user.id).all();
  return { notices: results, unread: unread.n };
}

async function readNotices({ env, user }) {
  await env.DB.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").bind(Date.now(), user.id).run();
  return { ok: true };
}

// 自分が担当のタスク（未完了すべてと、最近完了した20件）。?user=ID なら、そのメンバーのタスク（プロフィール用。PJは部門の全員が見られるので、タスクも見せてよい）
async function getMyTasks({ env, user: me, url }) {
  const uid = url.searchParams.get("user");
  const user = uid && uid !== me.id ? await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(uid).first() : me;
  if (!user) throw new HttpError(404, "メンバーが見つかりません");
  const cols = `t.id, t.title, t.status, t.due_date, t.stage_no, t.version, p.id AS project_id, p.name AS project_name`;
  const [open, done] = await Promise.all([
    env.DB.prepare(
      `SELECT ${cols} FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE ${ASSIGNED_TO} AND t.status != 'done' AND p.status != 'archived' ORDER BY t.due_date IS NULL, t.due_date, t.id`
    ).bind(user.id).all(),
    env.DB.prepare(
      `SELECT ${cols} FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE ${ASSIGNED_TO} AND t.status = 'done' ORDER BY t.updated_at DESC LIMIT 20`
    ).bind(user.id).all(),
  ]);
  return { open: open.results, done: done.results };
}

// 「ミーティングを始める」：自分が入っている進行中のPJ（管理者は全PJ）と、今日のMTG
async function getMeetingStart({ env, user }) {
  await ensureAllRegularMeetings(env);
  const today = todayJst();
  const { results: projects } = await env.DB.prepare(
    `SELECT p.id, p.name, p.type, p.current_stage, p.meeting_mode,
            EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?1) AS is_mine
     FROM projects p WHERE p.status = 'active' ORDER BY is_mine DESC, p.created_at DESC`
  ).bind(user.id).all();
  const visible = projects.filter((p) => p.is_mine || user.isAdmin);
  const { results: meetings } = await env.DB.prepare(
    `SELECT m.id, m.project_id, m.starts_at, m.place, EXISTS (SELECT 1 FROM minutes n WHERE n.meeting_id = m.id) AS has_minutes
     FROM meetings m WHERE m.cancelled = 0 AND m.starts_at >= ? ORDER BY m.starts_at`
  ).bind(`${today}T00:00`).all();
  // 再開用：この30日のうちに開いた過去のMTG（PJごとに新しい順で3件まで）
  const { results: past } = await env.DB.prepare(
    `SELECT m.id, m.project_id, m.starts_at, m.place, EXISTS (SELECT 1 FROM minutes n WHERE n.meeting_id = m.id) AS has_minutes
     FROM meetings m WHERE m.cancelled = 0 AND m.starts_at < ? AND m.starts_at >= ? ORDER BY m.starts_at DESC`
  ).bind(`${today}T00:00`, `${addDays(today, -30)}T00:00`).all();
  // 今日以降の予定のMTG（PJごとに近い順で5件まで）
  return {
    now: nowJst(),
    projects: visible.map((p) => ({
      ...p,
      upcoming: meetings.filter((m) => m.project_id === p.id).slice(0, 5),
      recent: past.filter((m) => m.project_id === p.id).slice(0, 3),
    })),
  };
}

async function getMe({ env, user }) {
  const { results: users } = await env.DB.prepare("SELECT id, name, avatar FROM users ORDER BY name").all();
  return { user, users, types: typesForClient(await loadAllSchedules(env)) };
}

async function getCalendar({ env, url, user }) {
  const from = optDate(url.searchParams.get("from"), "開始日");
  const to = optDate(url.searchParams.get("to"), "終了日");
  if (!from || !to || to < from || to > addDays(from, 62)) throw new HttpError(400, "期間が正しくありません");
  const mine = url.searchParams.get("mine") === "1";
  await ensureAllRegularMeetings(env);

  // mine=1 のときは自分が入っているPJだけ（タスクは自分が担当のものだけ）
  const pjFilter = mine ? "AND p.id IN (SELECT project_id FROM project_members WHERE user_id = ?3)" : "AND ?3 IS NOT NULL";
  const db = env.DB;
  const [meetings, tasks, stages, rehearsals, teirei] = await Promise.all([
    db.prepare(
      `SELECT m.id, m.starts_at, m.duration_min, m.place, m.kind, p.id AS project_id, p.name AS project_name,
              p.meeting_mode, p.meeting_weekdays, p.meeting_interval, p.meeting_duration, p.meeting_place,
              EXISTS (SELECT 1 FROM minutes n WHERE n.meeting_id = m.id) AS has_minutes,
              (?4 OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?3)) AS can_edit
       FROM meetings m JOIN projects p ON p.id = m.project_id
       WHERE m.cancelled = 0 AND m.starts_at >= ?1 AND m.starts_at < ?2 AND p.status != 'archived' ${pjFilter}
       ORDER BY m.starts_at`
    ).bind(`${from}T00:00`, `${addDays(to, 1)}T00:00`, user.id, user.isAdmin ? 1 : 0).all(),
    db.prepare(
      `SELECT t.id, t.title, t.status, t.due_date, t.assignee_id, ${ASSIGNEE_COLUMNS}, p.id AS project_id, p.name AS project_name
       FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.due_date >= ?1 AND t.due_date <= ?2 AND p.status != 'archived'
         ${mine ? "AND EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ?3)" : "AND ?3 IS NOT NULL"}
       ORDER BY t.due_date, t.id`
    ).bind(from, to, user.id).all(),
    db.prepare(
      `SELECT s.stage_no, s.due_date, p.id AS project_id, p.name AS project_name, p.type
       FROM project_stages s JOIN projects p ON p.id = s.project_id
       WHERE s.due_date >= ?1 AND s.due_date <= ?2 AND p.status = 'active' AND s.stage_no > 0 ${pjFilter}
       ORDER BY s.due_date`
    ).bind(from, to, user.id).all(),
    db.prepare(
      `SELECT r.id, r.starts_at, r.duration_min, r.place, p.id AS project_id, p.name AS project_name,
              (?4 OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?3)) AS can_edit
       FROM rehearsals r JOIN projects p ON p.id = r.project_id
       WHERE r.starts_at >= ?1 AND r.starts_at < ?2 AND p.status != 'archived' ${pjFilter}
       ORDER BY r.starts_at`
    ).bind(`${from}T00:00`, `${addDays(to, 1)}T00:00`, user.id, user.isAdmin ? 1 : 0).all(),
    // 部門の定例は全員が出るので、「自分の予定」でも出す
    teireiEvents(env, from, to),
  ]);
  return { meetings: meetings.results, tasks: tasks.results, stages: stages.results, rehearsals: rehearsals.results, teirei };
}
