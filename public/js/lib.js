import { ico } from "./icons.js";
// 画面共通の小道具。データはすべてサーバーに保存する（ブラウザには、まだ送れていない書きかけだけを一時的に置く）

// ログイン中の情報（ユーザー・メンバー一覧・PJの型）。画面間で共有するだけで、ブラウザには保存しない
export const state = { me: null, users: [], types: {}, showDoneTasks: false };

// 先読み：押されそうなリンクの行き先のデータを、押す前に取りに行っておく（数秒だけ・1回だけ使う）
const prefetched = new Map();
const PREFETCH_TTL = 8000;
export function prefetch(path) {
  const hit = prefetched.get(path);
  if (hit && Date.now() - hit.at < PREFETCH_TTL) return;
  const promise = fetch(path, { credentials: "same-origin" })
    .then(async (res) => ({ status: res.status, ok: res.ok, data: await res.json().catch(() => ({})) }));
  promise.catch(() => prefetched.delete(path));
  prefetched.set(path, { at: Date.now(), promise });
}

// keepalive：画面を閉じる・アプリを切り替えるときの保存。ページが閉じても送り切る（ブラウザの決まりで、64KBまで）
export async function api(path, { method = "GET", body, keepalive = false } = {}) {
  // 書き込んだら、先読みした古いデータは使わない
  if (method !== "GET") prefetched.clear();
  const hit = method === "GET" && prefetched.get(path);
  if (hit) prefetched.delete(path);
  const res = hit && Date.now() - hit.at < PREFETCH_TTL
    ? await hit.promise.catch(() => null)
    : null;
  if (res) return handleResponse(res.status, res.ok, res.data);
  const json = body === undefined ? undefined : JSON.stringify(body);
  const raw = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: json,
    credentials: "same-origin",
    keepalive: Boolean(keepalive && json && new Blob([json]).size < 60000),
  }).catch(() => { throw new Error("通信できませんでした。電波・接続を確かめてください"); });
  return handleResponse(raw.status, raw.ok, await raw.json().catch(() => ({})));
}

function handleResponse(status, ok, data) {
  if (status === 401) {
    const login = `/?returnTo=${encodeURIComponent(location.pathname + location.hash)}`;
    // 書きかけがあるときは、勝手にログイン画面へ移らない（書きかけは端末に残っているので、ログインし直せば戻る）
    if (hasUnsaved()) {
      setSaveAlert("login", `${ico("warning")} ログインが切れました。書いた内容はこの端末に残っています。<a href="${esc(login)}">ログインし直す</a>と、続きから保存されます`);
      throw new Error("ログインが切れました");
    }
    location.href = login;
    throw new Error("ログインしてください");
  }
  // ログインが通った（ログインし直した・一時的なものだった）ら、「ログインが切れました」の帯を消す
  if (alerts.has("login")) setSaveAlert("login", null);
  if (!ok) throw new Error(data.error || "通信に失敗しました");
  return data;
}

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
export { WEEK };

export function fmtDate(date) {
  if (!date) return "";
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEK[d.getUTCDay()]}）`;
}

export function fmtDateTime(dt) {
  if (!dt) return "";
  return `${fmtDate(dt)} ${dt.slice(11, 16)}`;
}

// 日本時間の 'YYYY-MM-DDTHH:MM'（ms を省くと今）
export function jstDateTime(ms = Date.now()) {
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 16);
}

export function todayStr() {
  return jstDateTime().slice(0, 10);
}

export function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 次の月曜日（PJの開始日の初期値）
export function nextMonday() {
  const t = todayStr();
  const wd = new Date(`${t}T00:00:00Z`).getUTCDay();
  return addDays(t, ((8 - wd) % 7) || 7);
}

function daysUntil(date) {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${todayStr()}T00:00:00Z`)) / 86400000);
}

// 期限のバッジ（過ぎた／今日／あと何日）
export function dueBadge(date, done = false) {
  if (!date) return "";
  if (done) return `<span class="due">${fmtDate(date)}</span>`;
  const n = daysUntil(date);
  const cls = n < 0 ? "due is-over" : n <= 2 ? "due is-soon" : "due";
  const note = n < 0 ? `${-n}日超過` : n === 0 ? "今日" : `あと${n}日`;
  return `<span class="${cls}">${fmtDate(date)}・${note}</span>`;
}

export function avatar(user, size = "") {
  if (!user) return "";
  const inner = user.avatar ? `<img src="${esc(user.avatar)}" alt="">` : esc((user.name || "?").slice(0, 1));
  return `<span class="avatar ${size}" title="${esc(user.name)}">${inner}</span>`;
}

// Googleカレンダーの「予定を追加」画面を開くURL（OAuth不要）
function gcalStamp(dt) {
  return `${dt.replace(/[-:]/g, "")}00`;
}

function addMinutes(dt, minutes) {
  const d = new Date(`${dt}:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString().slice(0, 16);
}

export function gcalEventUrl({ title, start, durationMin = 60, details = "", location = "", recur = "" }) {
  const p = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${gcalStamp(start)}/${gcalStamp(addMinutes(start, durationMin))}`,
    ctz: "Asia/Tokyo",
  });
  if (details) p.set("details", details);
  if (location) p.set("location", location);
  if (recur) p.set("recur", `RRULE:${recur}`);
  return `https://calendar.google.com/calendar/render?${p}`;
}

// 終日の予定（タスクの期限など）
export function gcalAllDayUrl({ title, date, details = "" }) {
  const p = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${date.replace(/-/g, "")}/${addDays(date, 1).replace(/-/g, "")}`,
    ctz: "Asia/Tokyo",
  });
  if (details) p.set("details", details);
  return `https://calendar.google.com/calendar/render?${p}`;
}

export function gcalLink(url, label = "Googleカレンダーに追加") {
  return `<a class="gcal" href="${esc(url)}" target="_blank" rel="noopener">${calendarIcon}${label}</a>`;
}

// 定例（毎週・隔週など）の繰り返しのルール。weekdays：曜日の番号（"1,4" または [1, 4]）
export function weeklyRrule(weekdays, interval = 1) {
  const days = (Array.isArray(weekdays) ? weekdays : String(weekdays || "").split(",")).filter((d) => d !== "").map(Number);
  return days.length ? `FREQ=WEEKLY;INTERVAL=${interval || 1};WKST=SU;BYDAY=${days.map((d) => ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][d]).join(",")}` : "";
}

// 定例の回をカレンダーに入れるとき：「この回だけ」か「毎回（繰り返し）」かを選べるようにする。series がなければふつうのリンク
export function gcalChoice(single, series, label = "Googleカレンダーに追加") {
  if (!series) return gcalLink(single, label);
  const ics = seriesIcsUrl(series);
  // スマホのGoogleカレンダー（アプリ）は、リンクの「くり返し」を無視して1回分だけ入れてしまう。スマホではカレンダーファイルを先に出す
  const phone = window.matchMedia("(pointer: coarse)").matches;
  const google = `<a href="${esc(series)}" target="_blank" rel="noopener">定例をまとめて追加（Googleカレンダー${phone ? "・PC向け" : ""}）</a>`;
  const file = ics ? `<a href="${esc(ics)}" download>定例をまとめて追加（カレンダーファイル${phone ? "" : "・スマホ向け"}）</a>` : "";
  return `<details class="gcal-choice">
    <summary class="gcal">${calendarIcon}${label}</summary>
    <div class="gcal-menu">
      <a href="${esc(single)}" target="_blank" rel="noopener">この回だけ追加</a>
      ${phone ? file + google : google + file}
    </div>
  </details>`;
}

