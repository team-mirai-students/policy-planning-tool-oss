// 起動・ログイン状態・ハッシュルーティング
import { api, esc, avatar, toast, state, hasUnsaved, forgetUnsaved, flushPending, confirmDialog, fmtDateTime, jstDateTime, prefetch, burst, plusOne, celebrate, doneEffect } from "./lib.js";
import { renderHome } from "./views/home.js";
import { renderSurvey, renderSurveyNew, renderSurveyList } from "./views/surveys.js";
import { renderSchedulePoll, renderSchedulePollNew } from "./views/schedule-poll.js";
import { renderTrash } from "./views/trash.js";
import { renderMinutesSearch } from "./views/search.js";
import { renderTimeline } from "./views/timeline.js";
import { renderCheck } from "./views/check.js";
import { renderNotices, renderMyTasks } from "./views/notices.js";
import { renderProfile } from "./views/profile.js";
import { renderStart } from "./views/start.js";
import { renderPresentList, renderPresent } from "./views/present.js";
import { renderProjects, renderProjectForm } from "./views/projects.js";
import { renderSchedule } from "./views/schedule.js";
import { renderProject } from "./views/project.js";
import { renderMeeting } from "./views/meeting.js";
import { renderCalendar } from "./views/calendar.js";
import { renderRounds, renderRound, renderStaffing } from "./views/seeds.js";
import { renderHearings, renderHearingNew, renderHearing } from "./views/hearings.js";
import { renderAdmin } from "./views/admin.js";
import { renderSourcesView } from "./views/research.js";
import { renderTeireiHome, renderTeireiMinutes, renderTeireiNotice, renderTeireiSchedule, renderTeirei, renderReportList, renderReport } from "./views/teirei.js";
import { ico } from "./icons.js";

const ROUTES = [
  [/^\/$/, "home", () => renderHome],
  [/^\/start$/, "projects", () => renderStart],
  [/^\/check$/, "home", () => renderCheck],
  [/^\/notices$/, "home", () => renderNotices],
  [/^\/my-tasks$/, "home", () => renderMyTasks],
  [/^\/me$/, "me", () => renderProfile],
  [/^\/members\/([^/?]+)$/, "home", (m) => (el) => renderProfile(el, decodeURIComponent(m[1]))],
  [/^\/minutes-search$/, "home", () => renderMinutesSearch],
  [/^\/present$/, "projects", () => renderPresentList],
  [/^\/present\/(\d+)$/, "projects", (m) => (el) => renderPresent(el, Number(m[1]))],
  [/^\/projects$/, "projects", () => renderProjects],
  [/^\/schedule$/, "projects", () => renderSchedule],
  [/^\/projects\/new$/, "projects", () => (el) => renderProjectForm(el, null)],
  [/^\/projects\/(\d+)\/edit$/, "projects", (m) => (el) => renderProjectForm(el, Number(m[1]))],
  [/^\/projects\/(\d+)$/, "projects", (m) => (el) => renderProject(el, Number(m[1]))],
  [/^\/meetings\/(\d+)$/, "projects", (m) => (el) => renderMeeting(el, Number(m[1]))],
  [/^\/calendar$/, "calendar", () => renderCalendar],
  [/^\/timeline$/, "timeline", () => renderTimeline],
  [/^\/seeds$/, "projects", () => renderRounds],
  [/^\/admin$/, "home", () => renderAdmin],
  [/^\/surveys$/, "home", () => renderSurveyList],
  [/^\/trash$/, "home", () => renderTrash],
  [/^\/schedule-polls\/(\d+)$/, "projects", (m) => (el) => renderSchedulePoll(el, Number(m[1]))],
  [/^\/projects\/(\d+)\/schedule-poll$/, "projects", (m) => (el) => renderSchedulePollNew(el, Number(m[1]))],
  [/^\/surveys\/new$/, "home", () => renderSurveyNew],
  [/^\/surveys\/(\d+)$/, "home", (m) => (el) => renderSurvey(el, Number(m[1]))],
  [/^\/teirei$/, "home", () => renderTeireiHome],
  [/^\/teirei\/minutes$/, "home", () => renderTeireiMinutes],
  [/^\/teirei\/notice$/, "home", () => renderTeireiNotice],
  [/^\/teirei\/schedule$/, "home", () => renderTeireiSchedule],
  [/^\/teirei\/(\d+)$/, "home", (m) => (el) => renderTeirei(el, Number(m[1]))],
  [/^\/report$/, "projects", () => renderReportList],
  [/^\/report\/(\d+)$/, "projects", (m) => (el) => renderReport(el, Number(m[1]))],
  [/^\/sources$/, "home", () => (el) => renderSourcesView(el)],
  [/^\/hearings$/, "projects", () => renderHearings],
  [/^\/hearings\/new$/, "projects", () => renderHearingNew],
  [/^\/hearings\/(\d+)$/, "projects", (m) => (el) => renderHearing(el, Number(m[1]))],
  [/^\/seeds\/(\d+)$/, "projects", (m) => (el) => renderRound(el, Number(m[1]))],
  [/^\/seeds\/(\d+)\/staffing$/, "projects", (m) => (el) => renderStaffing(el, Number(m[1]))],
];

