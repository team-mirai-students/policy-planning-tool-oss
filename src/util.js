// 共通ヘルパー

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "リクエストの形式が正しくありません");
  }
}

export function clean(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// 長い文章（議事録など）：上限を超えたら切り捨てずにエラーにする（黙って切ると、書いた分が消えてしまう）
export function longText(value, max, label) {
  const v = typeof value === "string" ? value.trim() : "";
  if (v.length > max) throw new HttpError(400, `「${label}」が長すぎます（${max.toLocaleString()}字まで。いま${v.length.toLocaleString()}字）。分けて書いてください`);
  return v;
}

export function required(value, max, label) {
  const v = clean(value, max);
  if (!v) throw new HttpError(400, `${label}を入力してください`);
  return v;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function optDate(value, label = "日付") {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !DATE_RE.test(value) || isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new HttpError(400, `${label}の形式が正しくありません`);
  }
  return value;
}

export function reqDate(value, label = "日付") {
  const v = optDate(value, label);
  if (!v) throw new HttpError(400, `${label}を入力してください`);
  return v;
}

export function reqDateTime(value, label = "日時") {
  if (typeof value !== "string" || !DATETIME_RE.test(value) || isNaN(Date.parse(`${value}:00Z`))) {
    throw new HttpError(400, `${label}を入力してください`);
  }
  return value;
}

export function optTime(value) {
  if (!value) return "";
  if (typeof value !== "string" || !TIME_RE.test(value)) throw new HttpError(400, "時刻の形式が正しくありません");
  return value;
}

export function int(value, { min, max, fallback, label = "数値" } = {}) {
  if (value === null || value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new HttpError(400, `${label}を入力してください`);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || (min !== undefined && n < min) || (max !== undefined && n > max)) {
    throw new HttpError(400, `${label}が正しくありません`);
  }
  return n;
}

export function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw new HttpError(400, `${label}が正しくありません`);
  return value;
}

export function optUrl(value) {
  const v = clean(value, 500);
  if (!v) return "";
  if (!/^https?:\/\//i.test(v)) throw new HttpError(400, "URLは http:// か https:// で始めてください");
  return v;
}

// JST の今日 'YYYY-MM-DD' と現在 'YYYY-MM-DDTHH:MM'
export function todayJst(now = Date.now()) {
  return new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export function nowJst(now = Date.now()) {
  return new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 16);
}

// 'YYYY-MM-DDTHH:MM' → '10/8 21:00'（お知らせの文面用）
export function shortDateTime(dt) {
  const [, m, d] = dt.slice(0, 10).split("-").map(Number);
  return `${m}/${d} ${dt.slice(11, 16)}`;
}

export function idList(value) {
  return (value || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// 部門長・代表：管理者メニューで選んだ人（設定ファイルの HEAD_IDS / REP_IDS に書いた人も含める。最初の設定用）
async function roleIds(env, table, envIds) {
  const { results } = await env.DB.prepare(`SELECT user_id FROM ${table}`).all();
  return [...new Set([...idList(envIds), ...results.map((r) => r.user_id)])];
}
export const headIds = (env) => roleIds(env, "heads", env.HEAD_IDS);
export const repIds = (env) => roleIds(env, "reps", env.REP_IDS);
// 部門長・副部門長へのお知らせ（承認待ち・資料の送付・個人PJの開始）を受け取る人＝管理者全員
// 部門長 ＋ ADMIN_IDS ＋ 管理者メニューで足した人（副部門長など。前はここが抜けていて、副部門長に届かなかった）
export async function adminIds(env) {
  const { results } = await env.DB.prepare("SELECT user_id FROM admins").all();
  const ids = [...new Set([...(await headIds(env)), ...idList(env.ADMIN_IDS), ...results.map((r) => r.user_id)])];
  // 受け取る人が1人もいない（部門長も管理者も未設定）と、依頼がどこにも届かない。気づけるようにエラーの記録に残す
  if (!ids.length) console.error("leader notification has no recipients: set 部門長 in the admin menu");
  return ids;
}
export const leaderIds = adminIds;

// 楽観ロック：更新件数が0なら、他の人が先に更新している
export function assertUpdated(result, what = "この内容") {
  if (!result.meta || result.meta.changes === 0) {
    throw new HttpError(409, `${what}は他の人が更新しました。画面を再読み込みしてから、もう一度保存してください`);
  }
}