// Googleカレンダーの「くり返し」のリンクから、同じ内容のカレンダーファイル（.ics）のURLを作る
function seriesIcsUrl(googleUrl) {
  try {
    const q = new URL(googleUrl).searchParams;
    const [a, b] = (q.get("dates") || "").split("/");
    const toDt = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}`;
    const start = toDt(a), end = toDt(b);
    const dur = Math.round((new Date(`${end}:00Z`) - new Date(`${start}:00Z`)) / 60000);
    const p = new URLSearchParams({ title: q.get("text") || "", start, dur: String(dur || 60), rrule: (q.get("recur") || "").replace(/^RRULE:/, "") });
    if (q.get("location")) p.set("loc", q.get("location"));
    return `/api/ics/series?${p}`;
  } catch {
    return "";
  }
}
// メニューの外を押したとき・選んだときは閉じる
document.addEventListener("click", (e) => {
  document.querySelectorAll(".gcal-choice[open]").forEach((d) => {
    if (!d.contains(e.target) || e.target.closest(".gcal-menu a")) d.removeAttribute("open");
  });
});

const calendarIcon = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M7 2h2v2h6V2h2v2h3a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3V2Zm12 8H5v9h14v-9ZM5 8h14V6H5v2Zm2 4h4v4H7v-4Z"/></svg>`;

let toastTimer;
export function toast(message, kind = "") {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.setAttribute("role", "status");
    document.body.append(el);
  }
  // 何かをやり遂げたときの知らせは、ポンと弾ませて、絵文字をはじけさせる
  const win = kind !== "error" && WIN_WORDS.find(([re]) => re.test(message));
  el.className = "toast";
  void el.offsetWidth;
  el.className = `toast show ${kind} ${win ? "is-win" : ""}`;
  el.textContent = message;
  if (win) {
    const r = el.getBoundingClientRect();
    burst({ x: r.left + r.width / 2, y: r.top }, { emoji: win[1], count: 10, spread: 120 });
  }
  clearTimeout(toastTimer);
  // 読み終わるまで出しておく（1文字0.08秒＋1.5秒。短くても3秒、長くても9秒。うまくいかなかった知らせは＋2秒）
  const ms = Math.min(9000, Math.max(3000, 1500 + message.length * 80)) + (kind === "error" ? 2000 : 0);
  toastTimer = setTimeout(() => (el.className = "toast"), ms);
}

// 知らせの言葉 → はじける絵文字
const WIN_WORDS = [
  [/種を投稿/, ["🌱", "🌿", "✨"]],
  [/投票/, ["🗳️", "✨", "⭐"]],
  [/PJを作成|PJになりました|正式なPJ/, ["🚀", "🎉", "✨"]],
  [/タスクを追加/, ["✅", "✨"]],
  [/提出|申請を出し|再申請/, ["📮", "✨", "⭐"]],
  [/追加しました|作成しました|決めました|PMにしました/, ["✨", "⭐", "🎉"]],
  [/保存しました|書きました/, ["✨", "💫"]],
];

const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// はじける演出：point（{x, y} か 要素）から、粒や絵文字が四方に飛ぶ。画面を描き直しても消えないよう body に置く
export function burst(point, { emoji = null, count = 14, spread = 90, ring = true } = {}) {
  if (reduceMotion()) return;
  const r = point instanceof Element ? point.getBoundingClientRect() : null;
  const x = r ? r.left + r.width / 2 : point.x, y = r ? r.top + r.height / 2 : point.y;
  const layer = document.createElement("div");
  layer.className = "burst-layer";
  layer.style.left = `${x}px`;
  layer.style.top = `${y}px`;
  const colors = ["#3fc58f", "#63d9c7", "#ffd7b5", "#ffb84d", "#8fdcb9"];
  let html = ring ? `<span class="burst-ring"></span>` : "";
  for (let i = 0; i < count; i++) {
    const a = (Math.PI * 2 * i) / count + Math.random() * 0.5;
    const d = spread * (0.6 + Math.random() * 0.6);
    const dx = Math.cos(a) * d, dy = Math.sin(a) * d - spread * 0.25;
    const style = `--dx:${dx.toFixed(0)}px;--dy:${dy.toFixed(0)}px;--rot:${Math.round(Math.random() * 360)}deg;animation-delay:${(Math.random() * 0.06).toFixed(2)}s`;
    html += emoji
      ? `<span class="burst-emoji" style="${style}">${emoji[i % emoji.length]}</span>`
      : `<span class="burst-dot" style="${style};background:${colors[i % colors.length]}"></span>`;
  }
  layer.innerHTML = html;
  document.body.append(layer);
  setTimeout(() => layer.remove(), 1100);
}

// 「+1」が浮かぶ（連続で済ませると、コンボの数と炎が出る）
let combo = { n: 0, at: 0 };
export function plusOne(point) {
  if (reduceMotion()) return;
  const now = Date.now();
  combo = now - combo.at < 45000 ? { n: combo.n + 1, at: now } : { n: 1, at: now };
  const r = point instanceof Element ? point.getBoundingClientRect() : { left: point.x, top: point.y, width: 0 };
  const t = document.createElement("div");
  t.className = `plus-one ${combo.n >= 3 ? "is-combo" : ""}`;
  t.textContent = combo.n >= 3 ? `🔥 ${combo.n}連続！` : combo.n === 2 ? "+1 ✨" : "+1";
  t.style.left = `${r.left + r.width / 2}px`;
  t.style.top = `${r.top}px`;
  document.body.append(t);
  setTimeout(() => t.remove(), 1200);
  if (combo.n === 3 || combo.n === 5 || combo.n === 10) {
    burst({ x: r.left + r.width / 2, y: r.top }, { emoji: ["🔥", "⭐", "✨"], count: 14, spread: 140 });
  }
}

// 送信中はボタンを止めて、失敗したらトーストで知らせる
export async function busy(button, fn) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (e) {
    if (!e.silent) toast(e.message, "error"); // 確認画面で「キャンセル」したときなどは出さない
    throw e;
  } finally {
    if (button) button.disabled = false;
  }
}

// PJメンバーを先に、ほかのメンバーを後ろに並べる（担当者を選ぶとき用）
export function membersFirst(members, users = state.users) {
  const ids = new Set(members.map((m) => m.id));
  return [...members, ...users.filter((u) => !ids.has(u.id))];
}

export function memberOptions(users, selected, { empty = "（未定）" } = {}) {
  return `<option value="">${esc(empty)}</option>` +
    users.map((u) => `<option value="${esc(u.id)}" ${u.id === selected ? "selected" : ""}>${esc(u.name)}</option>`).join("");
}

// Googleドキュメント・スライド・スプレッドシートは、埋め込み用のURLに変える（ほかは埋め込まない）
export function embedUrl(url) {
  const m = (url || "").match(/^https:\/\/docs\.google\.com\/(document|presentation|spreadsheets)\/d\/([\w-]+)/);
  if (!m) return null;
  const [, kind, id] = m;
  if (kind === "presentation") return `https://docs.google.com/presentation/d/${id}/embed`;
  return `https://docs.google.com/${kind}/d/${id}/preview`;
}

