// ホームに出すアンケート（管理者が追加する）：PJ決めアンケート／定例の曜日・時間決め／その他のアンケート（多数決・希望を聞く・RCV・STV）
import { HttpError, readJson, clean, required, int, oneOf, nowJst, todayJst } from "../util.js";
import { requireAdmin } from "./common.js";
import { runIrv } from "../rcv.js";
import { stvResults } from "../stv.js";
import { refreshDiscord } from "../discord-post.js";

export const routes = [
  ["GET", "/api/surveys", listSurveys],
  ["POST", "/api/surveys", createSurvey],
  ["GET", "/api/surveys/:id", getSurvey],
  ["PUT", "/api/surveys/:id/answer", saveAnswer],
  ["PATCH", "/api/surveys/:id", updateSurvey],
  ["DELETE", "/api/surveys/:id", deleteSurvey],
  ["POST", "/api/surveys/:id/teirei-schedule", scheduleFromSurvey],
];

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
// 'YYYY-MM' の次の月
export const nextMonth = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};
// その月の最後の日（'YYYY-MM-DD'）
const lastDay = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
};

export const METHODS = { majority: "多数決", wish: "希望を聞く", rcv: "RCV（順位を付けて1つに決める）", stv: "STV（順位を付けて複数に決める）" };
const parse = (s) => ({ ...s, options: JSON.parse(s.options || "[]"), meta: JSON.parse(s.meta || "{}") });

async function loadSurvey(env, id) {
  const s = await env.DB.prepare("SELECT * FROM surveys WHERE id = ?").bind(id).first();
  if (!s) throw new HttpError(404, "アンケートが見つかりません");
  return parse(s);
}