const ERRORS = {
  login: "ログインに失敗しました。もう一度お試しください。",
  guild: "学生チームのDiscordサーバーに参加しているアカウントでログインしてください。",
  role: "このツールは政策立案部門のメンバー専用です。部門のロールが付いているか確認してください。",
  config: "ログインの設定が完了していません。管理者に連絡してください。",
};

let baseTitle = document.title;
let routeSeq = 0;
// 開いたときの版。新しい版が出ていたら、画面を移るときに読み込み直す
let loadedVersion = "";
let newVersion = false;
let lastVersionCheck = 0;
async function checkVersion() {
  if (newVersion || !loadedVersion || Date.now() - lastVersionCheck < 60000) return;
  lastVersionCheck = Date.now();
  const s = await fetch("/api/session", { credentials: "same-origin" }).then((r) => r.json()).catch(() => null);
  if (s?.version && s.version !== loadedVersion) newVersion = true;
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkVersion(); });
setInterval(() => { if (!document.hidden) checkVersion(); }, 5 * 60000);
// 次の画面の切り替え方（lateral：下のメニューで横に移る／back：戻る）。何もなければ「奥へ進む」
let pendingVt = null;
document.addEventListener("click", (e) => {
  if (e.target.closest?.("#nav a, .account-me, .site-header .brand")) pendingVt = "lateral";
}, true);
// 折りたたみ：自分で開いたときだけ、中身をぬるっと出す（印は少しで外す）
document.addEventListener("click", (e) => {
  const d = e.target.closest?.("summary")?.parentElement;
  if (!d || d.tagName !== "DETAILS" || d.open) return;
  d.classList.add("just-opened");
  setTimeout(() => d.classList.remove("just-opened"), 400);
});
// 読み込み中の画面：点が跳ねるアニメーションと、中身の形のうっすらした枠（光が流れる）
const loadingScreen = () => `<div class="loading loading-screen" role="status" aria-live="polite">
  <div class="loading-dots" aria-hidden="true"><i></i><i></i><i></i></div>
  <p>読み込み中…</p>
  <div class="skeleton" aria-hidden="true"><span class="sk-title"></span><span></span><span></span><span class="sk-short"></span></div>
</div>`;
// ふわっと切り替えるか（ビュー遷移に対応したブラウザで、動きを減らす設定にしていないとき）
// 切り替えの動きが始まらない画面（アプリ内ブラウザなど）では、一度わかったら、それからは動きを付けない（待たせない）
let vtBroken = false;
// 画面を切り替えるときの動き（ふわっと・横すべり）は付けない（2026-10-15、すぐ切り替わる方が使いやすいため）。
// 付け直すときは、ここを document.startViewTransition があるときだけ true にする
const SWITCH_MOTION = false;
const smoothSwitch = () => SWITCH_MOTION && !vtBroken && Boolean(document.startViewTransition) && !matchMedia("(prefers-reduced-motion: reduce)").matches;

async function boot() {
  const session = await api("/api/session");
  loadedVersion = session.version || "";
  // テスト版などは、本番と見分けられるよう画面上部に帯を出す
  if (session.siteLabel) {
    const bar = document.createElement("div");
    bar.className = "site-label";
    bar.textContent = `${session.siteLabel}：ここで入力した内容は本番には反映されません`;
    document.body.prepend(bar);
    document.title = `【${session.siteLabel}】${document.title}`;
    baseTitle = document.title;
  }
  document.getElementById("boot-loading")?.remove();
  if (!session.user) return showLanding(session);
  const me = await api("/api/me");
  Object.assign(state, { me: me.user, users: me.users, types: me.types, guildId: session.guildId || "" });
  document.getElementById("account").innerHTML = `
    <a class="account-me" href="#/me" data-nav="me" title="${esc(me.user.name)}（マイページ）" aria-label="マイページ">${avatar(me.user)}</a>
    <a class="button small" href="/auth/logout">ログアウト</a>`;
  // 下のメニューのいちばん右（マイページ）は、自分のアイコンにする
  document.getElementById("nav-me-ico").innerHTML = avatar(me.user);
  document.getElementById("nav").hidden = false;
  document.getElementById("bell").hidden = false;
  bindBellPanel();
  refreshBell();
  setInterval(() => { if (!document.hidden) refreshBell(); }, 60000);
  
  document.getElementById("app").hidden = false;
  window.addEventListener("hashchange", route);
  document.getElementById("back-btn").addEventListener("click", goBack);
  route();
}