// 工程の数直線（PJ画面の上部とPJ一覧のカードで共通）。compact：カード用に日付を曜日なしで短く
// progress：いまの工程のチェックの進み具合（0〜1）。次の工程への線が、その分だけ伸びる
export function stageStepper(project, stages, { compact = false, progress = null } = {}) {
  const type = state.types[project.type];
  if (!type) return "";
  const done = project.status === "done";
  const due = (no) => stages.find((s) => s.stage_no === no)?.due_date;
  return `<ol class="stepper">${type.stages.map((s) => {
    const past = done || s.no < project.current_stage;
    const cls = past ? "is-done" : s.no === project.current_stage ? "is-current" : "";
    const isNext = !done && progress !== null && s.no === project.current_stage + 1;
    return `<li class="${cls}${isNext ? " is-next" : ""}" ${isNext ? `style="--fill:${progress.toFixed(3)}"` : ""}><span class="dot">${past ? "✓" : s.no}</span>
      <span class="label">${esc(s.name)}</span><span class="date">${due(s.no) ? (compact ? due(s.no).slice(5).replace("-", "/").replace(/(^|\/)0/g, "$1") : fmtDate(due(s.no))) : ""}</span></li>`;
  }).join("")}</ol>`;
}

// 議事録などを、Notionに貼ると見出し・箇条書き・チェックボックスになるMarkdownでコピーする
// Notion用にコピー：Notionに貼ると、見出し・箇条書き・チェック・トグル・リンクなどがそのままのブロックになる形（HTML）と、文字（Markdown）の両方を入れる
export async function copyForNotion(markdown) {
  const text = `${markdown.trim()}\n`;
  try {
    const { notionHtml } = await import("./notion-html.js");
    const html = `<meta charset="utf-8">${notionHtml(text)}`;
    await navigator.clipboard.write([new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([text], { type: "text/plain" }),
    })]);
  } catch {
    await copyText(text); // HTMLでコピーできないブラウザでは、文字だけ
  }
  toast("Notion用にコピーしました。Notionに貼り付けてください");
}

// 項目ごとのコピーボタン。押すと bindCopyButtons に渡した関数で、その項目のMarkdownを作ってコピーする
export const copyButton = (key) => `<button type="button" class="copy-btn" data-copy="${esc(key)}" title="この項目をNotion用にコピー">${ico("clipboard")} コピー</button>`;

export function bindCopyButtons(el, toMarkdown) {
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-copy]");
    if (b) copyForNotion(toMarkdown(b.dataset.copy));
  });
}

// 役割（role）から工程番号を探す（工程を足しても番号に頼らないように）
export function stageNoOf(type, role) {
  return state.types[type]?.stages.find((s) => s.role === role)?.no;
}

// 「完了したタスクも表示」の切り替え。選んだ状態は画面を移っても続く（ブラウザには保存しない）
export const doneTasksToggle = (count) =>
  `<label class="check small"><input type="checkbox" data-show-done ${state.showDoneTasks ? "checked" : ""}> 完了したタスクも表示${count === undefined ? "" : `（${count}）`}</label>`;

export function bindDoneTasksToggle(root, redraw) {
  root.querySelector("[data-show-done]")?.addEventListener("change", (e) => {
    state.showDoneTasks = e.target.checked;
    redraw();
  });
}

// PJを選ぶだけの途中のページ用：PJ名だけを並べる（参加中を上に、ほかのPJは折りたたむ）
// 詳しい情報は、選んだ先のページに出す
export function pjPicker(projects, item, { empty = "参加している進行中のPJがありません。" } = {}) {
  const isMine = (p) => Boolean(p.isMine ?? p.is_mine);
  const mine = projects.filter(isMine);
  const others = projects.filter((p) => !isMine(p));
  const list = (ps) => `<ul class="pick-list">${ps.map(item).join("")}</ul>`;
  if (!projects.length) return `<div class="empty"><p>${empty}</p></div>`;
  return `${mine.length ? list(mine) : `<p class="muted">${empty}</p>`}
    ${others.length ? `<details class="pick-others"><summary>ほかのPJ（${others.length}）</summary>${list(others)}</details>` : ""}`;
}

// リストの1行。href があればリンク、なければボタン（attrs で data-* を渡す）。after は行の下に出す欄
export const pickItem = ({ href, attrs = "", name, note = "", after = "" }) => `
  <li>${href ? `<a class="pick" href="${href}">` : `<button type="button" class="pick" ${attrs}>`}
    <span class="pick-name">${esc(name)}</span>${note ? `<span class="pick-note">${note}</span>` : ""}<span class="pick-arrow" aria-hidden="true">›</span>
  ${href ? "</a>" : "</button>"}${after}</li>`;

export function hashQuery() {
  return new URLSearchParams(location.hash.split("?")[1] || "");
}

export const TASK_STATUS ={ todo: "未着手", doing: "進行中", done: "完了" };

export function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

// ページ内の確認ダイアログ。ブラウザ標準の confirm() は、アプリ内ブラウザ（Discordアプリなど）で出ないことがあるので使わない
// 削除・取り消しなど元に戻せない操作は、OKボタンを赤くする
export function confirmDialog(message, { ok } = {}) {
  const danger = /削除|外し|取り下げ|中止|取り消/.test(message);
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "dialog-backdrop";
    back.innerHTML = `
      <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-msg">
        <p id="dialog-msg">${esc(message)}</p>
        <div class="form-actions">
          <button type="button" data-no>キャンセル</button>
          <button type="button" class="${danger ? "danger" : "primary"}" data-yes>${esc(ok || (danger ? "はい、実行する" : "OK"))}</button>
        </div>
      </div>`;
    const prev = document.activeElement;
    const done = (value) => {
      back.remove();
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
      resolve(value);
    };
    const onKey = (e) => { if (e.key === "Escape") done(false); };
    back.addEventListener("click", (e) => { if (e.target === back) done(false); });
    back.querySelector("[data-no]").addEventListener("click", () => done(false));
    back.querySelector("[data-yes]").addEventListener("click", () => done(true));
    document.addEventListener("keydown", onKey);
    document.body.append(back);
    back.querySelector("[data-yes]").focus();
  });
}

// ---------- タイマー（MTG・定例は自動で開始、発表は手動） ----------
// 状態は開いているあいだだけ覚える（ブラウザには保存しない）。key ごとに、画面を移って戻っても続きから数える
const timers = new Map();
const fmtElapsed = (ms) => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const mm = String(Math.floor((sec % 3600) / 60)).padStart(h ? 2 : 1, "0");
  return `${h ? `${h}:` : ""}${mm}:${String(sec % 60).padStart(2, "0")}`;
};

// auto：開いたら自動で数え始める。since：この時刻（ms）から数える（定例を始めた時刻など）。target：目標時間を選べるようにする（発表）
// bar：スクロールしても画面の上に残る1行のタイマー。経過時間で色が変わる（MTG・定例）
export function timerHtml(key, { target = false, bar = false } = {}) {
  return `<div class="timer ${bar ? "timer-bar" : ""}" data-timer="${esc(key)}">
    <span class="timer-icon" aria-hidden="true">${ico("timer")}</span><span class="timer-time" aria-live="off">0:00</span>
    <span class="timer-note muted small"></span>
    ${target ? `<select class="timer-target" aria-label="目標時間"><option value="0">目標なし</option>${[3, 5, 7, 10, 15, 20, 30].map((m) => `<option value="${m}">${m}分</option>`).join("")}</select>` : ""}
    <button type="button" class="small timer-toggle"></button>
    <button type="button" class="small timer-reset" aria-label="リセット">↺</button>
  </div>`;
}

