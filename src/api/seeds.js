// PJ決め：募集回・政策の種・リサーチメモ・ランク付け投票・開票・PJ化
import { HttpError, readJson, clean, required, int, optUrl, nowJst, assertUpdated, adminIds } from "../util.js";
import { rcvResults, suggestAssignment } from "../rcv.js";
import { insertProject } from "./projects.js";
import { requireAdmin as requireAdminFor, assertUsers, canEdit } from "./common.js";
import { syncSurveyRound, surveyLinked } from "../survey-sync.js";
import { notify } from "../notify.js";
import { notionConfigured, createProjectPage } from "../notion.js";
import { syncPeopleLater } from "../notion-people.js";
import { refreshDiscord } from "../discord-post.js";

export const routes = [
  ["GET", "/api/rounds", listRounds],
  ["POST", "/api/rounds", createRound],
  ["GET", "/api/rounds/:id", getRound],
  ["PUT", "/api/rounds/:id", updateRound],
  ["POST", "/api/rounds/:id/seeds", createSeed],
  ["POST", "/api/seed-box", openSeedBox],
  ["PUT", "/api/rounds/:id/ballot", saveBallot],
  ["GET", "/api/rounds/:id/results", getResults],
  ["PATCH", "/api/seeds/:id", updateSeed],
  ["DELETE", "/api/seeds/:id", deleteSeed],
  ["GET", "/api/seeds/:id/notes", listNotes],
  ["POST", "/api/seeds/:id/notes", createNote],
  ["DELETE", "/api/notes/:id", deleteNote],
  ["GET", "/api/seeds/:id/comments", listComments],
  ["POST", "/api/seeds/:id/comments", createComment],
  ["DELETE", "/api/seed-comments/:id", deleteComment],
  ["POST", "/api/seeds/:id/project", createProjectFromSeed],
  ["GET", "/api/seeds/:id/project", getSeedProjectFootprint],
  ["DELETE", "/api/seeds/:id/project", undoProjectFromSeed],
  ["POST", "/api/projects/:id/requeue", requeueProject],
];

const CATEGORY_KEYS = ["news", "seicho", "bucho"];

const requireAdmin = (user, what) => requireAdminFor(user, `${what}は管理者だけができます`);

function isClosed(round) {
  return Boolean(round.deadline) && nowJst() >= round.deadline;
}

async function loadRound(env, id) {
  const round = await env.DB.prepare("SELECT * FROM seed_rounds WHERE id = ?").bind(id).first();
  if (!round) throw new HttpError(404, "PJ決めが見つかりません");
  return round;
}

// 希望PJアンケートと連動する募集回は、投票と種の追加・編集・削除をアンケートで行う
function assertNotLinked(round) {
  if (round.source === "survey") throw new HttpError(400, "このPJ決めは希望PJアンケートと連動しています。投票や種の追加・編集はアンケートで行ってください");
}

// 締め切り後は、管理者以外の書き込み（投稿・編集・投票）を止める
function assertOpen(round, user) {
  if (isClosed(round) && !user.isAdmin) throw new HttpError(403, "この募集は締め切られました");
}

function roundFields(body) {
  const deadline = body.deadline ? String(body.deadline) : null;
  if (deadline && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(deadline)) throw new HttpError(400, "締め切りの形式が正しくありません");
  return {
    title: required(body.title, 60, "PJ決めの名前"),
    deadline,
    seats: int(body.seats, { min: 1, max: 10, fallback: 3, label: "決めるPJの数" }),
  };
}

// 「政策の種を出す」：いつでも種を出せるように、受付中の募集回を返す。なければ「次のPJ決め」を作る
// （締め切りなし。管理者があとで名前・締め切り・決めるPJの数を設定する）
async function openSeedBox({ env, user }) {
  const { round, created } = await openRound(env, user);
  return created ? { id: round.id, created } : { id: round.id };
}

async function openRound(env, user) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM seed_rounds WHERE archived = 0 AND source != 'survey' ORDER BY created_at DESC"
  ).all();
  const open = results.find((r) => !isClosed(r));
  if (open) return { round: open };
  const row = await env.DB.prepare(
    "INSERT INTO seed_rounds (title, deadline, seats, source, created_by, created_at) VALUES (?, NULL, 3, '', ?, ?) RETURNING *"
  ).bind("次のPJ決め", user.id, Date.now()).first();
  return { round: row, created: true };
}