function showLanding(session) {
  document.getElementById("landing").hidden = false;
  const params = new URLSearchParams(location.search);
  const error = ERRORS[params.get("error")];
  if (error) {
    const el = document.getElementById("login-error");
    el.textContent = error;
    el.hidden = false;
  }
  const returnTo = params.get("returnTo");
  if (returnTo) {
    document.getElementById("login-button").href = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
  }
  if (session.devLogin) {
    const dev = document.getElementById("dev-login");
    dev.hidden = false;
    if (returnTo) dev.querySelector("form").insertAdjacentHTML("beforeend", `<input type="hidden" name="returnTo" value="${esc(returnTo)}">`);
  }
}

// 「戻る」のために、このタブで開いた画面の順番を覚えておく（ブラウザの履歴と同じ並び。保存はしない）
const visited = [];

function trackHistory() {
  const hash = location.hash || "#/";
  if (visited.length >= 2 && visited[visited.length - 2] === hash) visited.pop(); // 戻ってきた
  else if (visited[visited.length - 1] !== hash) visited.push(hash);
}

function goBack() {
  if (visited.length > 1) {
    history.back();
    return;
  }
  // 直接開いたときなど戻る先がなければ、パンくずの1つ上（なければホーム）へ
  // 履歴を増やさずに置き換えるので、もう一度押すとさらに上の画面へ進む
  const crumbs = document.querySelectorAll("#app .breadcrumb a");
  const parent = crumbs.length ? crumbs[crumbs.length - 1].getAttribute("href") : "#/";
  visited.length = 0;
  location.replace(`${location.pathname}${location.search}${parent}`);
}