// MTGの長さの目安の色：緑 →（1時間に近づくと）青 →（1時間を過ぎると）赤 →（1時間半で）紫
const TIME_COLORS = [[0, [46, 157, 91]], [50, [47, 111, 214]], [60, [47, 111, 214]], [66, [217, 48, 48]], [75, [217, 48, 48]], [90, [122, 31, 143]]];
function timeColor(min) {
  const i = TIME_COLORS.findIndex(([m]) => m > min);
  if (i === -1) return `rgb(${TIME_COLORS.at(-1)[1].join(",")})`;
  const [m0, c0] = TIME_COLORS[i - 1];
  const [m1, c1] = TIME_COLORS[i];
  const r = (min - m0) / (m1 - m0);
  return `rgb(${c0.map((v, k) => Math.round(v + (c1[k] - v) * r)).join(",")})`;
}

// 自動で数えはじめたタイマーの起点を、あとから正しい時刻（サーバーに記録したMTGの開始時刻）に合わせる
// 一時停止・リセットなど、手で触ったタイマーは変えない
export function syncTimerStart(key, since) {
  const t = timers.get(key);
  if (!t || !since || t.touched || !t.startedAt) return;
  t.elapsed = 0;
  t.startedAt = Math.min(since, Date.now());
}

// 目標時間に対する割合（1＝目標ちょうど）で色を出す。緑 → 目標に近づくと青 → 目標を過ぎると赤 → 1.5倍で紫
export const ratioColor = (ratio) => timeColor(ratio * 60);
export const fmtClock = (ms) => fmtElapsed(ms);

export function bindTimer(root, key, { auto = false, since = null } = {}) {
  const box = root.querySelector(`[data-timer="${CSS.escape(key)}"]`);
  if (!box) return;
  let t = timers.get(key);
  if (!t) {
    t = { elapsed: 0, startedAt: null, target: 0 };
    if (since) t.startedAt = since;
    else if (auto) t.startedAt = Date.now();
    timers.set(key, t);
  }
  const time = box.querySelector(".timer-time");
  const note = box.querySelector(".timer-note");
  const toggle = box.querySelector(".timer-toggle");
  const sel = box.querySelector(".timer-target");
  if (sel) sel.value = String(t.target);
  const now = () => t.elapsed + (t.startedAt ? Date.now() - t.startedAt : 0);
  const draw = () => {
    const ms = now();
    time.textContent = fmtElapsed(ms);
    toggle.innerHTML = t.startedAt ? `${ico("pause")} 一時停止` : ms ? `${ico("play")} 再開` : `${ico("play")} スタート`;
    const over = t.target && ms > t.target * 60000;
    if (box.classList.contains("timer-bar")) {
      const min = ms / 60000;
      box.style.setProperty("--timer-color", timeColor(min));
      note.textContent = min >= 90 ? "長すぎます。そろそろ終えましょう" : min >= 60 ? "1時間を過ぎました" : min >= 50 ? "まもなく1時間" : "";
    }
    box.classList.toggle("is-running", Boolean(t.startedAt));
    box.classList.toggle("is-over", Boolean(over));
    if (t.target) note.textContent = (over ? `${fmtElapsed(ms - t.target * 60000)} 超過` : `残り ${fmtElapsed(t.target * 60000 - ms)}`);
  };
  toggle.addEventListener("click", () => {
    t.touched = true;
    if (t.startedAt) { t.elapsed = now(); t.startedAt = null; } else t.startedAt = Date.now();
    draw();
  });
  box.querySelector(".timer-reset").addEventListener("click", () => {
    t.touched = true;
    t.elapsed = 0;
    t.startedAt = t.startedAt ? Date.now() : null;
    draw();
  });
  sel?.addEventListener("change", () => { t.target = Number(sel.value); draw(); });
  draw();
  // 画面から消えたら止める（数えた時間は timers に残る）
  const tick = setInterval(() => (document.body.contains(box) ? draw() : clearInterval(tick)), 1000);
}

// MTGを終えたときなど：数えた時間を捨てる
export function clearTimer(key) {
  timers.delete(key);
}

// 工程のチェック項目の右側：スキップ／スキップを取り消す
export function skipButton(c, ro) {
  if (ro || c.done_at) return "";
  return c.skipped_at
    ? `<button type="button" class="link-btn skip-btn" data-skip="${c.id}" data-skipped="1">スキップを取り消す</button>`
    : `<button type="button" class="link-btn skip-btn" data-skip="${c.id}" title="このPJでは不要な項目を、やらずに次の工程へ進めるようにします">スキップ</button>`;
}

export function bindSkipButtons(root, done) {
  root.querySelectorAll("[data-skip]").forEach((b) => b.addEventListener("click", () =>
    busy(b, () => api(`/api/checklist/${b.dataset.skip}`, { method: "PATCH", body: { skipped: !b.dataset.skipped } }))
      .then(() => { toast(b.dataset.skipped ? "スキップを取り消しました" : "スキップしました（やらなくても次の工程へ進めます）"); done(); })
      .catch(() => {})));
}

// 長い説明文：.fold を付けた要素は2行で折りたたみ、はみ出すときだけ「続きを読む」を出す（画面の幅が変わったら出し直す）
export function bindFold(root) {
  root.querySelectorAll(".fold").forEach((p) => {
    if (p.dataset.folded) return;
    p.dataset.folded = "1";
    const b = document.createElement("button");
    b.type = "button";
    b.className = "link-btn small fold-btn";
    b.textContent = "続きを読む";
    const update = () => {
      if (!p.classList.contains("is-open")) b.hidden = p.scrollHeight <= p.clientHeight + 2;
    };
    b.addEventListener("click", () => {
      const open = p.classList.toggle("is-open");
      b.textContent = open ? "閉じる" : "続きを読む";
    });
    p.after(b);
    update();
    new ResizeObserver(update).observe(p);
  });
}

// ---------- 書きかけの内容を守る ----------
// guardForm(form)：保存していない書きかけがあるまま別の画面へ移ろう・タブを閉じようとしたら確かめる
// 保存できたら markSaved(form) を呼ぶ（そのときの内容を「保存済み」として覚え直す）
const guarded = new Set();
const snapshot = (form) => JSON.stringify([...new FormData(form)].filter(([, v]) => typeof v === "string"));
export function guardForm(form) {
  if (!form) return;
  form.dataset.saved = snapshot(form);
  guarded.add(form);
}
export function markSaved(form) {
  if (form) form.dataset.saved = snapshot(form);
}
export function hasUnsaved() {
  if (pendingNow().length) return true;
  for (const f of guarded) {
    if (!f.isConnected) guarded.delete(f);
    else if (snapshot(f) !== f.dataset.saved) return true;
  }
  return false;
}
// guardPending(el, pending, flush)：自動保存がまだ終わっていない（失敗して送り直し中も含む）ときに、画面を移る前に保存を待つ
const pendings = new Set();
export function guardPending(el, pending, flush) {
  pendings.add({ el, pending, flush });
}
const pendingNow = () => [...pendings].filter((p) => (p.el.isConnected ? p.pending() : (pendings.delete(p), false)));
// 画面を移る前に、保存待ちの分を送って待つ（長くても ms まで）
export async function flushPending(ms = 6000) {
  const list = pendingNow();
  if (!list.length) return;
  await Promise.race([Promise.allSettled(list.map((p) => p.flush())), new Promise((r) => setTimeout(r, ms))]);
}
export function forgetUnsaved() {
  guarded.clear();
  pendings.clear();
}
window.addEventListener("beforeunload", (e) => {
  if (!hasUnsaved()) return;
  e.preventDefault();
  e.returnValue = "";
});