// 一時中止（アーカイブ）したPJを、もう一度PJ決めの種として出す。記録はPJに残したまま
// 種を「正式なPJにする」「個人PJとして進める」とき、このPJを記録ごと戻すか選べる（前のPJ）。できるのはPJメンバーと管理者
async function requeueProject({ env, user, params, ctx }) {
  const project = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(params.id).first();
  if (!project) throw new HttpError(404, "PJが見つかりません");
  if (project.status !== "archived") throw new HttpError(400, "PJ決めに入れられるのは、一時中止（アーカイブ）したPJです");
  if (!(await canEdit(env, user, project.id))) throw new HttpError(403, "PJ決めに入れられるのは、PJメンバーと管理者です");
  const already = await env.DB.prepare(
    `SELECT 1 FROM seeds s JOIN seed_rounds r ON r.id = s.round_id
     WHERE s.prev_project_id = ? AND s.project_id IS NULL AND r.archived = 0`
  ).bind(project.id).first();
  if (already) throw new HttpError(400, "このPJは、もうPJ決めに入っています");
  const { round } = await openRound(env, user);
  // そのPJを生んだ種が受付中のPJ決めにあるなら、新しく作らずに、その種をPJ決めに戻す
  const origin = await env.DB.prepare("SELECT id FROM seeds WHERE round_id = ? AND project_id = ?").bind(round.id, project.id).first();
  if (origin) {
    await env.DB.prepare("UPDATE seeds SET project_id = NULL, prev_project_id = ? WHERE id = ?").bind(project.id, origin.id).run();
    refreshDiscord(env, ctx, "r", round.id);
    return { round_id: round.id, round_title: round.title, seed_id: origin.id };
  }
  const title = project.name.slice(0, 60);
  const dup = await env.DB.prepare("SELECT 1 FROM seeds WHERE round_id = ? AND title = ?").bind(round.id, title).first();
  if (dup) throw new HttpError(400, `「${round.title}」に、同じ名前の種がもうあります`);
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO seeds (round_id, title, description, tag, categories, created_by, prev_project_id, sort, created_at, updated_at)
     VALUES (?1, ?2, ?3, '', '[]', ?4, ?5, (SELECT COALESCE(MAX(sort), 0) + 1 FROM seeds WHERE round_id = ?1), ?6, ?6) RETURNING id`
  ).bind(round.id, title, clean(project.description, 400), user.id, project.id, now).first();
  refreshDiscord(env, ctx, "r", round.id);
  return { round_id: round.id, round_title: round.title, seed_id: row.id };
}

async function listRounds({ env }) {
  const { results } = await env.DB.prepare(
    `SELECT r.*, (SELECT COUNT(*) FROM seeds s WHERE s.round_id = r.id) AS seed_count,
            (SELECT COUNT(DISTINCT user_id) FROM seed_votes v WHERE v.round_id = r.id) AS voter_count
     FROM seed_rounds r ORDER BY r.archived, r.created_at DESC`
  ).all();
  return { rounds: results.map((r) => ({ ...r, closed: isClosed(r) })), surveyLinkAvailable: surveyLinked(env) };
}

async function createRound({ request, env, user }) {
  requireAdmin(user, "PJ決めの作成");
  const body = await readJson(request);
  const f = roundFields(body);
  if (body.link_survey && !surveyLinked(env)) throw new HttpError(400, "希望PJアンケートとの連動が設定されていません");
  const row = await env.DB.prepare(
    "INSERT INTO seed_rounds (title, deadline, seats, source, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"
  ).bind(f.title, f.deadline, f.seats, body.link_survey ? "survey" : "", user.id, Date.now()).first();
  return { id: row.id };
}

async function updateRound({ request, env, user, params, ctx }) {
  requireAdmin(user, "PJ決めの設定の変更");
  const round = await loadRound(env, params.id);
  const body = await readJson(request);
  const f = roundFields(body);
  // 連動する募集回の締め切りはアンケートの締め切りに合わせるので、ここでは変えない
  await env.DB.prepare("UPDATE seed_rounds SET title = ?, deadline = ?, seats = ?, archived = ? WHERE id = ?")
    .bind(f.title, round.source === "survey" ? round.deadline : f.deadline, f.seats, body.archived ? 1 : 0, round.id).run();
  const carried = !round.archived && body.archived ? await carryOverSeeds(env, user, round) : 0;
  refreshDiscord(env, ctx, "r", round.id);
  return { ok: true, carried };
}

// アーカイブするとき：PJにならなかった種を、受付中のPJ決め（なければ「次のPJ決め」を作る）へ写す。
// アーカイブした回の記録（種・投票・開票結果）はそのまま残す。リサーチメモとコメントも一緒に写す
async function carryOverSeeds(env, user, round) {
  const { results: seeds } = await env.DB.prepare("SELECT * FROM seeds WHERE round_id = ? AND project_id IS NULL ORDER BY sort, id")
    .bind(round.id).all();
  if (!seeds.length) return 0;
  const { results: rounds } = await env.DB.prepare(
    "SELECT * FROM seed_rounds WHERE archived = 0 AND source != 'survey' AND id != ? ORDER BY created_at DESC"
  ).bind(round.id).all();
  const now = Date.now();
  const target = rounds.find((r) => !isClosed(r)) || await env.DB.prepare(
    "INSERT INTO seed_rounds (title, deadline, seats, source, created_by, created_at) VALUES (?, NULL, 3, '', ?, ?) RETURNING *"
  ).bind("次のPJ決め", user.id, now).first();
  let carried = 0;
  for (const s of seeds) {
    const dup = await env.DB.prepare("SELECT 1 FROM seeds WHERE round_id = ? AND title = ?").bind(target.id, s.title).first();
    if (dup) continue;
    const row = await env.DB.prepare(
      `INSERT INTO seeds (round_id, title, description, tag, icon, categories, created_by, author_name, prev_project_id, sort, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, (SELECT COALESCE(MAX(sort), 0) + 1 FROM seeds WHERE round_id = ?1), ?10, ?11) RETURNING id`
    ).bind(target.id, s.title, s.description, s.tag, s.icon, s.categories, s.created_by, s.author_name, s.prev_project_id, s.created_at, now).first();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO seed_notes (seed_id, user_id, body, url, created_at) SELECT ?, user_id, body, url, created_at FROM seed_notes WHERE seed_id = ? ORDER BY id")
        .bind(row.id, s.id),
      env.DB.prepare("INSERT INTO seed_comments (seed_id, user_id, body, created_at) SELECT ?, user_id, body, created_at FROM seed_comments WHERE seed_id = ? ORDER BY id")
        .bind(row.id, s.id),
    ]);
    carried++;
  }
  return carried;
}

async function getRound({ env, user, params }) {
  const round = await syncSurveyRound(env, await loadRound(env, params.id));
  const [seeds, votes, notes, comments] = await Promise.all([
    env.DB.prepare(
      `SELECT s.*, u.name AS creator_name, p.name AS project_name, pp.name AS prev_project_name FROM seeds s
       LEFT JOIN users u ON u.id = s.created_by LEFT JOIN projects p ON p.id = s.project_id
       LEFT JOIN projects pp ON pp.id = s.prev_project_id AND pp.status = 'archived'
       WHERE s.round_id = ? ORDER BY s.sort, s.id`
    ).bind(round.id).all(),
    env.DB.prepare(
      `SELECT v.seed_id, v.rank, u.id, u.name, u.avatar FROM seed_votes v JOIN users u ON u.id = v.user_id
       WHERE v.round_id = ? ORDER BY v.created_at`
    ).bind(round.id).all(),
    env.DB.prepare(
      `SELECT n.seed_id, COUNT(*) AS n FROM seed_notes n JOIN seeds s ON s.id = n.seed_id WHERE s.round_id = ? GROUP BY n.seed_id`
    ).bind(round.id).all(),
    env.DB.prepare(
      `SELECT c.seed_id, COUNT(*) AS n FROM seed_comments c JOIN seeds s ON s.id = c.seed_id WHERE s.round_id = ? GROUP BY c.seed_id`
    ).bind(round.id).all(),
  ]);
  const closed = isClosed(round);
  const voters = {};
  const firstChoices = {};
  const myBallot = [];
  const myTied = []; // 希望PJアンケートで順位を付ける前の希望（同率）
  for (const v of votes.results) {
    (voters[v.seed_id] ||= []).push({ id: v.id, name: v.name, avatar: v.avatar, rank: v.rank });
    if (v.rank === 1) firstChoices[v.seed_id] = (firstChoices[v.seed_id] || 0) + 1;
    if (v.id === user.id) {
      if (v.rank === 0) myTied.push(v.seed_id);
      else myBallot.push([v.rank, v.seed_id]);
    }
  }
  myBallot.sort((a, b) => a[0] - b[0]);
  const noteCount = Object.fromEntries(notes.results.map((r) => [r.seed_id, r.n]));
  const commentCount = Object.fromEntries(comments.results.map((r) => [r.seed_id, r.n]));
  return {
    round: { ...round, closed },
    surveyUrl: env.SURVEY_URL || "",
    myTied,
    respondents: new Set(votes.results.map((v) => v.id)).size,
    myBallot: myBallot.map(([, id]) => id),
    seeds: seeds.results.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      tag: s.tag,
      icon: s.icon,
      categories: JSON.parse(s.categories),
      author: s.created_by ? s.creator_name : s.author_name || null,
      isMine: s.created_by === user.id,
      manageable: round.source !== "survey" && !s.project_id && (user.isAdmin || (s.created_by === user.id && !closed)),
      project: s.project_id ? { id: s.project_id, name: s.project_name } : null,
      // 前に正式なPJにして取り消したPJ（記録が残っている。もう一度PJにするときに戻せる）
      prevProject: !s.project_id && s.prev_project_name ? { id: s.prev_project_id, name: s.prev_project_name } : null,
      // 誰が何に投票したかは、部門長・副部門長（管理者）だけに見せる。ほかの人には人数だけ
      voters: user.isAdmin ? voters[s.id] || [] : [],
      voterCount: (voters[s.id] || []).length,
      firstChoices: firstChoices[s.id] || 0,
      notes: noteCount[s.id] || 0,
      comments: commentCount[s.id] || 0,
      version: s.version,
    })),
  };
}

function seedFields(body, user) {
  const f = {
    title: required(body.title, 60, "種のタイトル"),
    description: clean(body.description, 400),
    tag: clean(body.tag, 20),
  };
  // 出どころ（ニュース勉強会・政調ピックアップ・部門長セレクト）を付けられるのは管理者だけ
  if (user.isAdmin && Array.isArray(body.categories)) {
    f.categories = JSON.stringify(CATEGORY_KEYS.filter((k) => body.categories.includes(k)));
  }
  return f;
}

async function createSeed({ request, env, user, params, ctx }) {
  const round = await loadRound(env, params.id);
  assertNotLinked(round);
  if (isClosed(round)) throw new HttpError(403, "締め切り後は種を投稿できません");
  const f = seedFields(await readJson(request), user);
  const dup = await env.DB.prepare("SELECT 1 FROM seeds WHERE round_id = ? AND title = ?").bind(round.id, f.title).first();
  if (dup) throw new HttpError(400, "同じタイトルの種がすでにあります");
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO seeds (round_id, title, description, tag, categories, created_by, sort, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, (SELECT COALESCE(MAX(sort), 0) + 1 FROM seeds WHERE round_id = ?1), ?7, ?7) RETURNING id`
  ).bind(round.id, f.title, f.description, f.tag, f.categories || "[]", user.id, now).first();
  refreshDiscord(env, ctx, "r", round.id);
  return { id: row.id };
}

