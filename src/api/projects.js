// PJ・工程・チェックリスト
import {
  HttpError, readJson, clean, required, reqDate, optDate, optTime, optUrl, int, oneOf, assertUpdated, nowJst, todayJst, idList, leaderIds,
} from "../util.js";
import { PROJECT_TYPES, getType, addDays, computeStageDates } from "../project-types.js";
import { parseWeekdays } from "../schedule.js";
import {
  loadProject, requireEditor, assertUsers, stageDateStatements, regularMeetingStatements, loadSchedule,
  ensureRegularMeetings,
} from "./common.js";
import { notify, notifyProject } from "../notify.js";
import { ASSIGNEE_COLUMNS } from "../task-assignees.js";
import { syncPeopleLater } from "../notion-people.js";

export const routes = [
  ["GET", "/api/projects", listProjects],
  ["POST", "/api/projects", createProject],
  ["GET", "/api/projects/:id", getProject],
  ["POST", "/api/projects/:id/pm", setPm],
  ["POST", "/api/projects/:id/research-doc", setResearchDoc],
  ["POST", "/api/projects/:id/meeting-plan", setMeetingPlan],
  ["PUT", "/api/projects/:id", updateProject],
  ["POST", "/api/projects/:id/stage", setCurrentStage],
  ["POST", "/api/projects/:id/completion", completion],
  ["PUT", "/api/projects/:id/stages/:no", setStageDue],
  ["POST", "/api/projects/:id/checklist", addChecklistItem],
  ["PATCH", "/api/checklist/:id", toggleChecklistItem],
  ["DELETE", "/api/checklist/:id", deleteChecklistItem],
];

// ?archived=1 なら、一時中止（アーカイブ）したPJも返す（PJ一覧の「アーカイブ」欄）。ほかの画面では返さない
async function listProjects({ env, user, url }) {
  const withArchived = url?.searchParams.get("archived") === "1" ? 1 : 0;
  const { results: projects } = await env.DB.prepare(
    `SELECT p.id, p.name, p.type, p.description, p.status, p.personal, p.current_stage, p.start_date, p.presentation_date, p.completion_requested_at,
            p.meeting_mode, s.due_date AS stage_due,
            -- 一時中止したPJが、もうPJ決めに種として入っているか
            (p.status = 'archived' AND EXISTS (SELECT 1 FROM seeds sd JOIN seed_rounds r ON r.id = sd.round_id
               WHERE sd.prev_project_id = p.id AND sd.project_id IS NULL AND r.archived = 0)) AS requeued,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status != 'done') AS open_tasks,
            (SELECT MIN(starts_at) FROM meetings m WHERE m.project_id = p.id AND m.cancelled = 0 AND m.starts_at >= ?1) AS next_meeting
     FROM projects p
     LEFT JOIN project_stages s ON s.project_id = p.id AND s.stage_no = p.current_stage
     WHERE ?2 OR p.status != 'archived'
     ORDER BY p.status = 'archived', p.status = 'done', p.updated_at DESC`
  ).bind(nowJst(), withArchived).all();
  const { results: members } = await env.DB.prepare(
    `SELECT pm.project_id, u.id, u.name, u.avatar FROM project_members pm JOIN users u ON u.id = pm.user_id`
  ).all();
  // 進み具合の数直線用に、各工程の予定期間も返す
  const { results: stages } = await env.DB.prepare(
    "SELECT project_id, stage_no, start_date, due_date FROM project_stages ORDER BY stage_no"
  ).all();
  for (const p of projects) {
    p.members = members.filter((m) => m.project_id === p.id).map(({ project_id, ...u }) => u);
    p.isMine = p.members.some((m) => m.id === user.id);
    p.stages = stages.filter((s) => s.project_id === p.id).map(({ project_id, ...s }) => s);
  }
  return { projects };
}

// PJのDiscordのチャンネル（日程調整アンケートなどを投稿する先）。数字のID、またはチャンネルのリンクを受け付ける。空なら未設定
function discordChannel(value) {
  const v = String(value ?? "").trim();
  if (!v) return "";
  const m = v.match(/(\d{17,20})\/?$/);
  if (!m) throw new HttpError(400, "DiscordのチャンネルIDは、数字（またはチャンネルのリンク）を入れてください");
  return m[1];
}