// 同じ欄を2人が同時に保存したとき：読み込んだ時点（base）から、自分だけが変えたなら自分の、相手だけなら相手の内容を使う
// 両方が変えていたら、両方を残す（自分の内容の下に区切り線と相手の内容）。both：両方残したかどうか
export function mergeText(base, mine, theirs) {
  base = base || ""; mine = mine || ""; theirs = theirs || "";
  if (mine === theirs || theirs === base) return { text: mine, both: false };
  if (mine === base) return { text: theirs, both: false };
  return { text: `${mine}\n---（ほかの人が書いた内容）\n${theirs}`, both: true };
}

// メンバーを選ぶ欄（.member-picker）に、名前で絞り込む入力欄を付ける（人数が多いときだけ）
export function bindMemberFilter(root) {
  root.querySelectorAll(".member-picker").forEach((box) => {
    const chips = [...box.querySelectorAll("label.chip-check")];
    if (chips.length < 12 || box.dataset.filter) return;
    box.dataset.filter = "1";
    const input = document.createElement("input");
    input.type = "search";
    input.className = "member-filter";
    input.placeholder = `名前で探す（${chips.length}人）`;
    input.setAttribute("aria-label", "メンバーを名前で探す");
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      for (const c of chips) c.hidden = Boolean(q) && !c.textContent.toLowerCase().includes(q) && !c.querySelector("input").checked;
    });
    // Enterでフォームが送られないように
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
    box.before(input);
  });
}

// 画面を描き直すときに、開いていた欄（data-key の付いた details）とスクロールの位置を保つ
export async function keepView(el, render) {
  const y = window.scrollY;
  const open = new Map([...el.querySelectorAll("details[data-key]")].map((d) => [d.dataset.key, d.open]));
  await render();
  el.querySelectorAll("details[data-key]").forEach((d) => { if (open.has(d.dataset.key)) d.open = open.get(d.dataset.key); });
  window.scrollTo(0, y);
}


// ---------- 達成感の演出：工程の完了・PJの完了などで、紙吹雪とひとこと ----------
// 動きを減らす設定（prefers-reduced-motion）の人には、紙吹雪を出さずにひとことだけ
export function celebrate(title, sub = "") {
  document.querySelector(".celebrate")?.remove();
  const box = document.createElement("div");
  box.className = "celebrate";
  box.setAttribute("role", "status");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const bits = reduce ? "" : Array.from({ length: 28 }, (_, i) => {
    const left = Math.round(Math.random() * 100);
    const delay = (Math.random() * 0.4).toFixed(2);
    const dur = (1.2 + Math.random() * 0.8).toFixed(2);
    const emoji = ["🎉", "✨", "🌱", "⭐", "🎊"][i % 5];
    return `<span class="confetti" style="left:${left}%;animation-delay:${delay}s;animation-duration:${dur}s">${emoji}</span>`;
  }).join("");
  box.innerHTML = `${bits}<div class="celebrate-card"><strong>${esc(title)}</strong>${sub ? `<small>${esc(sub)}</small>` : ""}</div>`;
  box.querySelector(".celebrate-card").addEventListener("click", () => box.remove());
  document.body.append(box);
  // 真ん中から、絵文字が大きくはじける
  burst({ x: window.innerWidth / 2, y: window.innerHeight / 2 }, { emoji: ["🎉", "✨", "⭐", "🌱"], count: 22, spread: Math.min(320, window.innerWidth / 3) });
  setTimeout(() => box.classList.add("is-leaving"), 2200);
  setTimeout(() => box.remove(), 2700);
}


// ---------- エラーの監視：画面で起きた想定外のエラーを、サーバーに知らせる ----------
let reported = 0;
function reportClientError(message, stack) {
  if (reported >= 5 || !state.me || !message) return;
  reported += 1;
  fetch("/api/client-errors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ message: String(message).slice(0, 500), stack: String(stack || "").slice(0, 2000), url: location.hash }),
  }).catch(() => {});
}
window.addEventListener("error", (e) => {
  // 「Script error.」：ほかのサイトのスクリプト（アプリ内ブラウザが足すものなど）のエラーで、中身が分からないので記録しない
  if (/^Script error\.?$/.test(e.message || "") && !e.error) return;
  reportClientError(e.message, e.error?.stack);
});
// 保存が通信の不調で何度か失敗したあと、保存できたとき：管理者メニューの「エラーの記録」に残す（どこで電波が切れやすいか分かるように）
export function reportSaveTrouble(text) {
  reportClientError(`💾 ${text}`, "");
}
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  if (r?.silent) return; // 確認画面の「キャンセル」など
  reportClientError(r?.message || String(r), r?.stack);
});


// ---------- MTGを終えたときの「どれだけ進んだか」：進み具合の棒が、前の位置から今の位置へ伸びる ----------
// from・to：済んだ項目の数（MTGの前・後）、total：全体の数、items：このMTGで済んだ項目（順にチェックが入る）
// 閉じる（または数秒たつ）と解決する Promise を返す
export function celebrateProgress({ title, sub = "", from, to, total, items = [] }) {
  return new Promise((resolve) => {
    document.querySelector(".celebrate")?.remove();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
    const box = document.createElement("div");
    box.className = "celebrate progress-celebrate";
    box.setAttribute("role", "status");
    box.innerHTML = `
      <div class="celebrate-card progress-card">
        <strong>${esc(title)}</strong>
        ${sub ? `<small>${esc(sub)}</small>` : ""}
        <div class="pg-bar" aria-hidden="true">
          <span class="pg-before" style="width:${pct(from)}%"></span>
          <span class="pg-gain" style="left:${pct(from)}%;width:0"></span>
        </div>
        <div class="pg-numbers"><span class="pg-pct">${pct(from)}%</span><small>${from} → <b>${to}</b> / ${total}項目</small></div>
        ${items.length ? `<ul class="pg-items">${items.map((t, i) => `<li style="animation-delay:${reduce ? 0 : 0.9 + i * 0.35}s"><span class="pg-check">✓</span>${esc(t)}</li>`).join("")}</ul>` : ""}
        <button type="button" class="primary small pg-ok">OK</button>
      </div>`;
    const close = () => { if (!box.isConnected) return; box.classList.add("is-leaving"); setTimeout(() => { box.remove(); resolve(); }, 350); };
    box.querySelector(".pg-ok").addEventListener("click", close);
    document.body.append(box);
    box.querySelector(".pg-ok").focus();
    // 少し待ってから、前の位置 → 今の位置へ「ぐいっ」と伸ばし、数字も数え上げる
    const gain = box.querySelector(".pg-gain");
    const label = box.querySelector(".pg-pct");
    setTimeout(() => {
      gain.style.width = `${pct(to) - pct(from)}%`;
      const start = performance.now();
      const dur = reduce ? 0 : 1100;
      const step = (now) => {
        const k = dur ? Math.min(1, (now - start) / dur) : 1;
        const eased = 1 - Math.pow(1 - k, 3);
        label.textContent = `${Math.round(pct(from) + (pct(to) - pct(from)) * eased)}%`;
        if (k < 1) requestAnimationFrame(step);
        else box.classList.add("is-done");
      };
      requestAnimationFrame(step);
    }, reduce ? 0 : 450);
    setTimeout(close, 4500 + items.length * 350);
  });
}