async function loadSeed(env, id) {
  const seed = await env.DB.prepare("SELECT * FROM seeds WHERE id = ?").bind(id).first();
  if (!seed) throw new HttpError(404, "種が見つかりません");
  return seed;
}

// 編集・削除できるのは、投稿した本人（締め切りまで）と管理者。PJになった種は変更しない
async function loadManageableSeed(env, user, id) {
  const seed = await loadSeed(env, id);
  const round = await loadRound(env, seed.round_id);
  assertNotLinked(round);
  if (seed.project_id) throw new HttpError(400, "PJになった種は変更できません");
  if (!user.isAdmin) {
    if (seed.created_by !== user.id) throw new HttpError(403, "この種を変更できるのは、投稿した本人と管理者です");
    assertOpen(round, user);
  }
  return seed;
}

async function updateSeed({ request, env, user, params }) {
  const seed = await loadManageableSeed(env, user, params.id);
  const body = await readJson(request);
  const f = seedFields(body, user);
  const dup = await env.DB.prepare("SELECT 1 FROM seeds WHERE round_id = ? AND title = ? AND id != ?")
    .bind(seed.round_id, f.title, seed.id).first();
  if (dup) throw new HttpError(400, "同じタイトルの種がすでにあります");
  const res = await env.DB.prepare(
    `UPDATE seeds SET title = ?, description = ?, tag = ?, categories = ?, updated_at = ?, version = version + 1
     WHERE id = ? AND version = ?`
  ).bind(f.title, f.description, f.tag, f.categories ?? seed.categories, Date.now(), seed.id,
    int(body.version, { label: "版" })).run();
  assertUpdated(res, "この種");
  return { ok: true };
}