function projectFields(body) {
  const meetingMode = oneOf(body.meeting_mode, ["regular", "adhoc"], "MTGの進め方");
  const weekdays = Array.isArray(body.meeting_weekdays) ? body.meeting_weekdays.map(String).join(",") : "";
  const fields = {
    name: required(body.name, 60, "PJ名"),
    description: clean(body.description, 400),
    doc_url: optUrl(body.doc_url),
    memo_doc_url: optUrl(body.memo_doc_url),
    script_doc_url: optUrl(body.script_doc_url),
    share_doc_url: optUrl(body.share_doc_url),
    start_date: reqDate(body.start_date, "開始日"),
    presentation_date: optDate(body.presentation_date, "最終発表日"),
    meeting_mode: meetingMode,
    meeting_weekdays: meetingMode === "regular" ? parseWeekdays(weekdays).join(",") : "",
    meeting_time: meetingMode === "regular" ? optTime(body.meeting_time) : "",
    meeting_interval: int(body.meeting_interval, { min: 1, max: 4, fallback: 1, label: "頻度" }),
    meeting_duration: int(body.meeting_duration, { min: 15, max: 480, fallback: 60, label: "MTGの長さ" }),
    meeting_place: clean(body.meeting_place, 200),
  };
  if (meetingMode === "regular" && (!fields.meeting_weekdays || !fields.meeting_time)) {
    throw new HttpError(400, "定例MTGの曜日と時刻を入力してください");
  }
  return fields;
}

function memberList(body) {
  const ids = Array.isArray(body.member_ids) ? body.member_ids.filter((x) => typeof x === "string") : [];
  return [...new Set(ids)].slice(0, 30);
}

// PJは、PJ決めの種から作る（管理者の「正式なPJにする」か、種の「個人PJとして進める」）。ここから直接は作れない
async function createProject() {
  throw new HttpError(403, "PJは、PJ決めの種から作ります（種の「⋯」→「個人PJとして進める」）");
}