// MTGを終えてPJ画面に戻ったとき、数直線を「MTGの前 → 後」に伸ばすための合図（画面を開いているあいだだけ）
let progressHint = null;
export function setProgressHint(hint) { progressHint = hint; }
export function takeProgressHint(projectId) {
  if (!progressHint || progressHint.projectId !== projectId) return null;
  const h = progressHint;
  progressHint = null;
  return h;
}

// 「PJ ▶」と「◀ PJ決め」：三角を押すと、PJ と PJ決め を横に行き来する（PJ一覧・PJ決めの見出しで使う）
// current：'pj' | 'seeds'
export function viewSwitch(current, { seedsOpen = false } = {}) {
  const tri = (dir) => `<svg width="16" height="18" viewBox="0 0 16 18" aria-hidden="true"><path d="${dir === "right" ? "M2 1.5L14 9 2 16.5z" : "M14 1.5L2 9l12 7.5z"}" fill="currentColor"/></svg>`;
  return current === "pj"
    ? `<div class="view-switch"><h1>PJ</h1>
        <a class="view-switch-arrow is-right" href="#/seeds" data-slide="right" aria-label="PJ決めへ" title="${seedsOpen ? "PJ決めへ（締め切りのある回が受付中）" : "PJ決めへ"}">${tri("right")}${seedsOpen ? '<span class="view-switch-dot" aria-hidden="true"></span>' : ""}</a></div>`
    : `<div class="view-switch"><a class="view-switch-arrow is-left" href="#/projects" data-slide="left" aria-label="PJへ戻る" title="PJへ戻る">${tri("left")}</a>
        <h1>PJ決め</h1></div>`;
}

// 押した向きに、次の画面を横からすべり込ませる
export function bindViewSwitch(root) {
  root.querySelector(".view-switch-arrow")?.addEventListener("click", (e) => {
    const app = document.getElementById("app");
    app.dataset.slide = e.currentTarget.dataset.slide;
  });
}

// ---------- 担当を選ぶ（複数人）：押すとメンバーのチェックが開く。「全員」も ----------
// 値は picker の data-ids（"id1,id2"）。変わると、picker から "assignees" イベント（detail に id の配列）が出る
export const idsOf = (t) => (t.assignee_ids ? String(t.assignee_ids).split(",").filter(Boolean) : t.assignee_id ? [t.assignee_id] : []);
export function assigneePicker(users, ids = [], { ro = "", empty = "担当", name = "", members = null } = {}) {
  // members：PJメンバーのid。「全員」はPJメンバー全員（ほかの人は線の下に並べる）
  const isMember = (u) => !members || members.includes(u.id);
  const chosen = new Set(ids);
  const label = (set) => (set.size ? users.filter((u) => set.has(u.id)).map((u) => u.name).join("・") || `${set.size}人` : empty);
  return `<details class="ap" data-ap data-ids="${esc([...chosen].join(","))}" ${name ? `data-name="${esc(name)}"` : ""}>
    <summary class="ap-sum ${ro ? "is-ro" : ""}" ${ro ? 'tabindex="-1"' : ""} aria-label="担当">${chosen.size > 1 ? `${ico("users")} ` : ""}${esc(label(chosen))}</summary>
    ${ro ? "" : `<div class="ap-menu">
      <div class="ap-quick"><button type="button" class="small" data-ap-all>${members ? "PJメンバー全員" : "全員"}</button><button type="button" class="small" data-ap-none>なし</button></div>
      ${users.map((u, i) => `${members && !isMember(u) && (i === 0 || isMember(users[i - 1])) ? `<p class="ap-sep">PJ外の人</p>` : ""}<label class="ap-item" ${isMember(u) ? "data-member" : ""}><input type="checkbox" value="${esc(u.id)}" ${chosen.has(u.id) ? "checked" : ""}> ${esc(u.name)}</label>`).join("")}
    </div>`}
  </details>`;
}
document.addEventListener("click", (e) => {
  // 読むだけの担当は開かない／ほかを押したら閉じる
  const sum = e.target.closest(".ap-sum.is-ro");
  if (sum) { e.preventDefault(); return; }
  document.querySelectorAll("details.ap[open]").forEach((d) => { if (!d.contains(e.target)) d.open = false; });
  const all = e.target.closest("[data-ap-all],[data-ap-none]");
  if (all) {
    const ap = all.closest("[data-ap]");
    ap.querySelectorAll(".ap-item").forEach((l) => { l.querySelector("input").checked = "apAll" in all.dataset && l.hasAttribute("data-member"); });
    apChanged(ap);
  }
});
document.addEventListener("change", (e) => { const ap = e.target.closest?.("[data-ap]"); if (ap && e.target.matches(".ap-item input")) apChanged(ap); });
function apChanged(ap) {
  const items = [...ap.querySelectorAll(".ap-item")];
  const ids = items.filter((l) => l.querySelector("input").checked).map((l) => l.querySelector("input").value);
  const names = items.filter((l) => l.querySelector("input").checked).map((l) => l.textContent.trim());
  ap.dataset.ids = ids.join(",");
  ap.querySelector(".ap-sum").innerHTML = `${ids.length > 1 ? `${ico("users")} ` : ""}${esc(names.join("・") || "担当")}`;
  ap.dispatchEvent(new CustomEvent("assignees", { bubbles: true, detail: ids }));
}
export const pickerIds = (root) => (root.querySelector("[data-ap]")?.dataset.ids || "").split(",").filter(Boolean);