// サイトをズームさせない：iPhoneのピンチ（gesture）と、2本指の操作を止める（ダブルタップは CSS の touch-action で止める）
for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener("touchmove", (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

// 画面の上の🔔：未読のお知らせの数（画面を移るたび・1分ごとに確かめる）
export async function refreshBell() {
  const count = document.getElementById("bell-count");
  if (!count) return;
  const { unread } = await api("/api/notices?count=1").catch(() => ({ unread: 0 }));
  count.textContent = unread > 99 ? "99+" : String(unread);
  count.hidden = !unread;
}

// 🔔を押すと、その場に小さな枠でお知らせを出す（ページは移らない）。開いたら既読にする
function bindBellPanel() {
  const bell = document.getElementById("bell");
  bell.setAttribute("aria-haspopup", "dialog");
  bell.setAttribute("aria-expanded", "false");
  let panel = null;
  const close = () => {
    panel?.remove();
    panel = null;
    bell.setAttribute("aria-expanded", "false");
  };
  const open = async () => {
    panel = document.createElement("div");
    panel.className = "bell-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "お知らせ");
    panel.innerHTML = `<div class="bell-panel-head"><strong>${ico("bell")} お知らせ</strong><button type="button" class="link-btn" data-close aria-label="閉じる">✕</button></div>
      <p class="muted small bell-loading">読み込み中…</p>`;
    document.querySelector(".site-header").append(panel);
    bell.setAttribute("aria-expanded", "true");
    panel.querySelector("[data-close]").addEventListener("click", close);
    const { notices } = await api("/api/notices").catch(() => ({ notices: [] }));
    if (!panel) return;
    const list = notices.slice(0, 8);
    panel.querySelector(".bell-loading").outerHTML = `
      ${list.length ? `<ul class="bell-list">${list.map((n) => `
        <li class="${n.read_at ? "" : "is-unread"}">
          ${n.link ? `<a href="${esc(n.link)}">` : "<span>"}
            ${n.read_at ? "" : '<span class="unread-dot" aria-label="未読"></span>'}<span class="bell-text">${esc(n.body.split("\n")[0])}</span>
            <small class="muted">${fmtDateTime(jstDateTime(n.created_at))}</small>
          ${n.link ? "</a>" : "</span>"}
        </li>`).join("")}</ul>` : `<p class="muted small">お知らせはまだありません。</p>`}
      <div class="bell-panel-foot"><a href="#/notices">すべて見る（${notices.length}件）</a><a href="#/my-tasks">${ico("check")} 自分のタスク</a></div>`;
    // 開いたら既読にする（数字を消す）
    if (notices.some((n) => !n.read_at)) {
      api("/api/notices/read", { method: "POST", body: {} }).then(() => { document.getElementById("bell-count").hidden = true; }).catch(() => {});
    }
  };
  bell.addEventListener("click", (e) => {
    e.preventDefault();
    if (panel) close(); else open();
  });
  // 外を押したとき・Esc・お知らせを押して画面を移ったときは閉じる
  document.addEventListener("click", (e) => {
    if (!panel) return;
    if (e.target.closest(".bell-panel a")) { close(); return; }
    if (!e.target.closest(".bell-panel") && !e.target.closest("#bell")) close();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && panel) { close(); bell.focus(); } });
  window.addEventListener("hashchange", close);
}

// 「戻る」はパンくずと同じ行に置く（縦の場所を取らないように）。パンくずのない画面では上の行に出す
// 画面の中身が描き直されるたびに（保存して再表示したときも）置き直す
function placeBackButton(el) {
  const bar = document.getElementById("back-bar");
  const crumb = el.querySelector(":scope > .breadcrumb");
  if (!crumb) {
    bar.hidden = (location.hash.replace(/^#/, "").split("?")[0] || "/") === "/";
    return;
  }
  bar.hidden = true;
  if (crumb.querySelector(".back-btn")) return;
  const btn = document.getElementById("back-btn").cloneNode(true);
  btn.removeAttribute("id");
  btn.addEventListener("click", goBack);
  crumb.prepend(btn);
}
// 横にスクロールするタブ：右に続きがあるあいだは右端をぼかす
function markScrollableTabs(el) {
  el.querySelectorAll(".tabs").forEach((t) => {
    const update = () => t.classList.toggle("has-more", t.scrollLeft + t.clientWidth < t.scrollWidth - 4);
    if (!t.dataset.watch) {
      t.dataset.watch = "1";
      t.addEventListener("scroll", update, { passive: true });
    }
    update();
  });
}
new MutationObserver(() => {
  const app = document.getElementById("app");
  placeBackButton(app);
  requestAnimationFrame(() => markScrollableTabs(app));
}).observe(document.getElementById("app"), { childList: true, subtree: true });

// 横スクロールする工程の数直線（スマホ）は、いまの工程が見える位置に合わせる
function centerSteppers(el) {
  el.querySelectorAll(".stepper").forEach((ol) => {
    const cur = ol.querySelector(".is-current");
    if (cur && ol.scrollWidth > ol.clientWidth) ol.scrollLeft = cur.offsetLeft - (ol.clientWidth - cur.clientWidth) / 2;
  });
}

// 書きかけを守る：保存していない内容があるまま移ろうとしたら確かめ、やめたら元の画面に戻す
let shownHash = location.hash || "#/";
let shownPath = null; // いま表示している画面（クエリを除く）
let returning = false;

export async function route() {
  // '#/projects/1?tab=tasks' のようなクエリは各画面が hashQuery() で読む
  const path = location.hash.replace(/^#/, "").split("?")[0] || "/";
  const el = document.getElementById("app");
  if (returning) {
    returning = false;
    return;
  }
  // 自動保存の途中なら、まず送り終わるのを待つ（保存できれば、そのまま移る）
  if (location.hash !== shownHash && hasUnsaved()) await flushPending();
  if (location.hash !== shownHash && hasUnsaved()) {
    const leave = await confirmDialog("書いた内容がまだ保存できていません。\nこのまま離れると、消えてしまうおそれがあります。離れますか？", { ok: "保存せずに離れる" });
    if (!leave) {
      returning = true;
      location.replace(`${location.pathname}${location.search}${shownHash}`);
      return;
    }
  }
  forgetUnsaved();
  shownHash = location.hash || "#/";
  refreshBell();
  // 新しい版が出ていたら、この画面からページごと読み込み直す（書きかけがないときだけ）
  if (newVersion && !hasUnsaved()) { location.reload(); return; }
  checkVersion();
  // 1つ前に見ていた画面へ戻ったときは「戻る」の切り替え（パッと）
  if (visited.length >= 2 && visited[visited.length - 2] === (location.hash || "#/")) pendingVt = "back";
  trackHistory();
  document.getElementById("back-bar").hidden = path === "/";
  for (const [re, nav, view] of ROUTES) {
    const m = path.match(re);
    if (!m) continue;
    document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("is-active", a.dataset.nav === nav));
    // 同じ画面のタブを切り替えただけなら、読み込み中に画面を空にせず、スクロールの位置もそのまま
    const sameScreen = shownPath === path;
    const keepY = window.scrollY;
    // タブの列が画面のどこにあったか（切り替えたあとも、同じ位置に見えるようにする）
    const tabsTop = sameScreen ? el.querySelector(".tabs")?.getBoundingClientRect().top : null;
    shownPath = path;
    // 新しい画面へ移ったあとは、前の画面の読み込みの続き（エラーなど）を無視する
    const seq = ++routeSeq;
    // 画面を移るときは、前の画面を見せたまま次の画面を用意し、出来たらふわっと切り替える（ブラウザのビュー遷移）。
    // 0.5秒たっても出来なければ、先に切り替えて「読み込み中…」を出す
    let loadingTimer = null;
    let viewDone = null;
    const slide = el.dataset.slide;
    const nextVt = pendingVt;
    pendingVt = null;
    delete el.dataset.slide;
    const render = () => (viewDone = Promise.resolve().then(() => view(m)(el)));
    // 前の画面の中身（これがまだ残っているときだけ「読み込み中…」に替える。次の画面を描き始めていたら替えない）
    const oldFirst = el.firstElementChild;
    const stillOld = () => seq === routeSeq && el.firstElementChild === oldFirst;
    // 中身が最初に出たときに1回だけ、カードや行を少しずつふわっと出す。
    // 画面によっては先に中身を出してから続きを読み込むので、読み込みが終わったときではなく「出たとき」に動かす（2回動いてチラつかないように）
    const playEnter = () => {
      el.classList.remove("entering");
      void el.offsetWidth;
      el.classList.add("entering");
      clearTimeout(el._enterTimer);
      el._enterTimer = setTimeout(() => el.classList.remove("entering"), 350);
    };
    const onFirstContent = (cb) => {
      const ready = () => seq === routeSeq && el.firstElementChild && el.firstElementChild !== oldFirst && !el.firstElementChild.classList.contains("loading-screen");
      if (ready()) return cb();
      const watch = new MutationObserver(() => { if (ready()) { watch.disconnect(); cb(); } });
      watch.observe(el, { childList: true });
      setTimeout(() => watch.disconnect(), 15000);
    };
    // 「読み込み中」の画面を出したら、中身ができたときにふわっと出す
    const showLoading = () => { el.innerHTML = loadingScreen(); onFirstContent(playEnter); };
    try {
      if (!sameScreen && smoothSwitch()) {
        // 動き方：PJ ⇄ PJ決め は横すべり、下のメニュー・戻るはパッと、それ以外（奥へ進む）はぬるっと
        document.documentElement.dataset.vt = slide || nextVt || "forward";
        let called = false;
        const t = document.startViewTransition(async () => {
          if (called) return;
          called = true;
          window.scrollTo(0, 0);
          // 0.08秒で出来なければ、前の画面は残さず「読み込み中」の画面へ切り替える（違う画面が見えたままにしない）
          const done = await Promise.race([render().then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), 80))]);
          if (!done && stillOld()) showLoading();
        });
        // 次の画面へすぐ移ったときなどに「飛ばした」と出るのは問題ないので、エラーにしない
        t.ready.catch(() => {});
        t.finished.catch(() => {}).finally(() => { if (seq === routeSeq) delete document.documentElement.dataset.vt; });
        // 画面が描かれない状態（裏のタブなど）で切り替えが始まらないときは、動きを飛ばしてそのまま描く
        // （アプリ内ブラウザなどで動きが始まらないと、ここで待たされる。0.2秒で見切って、すぐ描く）
        await Promise.race([t.updateCallbackDone.catch(() => {}), new Promise((r) => setTimeout(r, 200))]);
        if (!called) {
          called = true;
          vtBroken = true;
          t.skipTransition();
          window.scrollTo(0, 0);
          render();
        }
        if (stillOld()) showLoading();
        await viewDone;
      } else {
        if (!sameScreen) {
          loadingTimer = setTimeout(() => { if (stillOld()) showLoading(); }, 80);
          onFirstContent(playEnter);
        }
        await render();
      }
      clearTimeout(loadingTimer);
      if (seq !== routeSeq) return;
      if (sameScreen) {
        const tabs = el.querySelector(".tabs");
        if (tabs && tabsTop != null) window.scrollBy(0, tabs.getBoundingClientRect().top - tabsTop);
        else window.scrollTo(0, keepY);
      }
      else window.scrollTo(0, 0);
      const h1 = el.querySelector("h1")?.textContent.replace(/\s+/g, " ").trim();
      document.title = h1 ? `${h1}｜${baseTitle}` : baseTitle;
      centerSteppers(el);
    } catch (e) {
      clearTimeout(loadingTimer);
      if (seq !== routeSeq) return;
      el.innerHTML = `<div class="empty"><p>${esc(e.message)}</p><a class="button" href="#/">ホームへ</a></div>`;
    }
    return;
  }
  location.hash = "#/";
}