// PJを作る（PJ決めの開票結果から作るときにも使う）。作った人は必ずメンバーに入る
// includeCreator=false は、管理者がPJ決めの種から他の人のPJを作るとき
export async function insertProject(env, user, body, { includeCreator = true } = {}) {
  const type = oneOf(body.type || "teigen", Object.keys(PROJECT_TYPES), "PJの型");
  const f = projectFields(body);
  const members = [...new Set([...(includeCreator ? [user.id] : []), ...memberList(body)])];
  if (!members.length) throw new HttpError(400, "メンバーを1人以上選んでください");
  await assertUsers(env, members);
  const channel = discordChannel(body.discord_channel_id);
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO projects (name, type, description, doc_url, memo_doc_url, script_doc_url, share_doc_url, start_date, presentation_date, current_stage, meeting_mode,
       meeting_weekdays, meeting_time, meeting_interval, meeting_duration, meeting_place, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
  ).bind(f.name, type, f.description, f.doc_url, f.memo_doc_url, f.script_doc_url, f.share_doc_url, f.start_date, f.presentation_date, f.meeting_mode, f.meeting_weekdays,
    f.meeting_time, f.meeting_interval, f.meeting_duration, f.meeting_place, user.id, now, now).first();

  // PJを作った時点で「PJ決め」は済んでいるので、工程0のチェックリストは完了扱いで作る
  const checklist = getType(type).stages.flatMap((s) =>
    s.checklist.map(([label, hint, opts], i) =>
      env.DB.prepare(
        `INSERT INTO checklist_items (project_id, stage_no, label, hint, sort, done_by, done_at, notify_leaders) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(row.id, s.no, label, hint, i, s.no === 0 ? user.id : null, s.no === 0 ? now : null, opts?.notifyLeaders ? 1 : 0)
    )
  );
  // 雛形のタスク（例：Figmaで発表資料を作る）。担当は未定、期限はその工程の期限
  const custom = await loadSchedule(env, type);
  const stageDue = Object.fromEntries(computeStageDates(type, row.start_date, row.presentation_date, custom).map((s) => [s.stage_no, s.due_date]));
  const templateTasks = getType(type).stages.flatMap((s) => (s.tasks || []).map((title) =>
    env.DB.prepare(
      `INSERT INTO tasks (project_id, stage_no, title, due_date, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'todo', ?, ?, ?)`
    ).bind(row.id, s.no, title, stageDue[s.no] || null, user.id, now, now)));
  await env.DB.batch([
    ...members.map((uid) => env.DB.prepare("INSERT INTO project_members (project_id, user_id) VALUES (?, ?)").bind(row.id, uid)),
    ...templateTasks,
    ...(await stageDateStatements(env, row, { onlyAuto: false, custom })),
    env.DB.prepare("UPDATE project_stages SET completed_at = ? WHERE project_id = ? AND stage_no = 0").bind(now, row.id),
    ...checklist,
    ...regularMeetingStatements(env, row, now),
  ]);
  if (channel) await env.DB.prepare("UPDATE projects SET discord_channel_id = ? WHERE id = ?").bind(channel, row.id).run();
  await notify(env, members, `【${row.name}】PJのメンバーになりました`, `#/projects/${row.id}`, { dm: false, except: user.id });
  return row.id;
}

// PM（PJのマネージャー）を決める。PJのメンバーから選ぶ（空なら未定に戻す）
async function setPm({ request, env, user, params }) {
  const project = await loadProject(env, params.id);
  await requireEditor(env, user, project.id);
  const { user_id } = await readJson(request);
  const pm = user_id ? String(user_id) : null;
  if (pm && !(await env.DB.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?").bind(project.id, pm).first())) {
    throw new HttpError(400, "PMはPJのメンバーから選んでください");
  }
  await env.DB.prepare("UPDATE projects SET pm_id = ?, updated_at = ? WHERE id = ?").bind(pm, Date.now(), project.id).run();
  return { ok: true };
}

// リサーチドキュメント（調べたことを書くGoogleドキュメント）だけを登録する。初回MTGの「決めること」から使う
async function setResearchDoc({ request, env, user, params }) {
  const project = await loadProject(env, params.id);
  await requireEditor(env, user, project.id);
  const { url } = await readJson(request);
  const clean = optUrl(url);
  await env.DB.prepare("UPDATE projects SET memo_doc_url = ?, updated_at = ? WHERE id = ?").bind(clean, Date.now(), project.id).run();
  return { ok: true, url: clean };
}

// MTGの進め方（定例 or 毎回決める）だけを決める。初回MTGの「決めること」から使う。定例なら、これからの回を作り直す
async function setMeetingPlan({ request, env, user, params }) {
  const project = await loadProject(env, params.id);
  await requireEditor(env, user, project.id);
  const body = await readJson(request);
  const mode = oneOf(body.meeting_mode, ["regular", "adhoc"], "MTGの進め方");
  const weekdays = mode === "regular" ? parseWeekdays(Array.isArray(body.meeting_weekdays) ? body.meeting_weekdays.map(String).join(",") : "").join(",") : "";
  const time = mode === "regular" ? optTime(body.meeting_time) : "";
  if (mode === "regular" && (!weekdays || !time)) throw new HttpError(400, "定例にするときは、曜日と時刻を選んでください");
  const interval = int(body.meeting_interval, { min: 1, max: 4, fallback: 1, label: "頻度" });
  const updated = { ...project, meeting_mode: mode, meeting_weekdays: weekdays, meeting_time: time, meeting_interval: interval };
  await env.DB.batch([
    env.DB.prepare("UPDATE projects SET meeting_mode = ?, meeting_weekdays = ?, meeting_time = ?, meeting_interval = ?, updated_at = ?, version = version + 1 WHERE id = ?")
      .bind(mode, weekdays, time, interval, Date.now(), project.id),
    env.DB.prepare(
      `DELETE FROM meetings WHERE project_id = ? AND kind = 'regular' AND starts_at >= ? AND id NOT IN (SELECT meeting_id FROM minutes)`
    ).bind(project.id, nowJst()),
    ...regularMeetingStatements(env, updated),
  ]);
  if (mode === "regular") await notifyProject(env, updated, "定例MTGの曜日・時刻が決まりました", "", user.id, { dm: true });
  return { ok: true };
}

async function getProject({ env, user, params }) {
  const project = await loadProject(env, params.id);
  await ensureRegularMeetings(env, [project]);
  const [members, stages, checklist, tasks, meetings, recentMinutes, origin] = await Promise.all([
    env.DB.prepare(
      `SELECT u.id, u.name, u.avatar FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? ORDER BY u.name`
    ).bind(project.id).all(),
    env.DB.prepare("SELECT * FROM project_stages WHERE project_id = ? ORDER BY stage_no").bind(project.id).all(),
    env.DB.prepare(
      `SELECT c.*, u.name AS done_by_name, su.name AS skipped_by_name, m.starts_at AS meeting_starts_at,
              EXISTS (SELECT 1 FROM minutes n WHERE n.meeting_id = c.meeting_id) AS meeting_has_minutes
       FROM checklist_items c LEFT JOIN users u ON u.id = c.done_by LEFT JOIN users su ON su.id = c.skipped_by
       LEFT JOIN meetings m ON m.id = c.meeting_id
       WHERE c.project_id = ? ORDER BY c.stage_no, c.sort, c.id`
    ).bind(project.id).all(),
    env.DB.prepare(
      `SELECT t.*, ${ASSIGNEE_COLUMNS}, u.avatar AS assignee_avatar FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.project_id = ? ORDER BY t.status = 'done', t.due_date IS NULL, t.due_date, t.id`
    ).bind(project.id).all(),
    env.DB.prepare(
      `SELECT m.*, n.id AS minute_id FROM meetings m LEFT JOIN minutes n ON n.meeting_id = m.id
       WHERE m.project_id = ? ORDER BY m.starts_at DESC`
    ).bind(project.id).all(),
    // 発表画面で使う：最近の議事録の概要
    env.DB.prepare(
      `SELECT n.summary, m.starts_at FROM minutes n JOIN meetings m ON m.id = n.meeting_id
       WHERE n.project_id = ? ORDER BY m.starts_at DESC LIMIT 10`
    ).bind(project.id).all(),
    // 元になったPJ決め（どの種から正式なPJになったか）
    env.DB.prepare(
      `SELECT s.id AS seed_id, s.round_id, r.title AS round_title FROM seeds s JOIN seed_rounds r ON r.id = s.round_id WHERE s.project_id = ?`
    ).bind(project.id).first(),
  ]);
  return {
    project,
    members: members.results,
    stages: stages.results,
    checklist: checklist.results,
    tasks: tasks.results,
    meetings: meetings.results,
    recentMinutes: recentMinutes.results,
    origin: origin || null,
    canEdit: user.isAdmin || members.results.some((m) => m.id === user.id),
    now: nowJst(),
  };
}

async function updateProject({ request, env, user, params, ctx }) {
  const project = await loadProject(env, params.id);
  await requireEditor(env, user, project.id);
  const body = await readJson(request);
  const f = projectFields(body);
  const status = oneOf(body.status || project.status, ["active", "done", "archived"], "状態");
  if (status === "archived" && !user.isAdmin) throw new HttpError(403, "PJをアーカイブできるのは管理者です");
  if (status !== project.status && project.status !== "archived" && [status, project.status].includes("done") && !user.isAdmin) {
    throw new HttpError(403, "PJを完了にする（戻す）のは部門長・副部門長です。最終提出が済んだら「部門長に完了の承認を依頼する」を押してください");
  }
  const members = memberList(body);
  if (!members.length) throw new HttpError(400, "メンバーを1人以上選んでください");
  await assertUsers(env, members);
  const channel = "discord_channel_id" in body ? discordChannel(body.discord_channel_id) : null;
  const { results: before } = await env.DB.prepare("SELECT user_id FROM project_members WHERE project_id = ?").bind(project.id).all();
  const added = members.filter((uid) => !before.some((b) => b.user_id === uid));

  const res = await env.DB.prepare(
    `UPDATE projects SET name=?, description=?, doc_url=?, memo_doc_url=?, script_doc_url=?, share_doc_url=?, start_date=?, presentation_date=?, status=?, meeting_mode=?,
       meeting_weekdays=?, meeting_time=?, meeting_interval=?, meeting_duration=?, meeting_place=?, updated_at=?, version = version + 1
     WHERE id = ? AND version = ?`
  ).bind(f.name, f.description, f.doc_url, f.memo_doc_url, f.script_doc_url, f.share_doc_url, f.start_date, f.presentation_date, status, f.meeting_mode, f.meeting_weekdays,
    f.meeting_time, f.meeting_interval, f.meeting_duration, f.meeting_place, Date.now(), project.id,
    int(body.version, { label: "版" })).run();
  assertUpdated(res, "このPJ");
  if (channel !== null) await env.DB.prepare("UPDATE projects SET discord_channel_id = ? WHERE id = ?").bind(channel, project.id).run();

  const updated = { ...project, ...f, status };
  const stmts = [
    env.DB.prepare("DELETE FROM project_members WHERE project_id = ?").bind(project.id),
    ...members.map((uid) => env.DB.prepare("INSERT INTO project_members (project_id, user_id) VALUES (?, ?)").bind(project.id, uid)),
    ...(await stageDateStatements(env, updated)),
  ];
  const meetingChanged = ["meeting_mode", "meeting_weekdays", "meeting_time", "meeting_interval", "meeting_duration", "meeting_place", "start_date"]
    .some((k) => String(project[k]) !== String(updated[k]));
  if (meetingChanged || status !== "active") {
    // 定例の設定が変わったら、これからの定例の回（議事録のないもの）を作り直す
    stmts.push(env.DB.prepare(
      `DELETE FROM meetings WHERE project_id = ? AND kind = 'regular' AND starts_at >= ?
       AND id NOT IN (SELECT meeting_id FROM minutes)`
    ).bind(project.id, nowJst()));
    stmts.push(...regularMeetingStatements(env, updated));
  }
  await env.DB.batch(stmts);
  await notify(env, added, `【${updated.name}】PJのメンバーになりました`, `#/projects/${project.id}`, { dm: false, except: user.id });
  if (meetingChanged && updated.meeting_mode === "regular") await notifyProject(env, updated, "定例MTGの曜日・時刻が変わりました", "", user.id, { dm: true });
  syncPeopleLater(env, ctx, [project.id]); // Notionの参加者も人事に合わせる
  return { ok: true };
}

async function setCurrentStage({ request, env, user, params }) {
  const project = await loadProject(env, params.id);
  await requireEditor(env, user, project.id);
  const body = await readJson(request);
  const max = getType(project.type).stages.length - 1;
  const stage = int(body.stage_no, { min: 0, max, label: "工程" });
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE projects SET current_stage = ?, updated_at = ? WHERE id = ?").bind(stage, now, project.id),
    // 進めた工程より前は完了、それ以降は未完了にする
    env.DB.prepare(
      `UPDATE project_stages SET completed_at = CASE WHEN stage_no < ?2 THEN COALESCE(completed_at, ?3) ELSE NULL END
       WHERE project_id = ?1`
    ).bind(project.id, stage, now),
  ]);
  const stageName = getType(project.type).stages.find((x) => x.no === stage)?.name;
  if (stage !== project.current_stage) await notifyProject(env, project, `工程が「${stageName}」になりました`, "", user.id);
  return { ok: true };
}

async function setStageDue({ request, env, user, params }) {
  const project = await loadProject(env, params.id);
  await requireEditor(env, user, project.id);
  const body = await readJson(request);
  const due = optDate(body.due_date, "期限");
  if (due) {
    await env.DB.prepare("UPDATE project_stages SET due_date = ?, due_manual = 1 WHERE project_id = ? AND stage_no = ?")
      .bind(due, project.id, params.no).run();
  } else {
    // 空にしたら自動計算に戻す
    await env.DB.batch([
      env.DB.prepare("UPDATE project_stages SET due_manual = 0 WHERE project_id = ? AND stage_no = ?").bind(project.id, params.no),
      ...(await stageDateStatements(env, project)),
    ]);
  }
  return { ok: true };
}

async function addChecklistItem({ request, env, user, params }) {
  const project = await loadProject(env, params.id);
  await requireEditor(env, user, project.id);
  const body = await readJson(request);
  const stage = int(body.stage_no, { min: 0, max: getType(project.type).stages.length - 1, label: "工程" });
  const label = required(body.label, 120, "項目");
  await env.DB.prepare(
    `INSERT INTO checklist_items (project_id, stage_no, label, sort, is_custom)
     VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(sort), 0) + 1 FROM checklist_items WHERE project_id = ?1 AND stage_no = ?2), 1)`
  ).bind(project.id, stage, label).run();
  return { ok: true };
}

async function loadChecklistItem(env, user, id) {
  const item = await env.DB.prepare("SELECT * FROM checklist_items WHERE id = ?").bind(id).first();
  if (!item) throw new HttpError(404, "項目が見つかりません");
  await requireEditor(env, user, item.project_id);
  return item;
}

// skipped: スキップする／取り消す（チェックは外れる）
// done: チェックの有無（省略すると変えない）
// meeting_id: 結び付けるMTG。省略してチェックを入れたときは、その日のMTG（なければ直近1週間で議事録のあるMTG）を自動で選ぶ
async function toggleChecklistItem({ request, env, user, params }) {
  const item = await loadChecklistItem(env, user, params.id);
  const body = await readJson(request);
  if ("skipped" in body) {
    const skip = Boolean(body.skipped);
    await env.DB.prepare("UPDATE checklist_items SET skipped_at = ?, skipped_by = ?, done_at = NULL, done_by = NULL, meeting_id = NULL WHERE id = ?")
      .bind(skip ? item.skipped_at || Date.now() : null, skip ? item.skipped_by || user.id : null, item.id).run();
    return { ok: true };
  }
  const done = "done" in body ? Boolean(body.done) : Boolean(item.done_at);
  let meetingId = null;
  if (done && "meeting_id" in body) {
    meetingId = body.meeting_id ? int(body.meeting_id, { label: "MTG" }) : null;
    if (meetingId) {
      const m = await env.DB.prepare("SELECT 1 FROM meetings WHERE id = ? AND project_id = ?").bind(meetingId, item.project_id).first();
      if (!m) throw new HttpError(400, "このPJのMTGではありません");
    }
  } else if (done) {
    meetingId = item.done_at ? item.meeting_id : await meetingForToday(env, item.project_id);
  }
  // チェックを入れたらスキップは取り消す
  await env.DB.prepare(
    `UPDATE checklist_items SET done_by = ?1, done_at = ?2, meeting_id = ?3,
       skipped_at = CASE WHEN ?2 IS NULL THEN skipped_at END, skipped_by = CASE WHEN ?2 IS NULL THEN skipped_by END WHERE id = ?4`
  ).bind(done ? (item.done_at ? item.done_by : user.id) : null, done ? (item.done_at || Date.now()) : null, meetingId, item.id).run();
  // 資料をフォーラムに投稿した項目にチェックが入ったら、送付する部門長・副部門長に知らせる（DMはBot設定時）
  if (done && !item.done_at && item.notify_leaders) {
    const project = await loadProject(env, item.project_id);
    const leaders = await leaderIds(env);
    await notify(env, leaders, `【${project.name}】${user.name}さんが「${item.label}」にチェックしました。フォーラムの投稿を確認して、資料の送付をお願いします`,
      `#/projects/${project.id}`, { except: user.id });
  }
  return { ok: true, meeting_id: meetingId };
}

async function meetingForToday(env, projectId) {
  const today = todayJst();
  const sameDay = await env.DB.prepare(
    `SELECT id FROM meetings WHERE project_id = ? AND cancelled = 0 AND kind != 'exchange' AND starts_at >= ? AND starts_at < ? ORDER BY starts_at DESC LIMIT 1`
  ).bind(projectId, `${today}T00:00`, `${addDays(today, 1)}T00:00`).first();
  if (sameDay) return sameDay.id;
  const recent = await env.DB.prepare(
    `SELECT m.id FROM meetings m JOIN minutes n ON n.meeting_id = m.id
     WHERE m.project_id = ? AND m.cancelled = 0 AND m.kind != 'exchange' AND m.starts_at >= ? AND m.starts_at <= ? ORDER BY m.starts_at DESC LIMIT 1`
  ).bind(projectId, `${addDays(today, -7)}T00:00`, nowJst()).first();
  return recent?.id || null;
}

async function deleteChecklistItem({ env, user, params }) {
  const item = await loadChecklistItem(env, user, params.id);
  if (!item.is_custom) throw new HttpError(400, "マニュアル由来の項目は削除できません");
  await env.DB.prepare("DELETE FROM checklist_items WHERE id = ?").bind(item.id).run();
  return { ok: true };
}

// ---------- PJの完了 ----------
// request：最終提出が済んだら、PJメンバーが部門長・副部門長に完了の承認を依頼する
// approve：部門長・副部門長が承認するとPJは完了。reject：差し戻す（理由を添えてメンバーに知らせる）。reopen：完了したPJを進行中に戻す
async function completion({ request, env, user, params }) {
  const project = await loadProject(env, params.id);
  const body = await readJson(request);
  const action = oneOf(body.action, ["request", "cancel", "approve", "reject", "reopen"], "操作");
  const now = Date.now();
  const leaders = await leaderIds(env);
  if (action === "request" || action === "cancel") {
    await requireEditor(env, user, project.id);
    if (project.status !== "active") throw new HttpError(400, "進行中のPJではありません");
    if (action === "cancel") {
      await env.DB.prepare("UPDATE projects SET completion_requested_at = NULL, completion_requested_by = NULL WHERE id = ?").bind(project.id).run();
      return { ok: true };
    }
    const prep = await env.DB.prepare("SELECT final_status FROM presentation_prep WHERE project_id = ?").bind(project.id).first();
    if (prep?.final_status !== "done") throw new HttpError(400, "先に「発表・提出」タブの最終提出を「提出済み」にしてください");
    await env.DB.prepare("UPDATE projects SET completion_requested_at = ?, completion_requested_by = ?, updated_at = ? WHERE id = ?")
      .bind(now, user.id, now, project.id).run();
    await notify(env, leaders, `【承認待ち】${project.name}：最終提出が済みました。確認して、PJの完了を承認してください`, `#/projects/${project.id}`);
    return { ok: true };
  }
  if (!user.isAdmin) throw new HttpError(403, "PJの完了を承認できるのは部門長・副部門長です");
  if (action === "approve") {
    await env.DB.prepare(
      `UPDATE projects SET status = 'done', completed_at = ?, completed_by = ?, completion_requested_at = COALESCE(completion_requested_at, ?),
         updated_at = ?, version = version + 1 WHERE id = ?`
    ).bind(now, user.id, now, now, project.id).run();
    await notifyProject(env, project, "🎉 部門長がPJの完了を承認しました。おつかれさまでした！", "", user.id, { dm: true });
  } else if (action === "reject") {
    const reason = clean(body.reason, 300);
    await env.DB.prepare("UPDATE projects SET completion_requested_at = NULL, completion_requested_by = NULL, updated_at = ? WHERE id = ?")
      .bind(now, project.id).run();
    await notifyProject(env, project, `PJの完了は差し戻されました${reason ? `：${reason}` : ""}`, "", user.id, { dm: true });
  } else {
    await env.DB.prepare(
      `UPDATE projects SET status = 'active', completed_at = NULL, completed_by = NULL, completion_requested_at = NULL, completion_requested_by = NULL,
         updated_at = ?, version = version + 1 WHERE id = ?`
    ).bind(now, project.id).run();
    await notifyProject(env, project, "PJが進行中に戻りました", "", user.id);
  }
  return { ok: true };
}