// ---------- 端末への一時保存（まだサーバーに届いていない書きかけだけ） ----------
// データの正はサーバー。ここに置くのは「送る前・送れなかった」文章だけで、サーバーに保存できたらすぐ消す。
// スマホの電源が落ちた・アプリが強制終了した・電波がない、で書きかけが消えないようにするため。
// value：書きかけ（欄の名前 → 文章）。base：書きはじめる前のサーバーの内容（開き直したとき、ほかの人の内容と合わせるのに使う）
// 欄ごとに足したり消したりする（ある欄を保存できても、ほかの欄の書きかけは残す）
const UNSENT_DAYS = 3;
const unsentKey = (key) => `pp-unsent:${state.me?.id || "-"}:${key}`;
const readUnsent = (key) => {
  try { return JSON.parse(localStorage.getItem(unsentKey(key)) || "null"); } catch { return null; }
};
const writeUnsent = (key, d) => {
  try {
    if (d && Object.keys(d.value || {}).length) localStorage.setItem(unsentKey(key), JSON.stringify(d));
    else localStorage.removeItem(unsentKey(key));
  } catch { /* 保存できない端末では何もしない */ }
};
export function putUnsent(key, value, base) {
  const old = readUnsent(key) || { value: {}, base: {} };
  // base は、その欄を書きはじめたときのものを使い続ける（あとから上書きしない）
  const nextBase = { ...old.base };
  for (const k of Object.keys(value)) if (!(k in (old.value || {}))) nextBase[k] = base?.[k] ?? "";
  writeUnsent(key, { value: { ...old.value, ...value }, base: nextBase, at: Date.now() });
}
export function getUnsent(key) {
  const d = readUnsent(key);
  if (d && d.value && Date.now() - d.at < UNSENT_DAYS * 86400000) return d;
  if (d) writeUnsent(key, null);
  return null;
}
// 保存できた欄を、一時保存から外す。いま端末に置いてある内容が、保存した内容（values のどれか）と同じときだけ
export function settleUnsent(key, field, values) {
  const d = readUnsent(key);
  if (!d || !(field in (d.value || {})) || !values.includes(d.value[field])) return;
  delete d.value[field];
  delete d.base?.[field];
  writeUnsent(key, d);
}
export function dropUnsent(key) {
  writeUnsent(key, null);
}
// 開いたとき：送れていなかった書きかけがあれば、今のサーバーの内容と合わせて欄に戻す。戻した欄の名前を返す
// fields にない欄（この画面では書けない欄など）の書きかけは、消さずに残しておく
export function restoreUnsent(key, fields) {
  const d = getUnsent(key);
  if (!d) return [];
  const restored = [];
  for (const [name, el] of Object.entries(fields)) {
    const mine = d.value[name];
    if (typeof mine !== "string" || !el) continue;
    const text = mergeText(d.base?.[name] ?? "", mine, el.value).text;
    if (text !== el.value) { el.value = text; restored.push(name); }
    else { delete d.value[name]; delete d.base?.[name]; } // もうサーバーにある
  }
  writeUnsent(key, d);
  return restored;
}
const textFields = (form) => Object.fromEntries([...form.querySelectorAll("textarea[name]")].map((t) => [t.name, t]));
const valuesOf = (fields) => Object.fromEntries(Object.entries(fields).map(([k, t]) => [k, t.value]));

// ---------- 保存できていないときの目立つ帯（画面の下。スクロールしても見える） ----------
const alerts = new Map();
export function setSaveAlert(id, message) {
  if (message) alerts.set(id, message); else alerts.delete(id);
  let bar = document.getElementById("save-alert");
  if (!alerts.size) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "save-alert";
    bar.className = "save-alert";
    bar.setAttribute("role", "alert");
    document.body.append(bar);
  }
  bar.innerHTML = [...alerts.values()].map((m) => `<div>${m}</div>`).join("");
}
const alertText = (what, err) => `${ico("warning")} ${esc(what)}がまだ保存できていません（${esc(err?.message || "通信できません")}）。自動でやり直しています。<b>この画面を閉じないでください</b>`;
export { alertText as saveAlertText };

// ---------- 自動保存：書くのが止まって少ししたら保存する（1回ずつ順番に）。保存中に書いた分は、次の保存で送る ----------
// save()：保存して Promise を返す。status：「✓ 自動で保存しました」などを出す要素
// key：端末への一時保存の名前（あれば、送れていない書きかけを端末にも置き、開き直したときに戻す）
// label：保存できないときの帯に出す名前（例：「定例の議事録」）
export function autoSave(form, save, { status, delay = 1500, key = null, label = "書いた内容" } = {}) {
  let edits = 0;      // 書いた回数（保存のあとに増えていたら、もう一度保存する）
  let timer = null;
  let running = null;
  let failed = 0;     // 続けて失敗した回数（保存できるまで、少し待って自動でやり直す）
  const alertId = `auto-${key || Math.random().toString(36).slice(2)}`;
  const show = (t) => { if (status) { status.textContent = t; status.classList.toggle("save-warn", t.startsWith("⚠")); } };
  const run = async () => {
    clearTimeout(timer);
    if (running) { await running; }
    const at = edits;
    if (!at) return;
    show("保存中…");
    const sending = valuesOf(textFields(form)); // いま送る内容（保存中に書き足した分は、次の保存で送る）
    running = Promise.resolve().then(save).then(() => {
      if (failed && !form.isConnected) toast(`✓ ${label}を保存できました`);
      if (failed >= 2) reportSaveTrouble(`${label}が一時的に保存できず、${failed}回やり直して保存できました`);
      failed = 0;
      setSaveAlert(alertId, null);
      savedValues = sending;
      if (key) for (const [k, v] of Object.entries(sending)) settleUnsent(key, k, [v]);
      if (edits === at) { edits = 0; markSaved(form); }
      show(`✓ 自動で保存しました（${new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}）`);
    }).catch((err) => {
      show(`⚠ まだ保存できていません（${err.message}）。自動でやり直しています…`);
      failed++;
      setSaveAlert(alertId, alertText(label, err));
      if (failed <= 200) { clearTimeout(timer); timer = setTimeout(run, Math.min(10000, 2000 * failed)); }
    }).finally(() => { running = null; });
    await running;
    if (edits && edits !== at) schedule();
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(run, delay); };
  let savedValues = valuesOf(textFields(form)); // サーバーにあると分かっている内容
  form.addEventListener("input", () => {
    edits++; show("入力中…"); schedule();
    if (key) putUnsent(key, valuesOf(textFields(form)), savedValues);
  });
  // 前に送れなかった書きかけがあれば戻して、保存する
  if (key) {
    const restored = restoreUnsent(key, textFields(form));
    if (restored.length) {
      edits++;
      show("保存できていなかった書きかけを戻しました。保存します…");
      toast("前に保存できていなかった書きかけを戻しました");
      setTimeout(run, 300);
    }
  }
  // 画面を閉じる・ほかのアプリに移るときは、すぐ保存する
  const flush = () => { if (edits) run(); };
  document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
  window.addEventListener("pagehide", flush);
  window.addEventListener("hashchange", flush, { once: true });
  window.addEventListener("online", flush);
  // ほかの画面へ移るときは、保存が終わるのを待つ（保存できなければ確かめる）
  guardPending(form, () => edits > 0 || Boolean(running), run);
  return { flush: run, pending: () => edits > 0 || Boolean(running) };
}

// ---------- Discordに貼ると回答状況が出るリンク（src/share.js） ----------
// kind：a（アンケート）／ r（PJ決め）／ p（日程調整アンケート）
// 横に「📣 Discordに投稿」（アンケート・日程調整）：PJごとのウェブフックで既存のスレッドに1回投稿し、回答が入るたびに書き直す（src/discord-post.js）
export const shareButton = (kind, id) =>
  `<button type="button" class="link-btn share-btn" data-share="${esc(kind)}" data-share-id="${Number(id)}" title="Discordに貼ると、いまの回答状況がカードで出ます">${ico("link")} Discord用にリンクをコピー</button>`
  + (["a", "p"].includes(kind) ? `<span class="discord-post" data-dp="${esc(kind)}" data-dp-id="${Number(id)}"></span>` : "");