// リンクに指が触れた・マウスが乗った時点で、行き先の画面のデータを先に取りに行く（押したらすぐ出るように）
function prefetchFor(hash) {
  const path = hash.replace(/^#/, "").split("?")[0];
  let m;
  if ((m = path.match(/^\/projects\/(\d+)$/))) return [`/api/projects/${m[1]}`];
  if (path === "/projects") return ["/api/projects?archived=1", "/api/rounds"];
  if ((m = path.match(/^\/meetings\/(\d+)$/))) return [`/api/meetings/${m[1]}`];
  if ((m = path.match(/^\/seeds\/(\d+)$/))) return [`/api/rounds/${m[1]}`];
  if (path === "/me") return ["/api/my-tasks", "/api/projects"];
  if ((m = path.match(/^\/members\/([^/?]+)$/))) return [`/api/my-tasks?user=${encodeURIComponent(decodeURIComponent(m[1]))}`, "/api/projects"];
  return [];
}
function bindPrefetch() {
  const onIntent = (e) => {
    const a = e.target.closest?.('a[href^="#/"]');
    if (!a || !state.me) return;
    for (const p of prefetchFor(a.getAttribute("href"))) prefetch(p);
  };
  document.addEventListener("pointerover", onIntent, { passive: true });
  document.addEventListener("touchstart", onIntent, { passive: true });
  document.addEventListener("focusin", onIntent);
}
bindPrefetch();

// 入力中（スマホでキーボードが出ている間）は、下のメニューを隠す。キーボードの上に浮いて見にくいので
// 選ぶ欄（セレクト・日付など）はキーボードが出ず、選んだあとも選ばれたままになるので入れない
const isTyping = (t) => Boolean(t?.isContentEditable || t?.matches?.(
  "input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=date]):not([type=datetime-local]):not([type=time]):not([type=month]):not([type=range]):not([type=color]):not([type=file]),textarea"));
document.addEventListener("focusin", (e) => document.documentElement.classList.toggle("typing", Boolean(isTyping(e.target))));
document.addEventListener("focusout", () => setTimeout(() => {
  if (!isTyping(document.activeElement)) document.documentElement.classList.remove("typing");
}, 0));

// やったことにチェックを入れたら、その場ではじけて「+1」（工程のチェック・タスク・宿題など、どの画面でも）
//   タスク（[data-task]・[data-hw]）は、完了の確認のあとに各画面が doneEffect を呼ぶ
document.addEventListener("change", (e) => {
  const cb = e.target;
  if (!(cb instanceof HTMLInputElement) || cb.type !== "checkbox" || !cb.checked) return;
  if (!cb.matches("[data-check], [data-stage-check], [data-rh-done], [data-todo-done]")) return;
  doneEffect(cb);
});

// 同じ画面の中のタブ（?tab=…）を切り替えるリンクは、「戻る」の履歴に積まない（戻るで前の画面へ戻れるように）
document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const a = e.target.closest?.('.tabs a[href^="#/"]');
  if (!a) return;
  const path = (h) => h.replace(/^#/, "").split("?")[0];
  if (path(a.getAttribute("href")) !== path(location.hash)) return;
  e.preventDefault();
  location.replace(`${location.pathname}${location.search}${a.getAttribute("href")}`);
});

boot().catch((e) => {
  const box = document.getElementById("boot-loading");
  if (box) box.innerHTML = `読み込めませんでした（${esc(e.message)}）。<button type="button" onclick="location.reload()">もう一度読み込む</button>`;
  else toast(e.message, "error");
});