async function deleteSeed({ env, user, params, ctx }) {
  const seed = await loadManageableSeed(env, user, params.id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM seed_votes WHERE seed_id = ?").bind(seed.id),
    env.DB.prepare("DELETE FROM seed_notes WHERE seed_id = ?").bind(seed.id),
    env.DB.prepare("DELETE FROM seed_comments WHERE seed_id = ?").bind(seed.id),
    env.DB.prepare("DELETE FROM seeds WHERE id = ?").bind(seed.id),
    // 消えた種の分、全員の順位を詰める
    env.DB.prepare(
      `UPDATE seed_votes SET rank = (SELECT COUNT(*) FROM seed_votes v2
         WHERE v2.user_id = seed_votes.user_id AND v2.round_id = seed_votes.round_id AND v2.rank <= seed_votes.rank)
       WHERE round_id = ?`
    ).bind(seed.round_id),
  ]);
  refreshDiscord(env, ctx, "r", seed.round_id);
  return { ok: true };
}

// 自分の投票をまるごと置き換える。order は第1希望から順に並べた種のID（選ばないものは入れない）
async function saveBallot({ request, env, user, params, ctx }) {
  const round = await loadRound(env, params.id);
  assertNotLinked(round);
  if (isClosed(round)) throw new HttpError(403, "この募集は締め切られました");
  const { order } = await readJson(request);
  if (!Array.isArray(order) || order.length > 50 || new Set(order).size !== order.length) {
    throw new HttpError(400, "投票の内容が正しくありません");
  }
  const ids = order.map((x) => int(x, { label: "種" }));
  if (ids.length) {
    const { results } = await env.DB.prepare(
      `SELECT id FROM seeds WHERE round_id = ? AND id IN (${ids.map(() => "?").join(",")})`
    ).bind(round.id, ...ids).all();
    if (results.length !== ids.length) throw new HttpError(400, "投票の情報が古くなっています。画面を再読み込みしてください");
  }
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM seed_votes WHERE round_id = ? AND user_id = ?").bind(round.id, user.id),
    ...ids.map((id, i) =>
      env.DB.prepare("INSERT INTO seed_votes (round_id, user_id, seed_id, rank, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(round.id, user.id, id, i + 1, now)),
  ]);
  refreshDiscord(env, ctx, "r", round.id); // Discordに投稿してあれば、投票人数を書き直す
  return { ok: true };
}