const DP_LABEL = { a: "アンケート", p: "日程調整アンケート" };
const dpCache = new WeakMap();
async function drawDiscordPost(box) {
  box.dataset.ready = "1";
  const { dp: kind, dpId: id } = box.dataset;
  const st = await api(`/api/discord-posts?kind=${encodeURIComponent(kind)}&id=${id}`).catch(() => null);
  if (!st || !box.isConnected) return;
  dpCache.set(box, st);
  const latest = st.posts[0];
  box.innerHTML = [
    latest?.url ? `<a class="link-btn" href="${esc(latest.url)}" target="_blank" rel="noopener">${ico("chat")} Discordの投稿を開く（回答状況を自動で更新中）</a>` : "",
    !st.canPost ? "" : st.targets.length
      ? `<button type="button" class="link-btn" data-dp-post>${ico("megaphone")} ${latest ? "別のスレッドにも投稿" : "Discordのスレッドに投稿（回答状況がリアルタイムで更新）"}</button>`
      : `<span class="muted small">${ico("megaphone")} Discordへの投稿は、管理者メニューでPJのウェブフックを登録すると使えます</span>`,
  ].filter(Boolean).join(" ");
}
// 画面に「Discordに投稿」の場所が出たら、投稿してあるかを読み込む
new MutationObserver(() => document.querySelectorAll(".discord-post:not([data-ready])").forEach(drawDiscordPost))
  .observe(document.documentElement, { childList: true, subtree: true });

// 投稿先を選ぶ（PJ＝ウェブフック、スレッドID）。決めたら { project_id, thread_id }、やめたら null
function askDiscordTarget(kind, targets) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "dialog-backdrop";
    back.innerHTML = `<form class="dialog form" role="dialog" aria-modal="true" aria-label="Discordに投稿">
      <p>この${DP_LABEL[kind]}の回答状況を、Discordの既存のスレッドに投稿します。<br>回答が入るたびに、同じメッセージが自動で書き直されます（新しいスレッドは作りません）。</p>
      ${kind === "a" ? `<label>どのPJのウェブフックで投稿するか<select name="project">${targets.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select></label>` : `<p class="small muted">投稿先：${esc(targets[0].name)}のチャンネル</p>`}
      <label>スレッドID <small class="muted">スレッドを右クリック →「IDをコピー」、またはスレッドのリンク</small>
        <input name="thread" inputmode="numeric" required value="${esc(targets[0].thread_id || "")}" placeholder="例：1559199970996002968"></label>
      <div class="form-actions"><button type="button" data-no>キャンセル</button><button class="primary">投稿する</button></div>
    </form>`;
    const form = back.querySelector("form");
    const sel = form.querySelector("[name=project]");
    sel?.addEventListener("change", () => { form.thread.value = targets.find((t) => String(t.id) === sel.value)?.thread_id || ""; });
    const done = (v) => { back.remove(); resolve(v); };
    back.addEventListener("click", (e) => { if (e.target === back || e.target.closest("[data-no]")) done(null); });
    form.addEventListener("submit", (e) => { e.preventDefault(); done({ project_id: Number(sel ? sel.value : targets[0].id), thread_id: form.thread.value.trim() }); });
    document.body.append(back);
    form.thread.focus();
  });
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest?.("[data-dp-post]");
  if (!b) return;
  const box = b.closest(".discord-post");
  const { dp: kind, dpId: id } = box.dataset;
  const st = dpCache.get(box);
  if (!st?.targets.length) return;
  const target = await askDiscordTarget(kind, st.targets);
  if (!target) return;
  busy(b, () => api("/api/discord-posts", { method: "POST", body: { kind, id: Number(id), ...target } })).then(() => {
    toast("Discordのスレッドに投稿しました。回答が入るたびに自動で更新されます");
    drawDiscordPost(box);
    // 日程調整は、画面そっくりの画像を付ける（画面がもう一度読み込んで送る）
    box.dispatchEvent(new CustomEvent("discord-posted", { bubbles: true, detail: { kind, id } }));
  }).catch(() => {});
});
document.addEventListener("click", async (e) => {
  const b = e.target.closest?.("[data-share]");
  if (!b) return;
  const get = () => api(`/api/share-link?kind=${encodeURIComponent(b.dataset.share)}&id=${b.dataset.shareId}`).then((r) => r.url);
  try {
    // iPhoneでは、押してから時間がたつとコピーできないので、URLを待つ形でコピーを始めておく
    if (window.ClipboardItem && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": get().then((u) => new Blob([u], { type: "text/plain" })) })]);
    } else {
      await copyText(await get());
    }
    toast("Discord用のリンクをコピーしました。Discordに貼ると、いまの回答状況がカードで出ます");
  } catch (err) {
    // コピーできないとき：URLを出して、自分でコピーしてもらう
    const url = await get().catch(() => "");
    if (url) prompt("このリンクをコピーして、Discordに貼ってください", url);
    else toast(err.message || "リンクを作れませんでした", "error");
  }
});

// ---------- タスクを完了にする前の確認（押しまちがいで完了にしないように） ----------
export function confirmTaskDone(title) {
  return confirmDialog(`${title ? `「${title}」を` : "このタスクを"}完了にしますか？`, { ok: "完了にする" });
}

// やったことにチェックを入れたときに、その場ではじけて「+1」（タスクは、確認で「完了にする」を押したあとに呼ぶ）
export function doneEffect(cb) {
  burst(cb);
  plusOne(cb);
  const row = cb.closest(".list-item, li, label");
  if (row) { row.classList.remove("just-done"); void row.offsetWidth; row.classList.add("just-done"); }
  // 自分のタスク・マイページで、担当中のタスクを全部済ませたら、大きくお祝い
  if (cb.matches("[data-task]") && /^#\/(my-tasks|me)/.test(location.hash)) {
    const all = document.querySelectorAll("#app [data-task]");
    const left = document.querySelectorAll("#app [data-task]:not(:checked)").length;
    if (all.length >= 1 && left === 0) setTimeout(() => celebrate("担当中のタスクを全部済ませました！", "おつかれさまでした 🎉"), 350);
  }
}

// ---------- 「戻る」を押したときの確認（MTG中の議事録など） ----------
// その画面にいるあいだだけ効く。fn が false を返したら戻らない
let backGuard = null;
export function setBackGuard(fn) {
  backGuard = fn ? { hash: location.hash, fn } : null;
}
export async function checkBackGuard() {
  if (!backGuard || backGuard.hash !== location.hash) return true;
  return backGuard.fn();
}
// MTG中：「このMTGを一時保存して戻りますか？」→ はい：書いた内容を保存してから戻る
export function guardMeetingBack(flush) {
  setBackGuard(async () => {
    if (!await confirmDialog("このMTGを一時保存して戻りますか？\n\n書いた内容は保存されます。続きは「ミーティングを始める」の「前回の続き（再開）」や、議事録の画面から書けます。", { ok: "一時保存して戻る" })) return false;
    try {
      await flush();
    } catch {
      toast("保存できませんでした。通信を確かめて、もう一度押してください（書いた内容はこの端末に残っています）", "error");
      return false;
    }
    toast("一時保存しました");
    return true;
  });
}

// 履歴に積まずに、ほかの画面へ移る（いまの画面を置き換える）。MTGを終えた・フォームを保存した・消したあとに使い、
// 「戻る」で終えたMTG（タイマーが動き出す）や保存済みのフォームに戻らないようにする
export function replaceHash(hash) {
  // 移る先が1つ前の画面なら（PJの画面 → 編集 → 保存 など）、戻るのと同じにする（同じ画面が履歴に2つ並ばないように）
  const v = window.__visited || [];
  if (v.length >= 2 && v[v.length - 2] === hash) { history.back(); return; }
  window.__replaceNav = true;
  location.replace(`${location.pathname}${location.search}${hash}`);
}
