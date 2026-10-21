// 毎朝のリマインド（wrangler.toml の [triggers] で 8:00 JST に動く）
import { idList, nowJst, todayJst, repIds, headIds, adminIds } from "./util.js";
import { nextMonth } from "./api/surveys.js";
import { notify } from "./notify.js";
import { addDays } from "./project-types.js";
import { regularOccurrences } from "./schedule.js";

export async function runDailyReminders(env) {
  await Promise.all([remindNextMeeting(env), remindReviews(env), remindTodayMeetings(env), remindTeireiReports(env), remindSchedulePolls(env), remindTeireiSurvey(env)]);
}

// 毎月20日：来月の定例の曜日・時間決めアンケートがまだなければ、管理者に「作りましょう」と知らせる（月に1度）
async function remindTeireiSurvey(env) {
  const today = todayJst();
  if (today.slice(8) !== "20") return;
  const month = nextMonth(today.slice(0, 7));
  const made = await env.DB.prepare("SELECT 1 FROM surveys WHERE kind = 'teirei' AND json_extract(meta, '$.month') = ?").bind(month).first();
  if (made) return;
  await notify(env, await adminIds(env), `【定例】${Number(month.slice(5))}月の定例の曜日・時間を決めるアンケートを作りましょう（ホーム →「アンケートを追加」→「定例の曜日・時間決め」）`, "#/surveys/new?kind=teirei");
}

// 受付中の日程調整アンケート → まだ答えていないPJのメンバーへ
async function remindSchedulePolls(env) {
  const { results } = await env.DB.prepare(
    `SELECT sp.id, p.name, pm.user_id FROM schedule_polls sp JOIN projects p ON p.id = sp.project_id
     JOIN project_members pm ON pm.project_id = sp.project_id
     WHERE sp.closed_at IS NULL AND p.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM schedule_poll_answers a JOIN schedule_poll_slots s ON s.id = a.slot_id WHERE s.poll_id = sp.id AND a.user_id = pm.user_id)`
  ).all();
  const byPoll = new Map();
  for (const r of results) (byPoll.get(r.id) || byPoll.set(r.id, { name: r.name, users: [] }).get(r.id)).users.push(r.user_id);
  for (const [id, x] of byPoll) {
    await notify(env, x.users, `【${x.name}】次回MTGの日程調整アンケートに、まだ答えていません。行ける日時に答えてください`, `#/schedule-polls/${id}`, { dm: true });
  }
}

// 今日のPJのMTG → そのPJのメンバーへ（時刻と、議事録を開くリンク）
async function remindTodayMeetings(env) {
  const today = todayJst();
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.project_id, m.starts_at, m.place, p.name FROM meetings m JOIN projects p ON p.id = m.project_id
     WHERE m.cancelled = 0 AND p.status = 'active' AND m.starts_at >= ? AND m.starts_at < ? ORDER BY m.starts_at`
  ).bind(`${today}T00:00`, `${addDays(today, 1)}T00:00`).all();
  for (const m of results) {
    const { results: members } = await env.DB.prepare("SELECT user_id FROM project_members WHERE project_id = ?").bind(m.project_id).all();
    await notify(env, members.map((r) => r.user_id),
      `【今日のMTG】${m.starts_at.slice(11, 16)}から「${m.name}」のMTGです${m.place ? `（${m.place}）` : ""}`,
      `#/meetings/${m.id}?mode=view`);
  }
}

// 部門の定例の日 → 進捗共有をまだ書いていないPJのメンバーへ
async function remindTeireiReports(env) {
  const today = todayJst();
  const { results: schedules } = await env.DB.prepare("SELECT * FROM dept_schedules WHERE from_date <= ?1 AND to_date >= ?1").bind(today).all();
  const slot = schedules.flatMap((s) => regularOccurrences({ weekdays: [s.weekday], time: s.time, interval: 1, anchor: s.from_date }, today, today)).sort()[0];
  if (!slot) return;
  const meeting = await env.DB.prepare("SELECT id FROM dept_meetings WHERE held_on = ?").bind(today).first();
  const { results: projects } = await env.DB.prepare(
    `SELECT p.id, p.name FROM projects p WHERE p.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM dept_reports r WHERE r.project_id = p.id AND ((r.dept_meeting_id IS NULL AND r.held_on IN ('', ?2)) OR r.dept_meeting_id = ?1))`
  ).bind(meeting?.id || 0, today).all();
  for (const p of projects) {
    const { results: members } = await env.DB.prepare("SELECT user_id FROM project_members WHERE project_id = ?").bind(p.id).all();
    await notify(env, members.map((r) => r.user_id),
      `【今日は部門の定例】${slot.slice(11, 16)}から定例です。「${p.name}」の進捗（やったこと・次にやること・困っていること）を書いておきましょう`,
      `#/report/${p.id}?day=${today}`);
  }
}

// 定例でないPJで、MTGをしたのに次回の日程が入っていない → PJメンバー全員に毎朝
async function remindNextMeeting(env) {
  const now = nowJst();
  const { results: projects } = await env.DB.prepare(
    `SELECT p.id, p.name FROM projects p
     WHERE p.status = 'active' AND p.meeting_mode = 'adhoc'
       AND EXISTS (SELECT 1 FROM meetings m WHERE m.project_id = p.id AND m.cancelled = 0 AND m.kind != 'exchange' AND m.starts_at < ?1)
       AND NOT EXISTS (SELECT 1 FROM meetings m WHERE m.project_id = p.id AND m.cancelled = 0 AND m.starts_at >= ?1)`
  ).bind(now).all();
  for (const p of projects) {
    const { results } = await env.DB.prepare("SELECT user_id FROM project_members WHERE project_id = ?").bind(p.id).all();
    await notify(env, results.map((r) => r.user_id),
      `【リマインド】「${p.name}」の次回MTGの日程がまだ決まっていません。決まったらツールに登録してください。`,
      `#/projects/${p.id}`);
  }
}

// 1日以上止まっている確認待ちのヒアリング申請 → 部門長・代表へ
async function remindReviews(env) {
  const before = Date.now() - 20 * 3600 * 1000;
  const { results } = await env.DB.prepare(
    "SELECT status, COUNT(*) AS n FROM hearings WHERE status IN ('pending', 'head_ok') AND updated_at < ? GROUP BY status"
  ).bind(before).all();
  const count = Object.fromEntries(results.map((r) => [r.status, r.n]));
  if (count.pending) {
    await notify(env, await headIds(env), `【リマインド】部門長の確認を待っているヒアリング申請が${count.pending}件あります。`, "#/hearings");
  }
  if (count.head_ok) {
    await notify(env, await repIds(env), `【リマインド】代表の確認を待っているヒアリング申請が${count.head_ok}件あります。`, "#/hearings");
  }
}