async function getResults({ env, url, user, params }) {
  const round = await syncSurveyRound(env, await loadRound(env, params.id));
  // 途中経過を見て順位を変える人が出ないよう、締め切りまでは管理者だけに見せる
  if (!isClosed(round) && !user.isAdmin) throw new HttpError(403, "開票結果は締め切り後に公開されます");
  const seats = int(url.searchParams.get("seats"), { min: 1, max: 10, fallback: round.seats, label: "決めるPJの数" });
  const [seeds, votes] = await Promise.all([
    env.DB.prepare("SELECT id, title, icon, project_id FROM seeds WHERE round_id = ? ORDER BY sort, id").bind(round.id).all(),
    env.DB.prepare(
      `SELECT v.user_id, v.seed_id, v.rank, u.name, u.avatar FROM seed_votes v JOIN users u ON u.id = v.user_id
       WHERE v.round_id = ? ORDER BY v.user_id, v.rank`
    ).bind(round.id).all(),
  ]);
  const ballotsByUser = {};
  const users = {};
  // 1人の票 = 希望を優先順に並べたもの。順位なし（同率）の希望は先頭に1つのグループとしてまとめる
  for (const v of votes.results) {
    const ballot = (ballotsByUser[v.user_id] ||= []);
    if (v.rank === 0) {
      if (!Array.isArray(ballot[0])) ballot.unshift([]);
      ballot[0].push(v.seed_id);
    } else {
      ballot.push(v.seed_id);
    }
    users[v.user_id] = { id: v.user_id, name: v.name, avatar: v.avatar };
  }
  const order = seeds.results.map((s) => s.id);
  const winners = rcvResults(Object.values(ballotsByUser), order, seats);
  const assignment = suggestAssignment(ballotsByUser, winners.map((w) => w.winner));
  // 誰が何に投票したか（割り振り案・各投票者の希望順）は、部門長・副部門長（管理者）だけに返す
  const secret = user.isAdmin ? {
    users: Object.values(users),
    // 各投票者の希望順（割り振りを手で調整するときの参考）
    ballotsByUser,
    assignment,
  } : { users: [], ballotsByUser: {}, assignment: { byWinner: {}, unassigned: [] } };
  return {
    seats,
    ballots: Object.keys(ballotsByUser).length,
    seeds: seeds.results,
    winners,
    ...secret,
  };
}