// ホーム：受付中のアンケート（管理者には終わったものも）
async function listSurveys({ env, user }) {
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.kind, s.title, s.method, s.round_id, s.closed_at, s.created_at,
       EXISTS (SELECT 1 FROM survey_answers a WHERE a.survey_id = s.id AND a.user_id = ?) AS answered
     FROM surveys s WHERE s.closed_at IS NULL OR ? ORDER BY s.closed_at IS NOT NULL, s.created_at DESC LIMIT 30`
  ).bind(user.id, user.isAdmin ? 1 : 0).all();
  // PJ決めアンケート：投票済みかは、PJ決めの票で見る
  for (const s of results) {
    if (s.kind === "pj" && s.round_id) {
      s.answered = Boolean(await env.DB.prepare("SELECT 1 FROM seed_votes WHERE round_id = ? AND user_id = ? LIMIT 1").bind(s.round_id, user.id).first());
    }
  }
  return { surveys: results };
}

async function createSurvey({ request, env, user }) {
  requireAdmin(user, "アンケートを追加できるのは、管理者です");
  const body = await readJson(request);
  const now = Date.now();
  if (body.kind === "pj") {
    // PJ決めアンケート：受付中のPJ決め（募集回）に投票しに行く。なければ作る
    const { results } = await env.DB.prepare("SELECT * FROM seed_rounds WHERE archived = 0 AND source != 'survey' ORDER BY created_at DESC").all();
    let round = results.find((r) => !r.deadline || nowJst() < r.deadline);
    if (!round) {
      round = await env.DB.prepare("INSERT INTO seed_rounds (title, deadline, seats, source, created_by, created_at) VALUES ('PJ決め', NULL, 3, '', ?, ?) RETURNING *")
        .bind(user.id, now).first();
    }
    const open = await env.DB.prepare("SELECT id FROM surveys WHERE kind = 'pj' AND round_id = ? AND closed_at IS NULL").bind(round.id).first();
    if (open) return { id: open.id, round_id: round.id, existed: true };
    const row = await env.DB.prepare(
      "INSERT INTO surveys (kind, title, round_id, created_by, created_at) VALUES ('pj', 'PJ決めアンケート', ?, ?, ?) RETURNING id"
    ).bind(round.id, user.id, now).first();
    return { id: row.id, round_id: round.id };
  }
  if (body.kind === "teirei") return createTeireiSurvey(env, user, body, now);
  const method = oneOf(body.method, Object.keys(METHODS), "決め方");
  const options = [...new Set((Array.isArray(body.options) ? body.options : []).map((o) => clean(o, 80)).filter(Boolean))].slice(0, 30);
  if (options.length < 2) throw new HttpError(400, "選択肢を2つ以上入れてください");
  const seats = method === "stv" ? int(body.seats, { min: 1, max: options.length - 1, fallback: 2, label: "決める数" }) : 1;
  const row = await env.DB.prepare(
    "INSERT INTO surveys (kind, title, description, method, options, seats, created_by, created_at) VALUES ('other', ?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).bind(required(body.title, 80, "アンケートの名前"), clean(body.description, 1000), method, JSON.stringify(options), seats, user.id, now).first();
  return { id: row.id };
}

// 定例の曜日・時間決め：どの月の定例か（month）と、候補の曜日・時刻（slots）。答え方は「希望を聞く」（出られるものを全部選ぶ＋ひとこと）
async function createTeireiSurvey(env, user, body, now) {
  const month = typeof body.month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(body.month) ? body.month : null;
  if (!month) throw new HttpError(400, "どの月の定例かを選んでください");
  if (month < todayJst().slice(0, 7)) throw new HttpError(400, "過ぎた月は選べません");
  const seen = new Set();
  const slots = (Array.isArray(body.slots) ? body.slots : []).map((x) => ({
    weekday: int(x?.weekday, { min: 0, max: 6, label: "曜日" }),
    time: typeof x?.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(x.time) ? x.time : null,
  })).filter((x) => x.time && !seen.has(`${x.weekday} ${x.time}`) && seen.add(`${x.weekday} ${x.time}`))
    .sort((a, b) => ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7) || a.time.localeCompare(b.time)) // 月曜から順に
    .slice(0, 30);
  if (slots.length < 2) throw new HttpError(400, "候補（曜日と時刻）を2つ以上選んでください");
  const options = slots.map((x) => `${WEEK[x.weekday]}曜 ${x.time}`);
  const m = Number(month.slice(5));
  const title = clean(body.title, 80) || `${m}月の定例の曜日・時間決め`;
  const row = await env.DB.prepare(
    "INSERT INTO surveys (kind, title, description, method, options, seats, meta, created_by, created_at) VALUES ('teirei', ?, ?, 'wish', ?, 1, ?, ?, ?) RETURNING id"
  ).bind(title, clean(body.description, 1000), JSON.stringify(options), JSON.stringify({ month, slots }), user.id, now).first();
  return { id: row.id };
}

// 結果から「この曜日・時刻で、その月の定例を予定する」（管理者）。定例の予定（dept_schedules）に、その月の1日〜末日で入れる
async function scheduleFromSurvey({ request, env, user, params }) {
  requireAdmin(user, "定例を予定できるのは、部門長・副部門長です");
  const s = await loadSurvey(env, params.id);
  if (s.kind !== "teirei") throw new HttpError(400, "定例の曜日・時間決めのアンケートではありません");
  const body = await readJson(request);
  const slot = s.meta.slots?.[int(body.slot, { min: 0, max: 29, label: "候補" })];
  if (!slot) throw new HttpError(400, "候補が見つかりません");
  const from = `${s.meta.month}-01` < todayJst() ? todayJst() : `${s.meta.month}-01`;
  const to = lastDay(s.meta.month);
  if (to < from) throw new HttpError(400, "その月はもう過ぎています");
  const dup = await env.DB.prepare("SELECT 1 FROM dept_schedules WHERE weekday = ? AND time = ? AND from_date <= ? AND to_date >= ?")
    .bind(slot.weekday, slot.time, to, from).first();
  if (dup) throw new HttpError(400, "その曜日・時刻の定例は、この月にもう予定されています");
  await env.DB.prepare("INSERT INTO dept_schedules (weekday, time, from_date, to_date, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(slot.weekday, slot.time, from, to, user.id, Date.now()).run();
  return { ok: true, label: `${Number(s.meta.month.slice(5))}月の毎週${WEEK[slot.weekday]}曜 ${slot.time}`, from, to };
}

async function getSurvey({ env, user, params }) {
  const s = await loadSurvey(env, params.id);
  const mine = await env.DB.prepare("SELECT answer FROM survey_answers WHERE survey_id = ? AND user_id = ?").bind(s.id, user.id).first();
  const { results } = await env.DB.prepare(
    "SELECT a.user_id, a.answer, a.updated_at, u.name, u.avatar FROM survey_answers a LEFT JOIN users u ON u.id = a.user_id WHERE a.survey_id = ? ORDER BY a.updated_at"
  ).bind(s.id).all();
  const answers = results.map((r) => ({ ...r, answer: JSON.parse(r.answer) }));
  // 結果：管理者はいつでも、みんなは締め切ったあと。だれが何に入れたかは管理者だけ
  const showResults = user.isAdmin || Boolean(s.closed_at);
  return {
    survey: s,
    mine: mine ? JSON.parse(mine.answer) : null,
    count: answers.length,
    results: showResults ? tallySurvey(s, answers.map((a) => a.answer)) : null,
    answers: user.isAdmin ? answers.map((a) => ({ name: a.name, avatar: a.avatar, user_id: a.user_id, picks: a.answer.picks, comment: a.answer.comment || "", updated_at: a.updated_at })) : null,
    canManage: user.isAdmin,
  };
}

// 開票：多数決・希望はそれぞれの票数、RCVは逐次の決選、STVは当選者と各ラウンド
export function tallySurvey(s, answers) {
  const ids = s.options.map((_, i) => String(i));
  const counts = ids.map(() => 0);
  for (const a of answers) {
    const picks = s.method === "majority" ? a.picks.slice(0, 1) : s.method === "wish" ? a.picks : a.picks.slice(0, 1);
    for (const p of picks) if (counts[p] !== undefined) counts[p] += 1;
  }
  const out = { counts, total: answers.length, comments: s.method === "wish" ? answers.map((a) => a.comment).filter(Boolean) : [] };
  const ballots = answers.map((a) => a.picks.map(String));
  if (s.method === "rcv" && ballots.length) {
    const r = runIrv(ballots, ids, ids);
    out.winners = r.winner ? [Number(r.winner)] : [];
    out.rounds = r.rounds.map((x) => ({ tallies: x.tallies, eliminated: x.eliminated, winner: x.winner, majority: x.majority }));
  } else if (s.method === "stv" && ballots.length) {
    const r = stvResults(ballots, ids, s.seats);
    out.winners = r.elected.map(Number);
    out.quota = r.quota;
    out.rounds = r.rounds;
  } else {
    const max = Math.max(0, ...counts);
    out.winners = max ? counts.flatMap((c, i) => (c === max ? [i] : [])) : [];
  }
  return out;
}

async function saveAnswer({ request, env, user, params, ctx }) {
  const s = await loadSurvey(env, params.id);
  if (s.kind === "pj") throw new HttpError(400, "PJ決めアンケートは、PJ決めの画面で投票してください");
  if (s.closed_at) throw new HttpError(400, "このアンケートは締め切りました");
  const body = await readJson(request);
  const picks = [...new Set((Array.isArray(body.picks) ? body.picks : []).map(Number))].filter((n) => Number.isInteger(n) && n >= 0 && n < s.options.length);
  if (!picks.length) throw new HttpError(400, s.method === "majority" ? "1つ選んでください" : "1つ以上選んでください");
  if (s.method === "majority" && picks.length !== 1) throw new HttpError(400, "選べるのは1つです");
  const answer = JSON.stringify({ picks, comment: s.method === "wish" ? clean(body.comment, 500) : "" });
  await env.DB.prepare(
    `INSERT INTO survey_answers (survey_id, user_id, answer, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (survey_id, user_id) DO UPDATE SET answer = excluded.answer, updated_at = excluded.updated_at`
  ).bind(s.id, user.id, answer, Date.now()).run();
  refreshDiscord(env, ctx, "a", s.id); // Discordに投稿してあれば、回答状況を書き直す
  return { ok: true };
}

// 締め切る・再開する（管理者）
async function updateSurvey({ request, env, user, params, ctx }) {
  requireAdmin(user, "アンケートを締め切れるのは、管理者です");
  const s = await loadSurvey(env, params.id);
  const body = await readJson(request);
  await env.DB.prepare("UPDATE surveys SET closed_at = ? WHERE id = ?").bind(body.closed ? s.closed_at || Date.now() : null, s.id).run();
  refreshDiscord(env, ctx, "a", s.id);
  return { ok: true };
}

async function deleteSurvey({ env, user, params, ctx }) {
  requireAdmin(user, "アンケートを削除できるのは、管理者です");
  const s = await loadSurvey(env, params.id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM survey_answers WHERE survey_id = ?").bind(s.id),
    env.DB.prepare("DELETE FROM surveys WHERE id = ?").bind(s.id),
  ]);
  refreshDiscord(env, ctx, "a", s.id); // Discordの投稿は「削除されました」にする
  return { ok: true };
}