async function listNotes({ env, params }) {
  const seed = await loadSeed(env, params.id);
  const { results } = await env.DB.prepare(
    `SELECT n.id, n.body, n.url, n.created_at, n.user_id, u.name, u.avatar FROM seed_notes n
     JOIN users u ON u.id = n.user_id WHERE n.seed_id = ? ORDER BY n.created_at`
  ).bind(seed.id).all();
  return { notes: results };
}

async function createNote({ request, env, user, params }) {
  const seed = await loadSeed(env, params.id);
  const body = await readJson(request);
  await env.DB.prepare("INSERT INTO seed_notes (seed_id, user_id, body, url, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(seed.id, user.id, required(body.body, 600, "メモ"), optUrl(body.url), Date.now()).run();
  return { ok: true };
}

async function deleteNote({ env, user, params }) {
  const note = await env.DB.prepare("SELECT * FROM seed_notes WHERE id = ?").bind(params.id).first();
  if (!note) throw new HttpError(404, "メモが見つかりません");
  if (note.user_id !== user.id && !user.isAdmin) throw new HttpError(403, "メモを削除できるのは書いた本人と管理者です");
  await env.DB.prepare("DELETE FROM seed_notes WHERE id = ?").bind(note.id).run();
  return { ok: true };
}

// 種を正式なPJにする（管理者）。投票は外部のアンケートで行うこともあるので、開票結果がなくても作れる
// personal=true は「個人PJとして進める」：だれでもできる。始めた人は必ずメンバーに入り、管理者にお知らせが届く
async function createProjectFromSeed({ request, env, user, params, ctx }) {
  const body = await readJson(request);
  const personal = Boolean(body.personal);
  if (!personal) requireAdmin(user, "種を正式なPJにすること");
  const seed = await loadSeed(env, params.id);
  if (seed.project_id) throw new HttpError(400, "この種はすでにPJになっています");
  if (body.restore) {
    const res = await restoreProjectFromSeed(env, user, seed, body, personal);
    if (personal) await notifyPersonalStart(env, user, res.id);
    syncPeopleLater(env, ctx, [res.id]);
    return res;
  }
  const projectId = await insertProject(env, user, {
    meeting_mode: "adhoc",
    ...body,
    description: body.description ?? seed.description,
  }, { includeCreator: personal });
  // 同時に2回押されても、PJに結び付くのは最初の1つだけ
  const res = await env.DB.prepare("UPDATE seeds SET project_id = ? WHERE id = ? AND project_id IS NULL")
    .bind(projectId, seed.id).run();
  if (!res.meta.changes) {
    await env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(projectId).run();
    throw new HttpError(409, "この種はすでにPJになっています");
  }
  if (personal) {
    await env.DB.prepare("UPDATE projects SET personal = 1 WHERE id = ?").bind(projectId).run();
    await notifyPersonalStart(env, user, projectId);
  }
  if (notionConfigured(env)) ctx?.waitUntil(makeNotionProjectPage(env, projectId).catch((err) => console.error("notion project page failed", err?.status, err?.code || err?.message)));
  return { id: projectId };
}

// NotionにPJのページを作る：題名＝PJ名、参加者＝人事のとおり（Notionアカウントを対応づけた人）、中に見出し「議事録」
// 作ったページをPJのNotionページとして登録するので、そのあとのMTGの議事録は、この下に自動で入る
async function makeNotionProjectPage(env, projectId) {
  const project = await env.DB.prepare("SELECT id, name, notion_url FROM projects WHERE id = ?").bind(projectId).first();
  if (!project || project.notion_url) return;
  const { results } = await env.DB.prepare(
    "SELECT u.notion_user_id FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? AND u.notion_user_id != ''"
  ).bind(projectId).all();
  const sample = await env.DB.prepare("SELECT notion_url FROM projects WHERE notion_url != '' AND notion_url IS NOT NULL ORDER BY id DESC LIMIT 1").first();
  const url = await createProjectPage(env, { name: project.name, notionUserIds: results.map((r) => r.notion_user_id), sampleUrl: sample?.notion_url });
  if (url) await env.DB.prepare("UPDATE projects SET notion_url = ? WHERE id = ? AND (notion_url IS NULL OR notion_url = '')").bind(url, projectId).run();
}

// 個人PJとして始まったことを、管理者全員に知らせる
async function notifyPersonalStart(env, user, projectId) {
  const project = await env.DB.prepare("SELECT name FROM projects WHERE id = ?").bind(projectId).first();
  await notify(env, await adminIds(env), `${user.name}さんが「${project.name}」を個人PJとして始めました`, `#/projects/${projectId}`);
}

// 取り消したPJを戻す：議事録・タスク・MTGなどの記録はそのまま。名前・概要・メンバーは、いま選んだもので上書きする
async function restoreProjectFromSeed(env, user, seed, body, personal = false) {
  const prev = seed.prev_project_id
    ? await env.DB.prepare("SELECT * FROM projects WHERE id = ? AND status = 'archived'").bind(seed.prev_project_id).first() : null;
  if (!prev) throw new HttpError(400, "戻せる前のPJがありません。新しく作ってください");
  // 個人PJとして戻すときは、戻した人も必ずメンバーに入る
  const members = [...new Set([...(personal ? [user.id] : []), ...(Array.isArray(body.member_ids) ? body.member_ids : []).filter((x) => typeof x === "string")])].slice(0, 30);
  if (!members.length) throw new HttpError(400, "メンバーを1人以上選んでください");
  await assertUsers(env, members);
  const { results: before } = await env.DB.prepare("SELECT user_id FROM project_members WHERE project_id = ?").bind(prev.id).all();
  const res = await env.DB.prepare("UPDATE seeds SET project_id = ?, prev_project_id = NULL WHERE id = ? AND project_id IS NULL")
    .bind(prev.id, seed.id).run();
  if (!res.meta.changes) throw new HttpError(409, "この種はすでにPJになっています");
  await env.DB.batch([
    env.DB.prepare("UPDATE projects SET status = 'active', personal = ?, name = ?, description = ?, updated_at = ?, version = version + 1 WHERE id = ?")
      .bind(personal ? 1 : 0, required(body.name, 60, "PJ名"), clean(body.description ?? prev.description, 400), Date.now(), prev.id),
    env.DB.prepare("DELETE FROM project_members WHERE project_id = ?").bind(prev.id),
    ...members.map((uid) => env.DB.prepare("INSERT INTO project_members (project_id, user_id) VALUES (?, ?)").bind(prev.id, uid)),
  ]);
  const added = members.filter((uid) => !before.some((b) => b.user_id === uid));
  await notify(env, added, `「${clean(body.name, 60)}」のメンバーになりました`, `#/projects/${prev.id}`, { dm: false, except: user.id });
  return { id: prev.id, restored: true };
}

// 「正式なPJにする」の取り消し（管理者）。PJは削除せずアーカイブ（一覧から隠す）にして、議事録・タスクなどの記録は残す
// 種はPJ決めに戻り、もう一度PJにするときは、このPJを戻すか新しく作るかを選べる
async function seedProject(env, user, seedId) {
  requireAdmin(user, "正式なPJの取り消し");
  const seed = await loadSeed(env, seedId);
  if (!seed.project_id) throw new HttpError(400, "この種はPJになっていません");
  const project = await env.DB.prepare("SELECT id, name FROM projects WHERE id = ?").bind(seed.project_id).first();
  if (!project) throw new HttpError(404, "PJが見つかりません");
  return project;
}

// 取り消す前に、残る記録の件数を見せる
async function getSeedProjectFootprint({ env, user, params }) {
  const project = await seedProject(env, user, params.id);
  const count = (sql) => env.DB.prepare(sql).bind(project.id).first().then((r) => r.n);
  const [members, meetings, minutes, tasks, checked, hearings] = await Promise.all([
    count("SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?"),
    count("SELECT COUNT(*) AS n FROM meetings WHERE project_id = ? AND cancelled = 0"),
    count("SELECT COUNT(*) AS n FROM minutes WHERE project_id = ?"),
    count("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?"),
    count("SELECT COUNT(*) AS n FROM checklist_items WHERE project_id = ? AND done_at IS NOT NULL AND stage_no > 0"),
    count("SELECT COUNT(*) AS n FROM hearings WHERE project_id = ?"),
  ]);
  return { project, counts: { members, meetings, minutes, tasks, checked, hearings } };
}

async function undoProjectFromSeed({ request, env, user, params }) {
  const project = await seedProject(env, user, params.id);
  const body = await readJson(request);
  // 確認した画面と違うPJを消さないよう、確認したPJのIDを一緒に送ってもらう
  if (Number(body.project_id) !== project.id) throw new HttpError(409, "PJの状態が変わりました。画面を再読み込みしてください");
  const { results: members } = await env.DB.prepare("SELECT user_id FROM project_members WHERE project_id = ?").bind(project.id).all();
  // 削除はしない：PJはアーカイブにして記録を残し、種との結び付きを外す（前のPJとして覚えておく）
  await env.DB.batch([
    env.DB.prepare("UPDATE projects SET status = 'archived', updated_at = ? WHERE id = ?").bind(Date.now(), project.id),
    env.DB.prepare("UPDATE seeds SET project_id = NULL, prev_project_id = ? WHERE id = ?").bind(project.id, params.id),
  ]);
  await notify(env, members.map((m) => m.user_id), `「${project.name}」は正式なPJから取り消されました（議事録などの記録は残っています）`, "#/seeds", { dm: false, except: user.id });
  return { ok: true };
}

// ---------- 種へのコメント（誰でも書ける。消せるのは書いた本人と管理者） ----------
async function listComments({ env, params }) {
  const seed = await loadSeed(env, params.id);
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.body, c.created_at, c.user_id, u.name, u.avatar FROM seed_comments c
     JOIN users u ON u.id = c.user_id WHERE c.seed_id = ? ORDER BY c.created_at`
  ).bind(seed.id).all();
  return { comments: results };
}

async function createComment({ request, env, user, params }) {
  const seed = await loadSeed(env, params.id);
  const body = await readJson(request);
  await env.DB.prepare("INSERT INTO seed_comments (seed_id, user_id, body, created_at) VALUES (?, ?, ?, ?)")
    .bind(seed.id, user.id, required(body.body, 600, "コメント"), Date.now()).run();
  return { ok: true };
}

async function deleteComment({ env, user, params }) {
  const c = await env.DB.prepare("SELECT * FROM seed_comments WHERE id = ?").bind(params.id).first();
  if (!c) throw new HttpError(404, "コメントが見つかりません");
  if (c.user_id !== user.id && !user.isAdmin) throw new HttpError(403, "コメントを削除できるのは書いた本人と管理者です");
  await env.DB.prepare("DELETE FROM seed_comments WHERE id = ?").bind(c.id).run();
  return { ok: true };
}
