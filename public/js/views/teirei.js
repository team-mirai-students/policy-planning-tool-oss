// 部門の定例：入口（定例の議事録／進捗を書く／管理者は定例を始める）と、それぞれの画面
import { api, esc, state, fmtDate, fmtDateTime, jstDateTime, addDays, hashQuery, confirmDialog, busy, toast, formData, pjPicker, pickItem, timerHtml, bindTimer, guardForm, markSaved, mergeText, autoSave, guardMeetingBack, replaceHash } from "../lib.js";
import { enhanceRich, richHtml } from "../rich.js";
import { FIXED, parseLayout, secTools, customSection, addSectionBox, bindLayout, layoutValue } from "../teirei-layout.js";
import { ico, iconText } from "../icons.js";
const richView = (md) => `<div class="rich-view">${richHtml(md)}</div>`;

const EVENTS = { "": "なし", news: "ニュース勉強会", exchange: "意見交換会" };
const FIELDS = [
  ["done", "前回の定例からやったこと"],
  ["next", "次の定例までにやること"],
  ["issues", "困っていること・相談したいこと"],
];

const stageName = (p) => state.types[p.type]?.stages.find((s) => s.no === p.current_stage)?.name || "";
const stageLabel = (p) => `工程${p.current_stage}・${esc(stageName(p))}`;
const paragraphs = (r) => FIELDS.filter(([k]) => r[k]).map(([k, label]) => `<h4>${label}</h4><div class="rich-view">${richHtml(r[k])}</div>`).join("")
  || `<p class="muted small">（空欄）</p>`;

// ---------- 定例の入口：定例の議事録／進捗を書く／（部門長・副部門長）事務連絡を書く・定例 ----------
const WEEK_JA = ["日", "月", "火", "水", "木", "金", "土"];
const slotLabel = (startsAt) => `${fmtDate(startsAt.slice(0, 10))} ${startsAt.slice(11, 16)}`;
const meetingLabel = (m) => `${m.number ? `第${m.number}回 ` : ""}${fmtDate(m.held_on)}${m.starts_at ? ` ${m.starts_at.slice(11, 16)}` : ""}の定例`;
const stateTag = (m) => !m ? "" : m.is_open ? `<span class="due is-soon">進行中</span>` : m.is_ready ? `<span class="tag">準備中</span>` : `<span class="tag">終了</span>`;

export async function renderTeireiHome(el) {
  const { today, meetings } = await api("/api/dept-meetings");
  const todays = meetings.find((m) => m.held_on === today);
  const admin = state.me.isAdmin;
  el.innerHTML = `
    <div class="page-heading"><h1>${ico("landmark")} 定例</h1></div>
    <div class="choices ${admin ? "two" : todays?.is_open ? "" : "two"}">
      <a class="choice" href="#/teirei/minutes">
        <span class="choice-icon">${ico("doc")}</span>
        <strong>定例の議事録</strong>
      </a>
      <a class="choice" href="#/report">
        <span class="choice-icon">${ico("note")}</span>
        <strong>進捗を書く</strong>
      </a>
      ${admin ? `<button type="button" class="choice" data-panel="notice">
        <span class="choice-icon">${ico("megaphone")}</span>
        <strong>事務連絡を書く<small class="choice-role">部門長・副部門長</small></strong>
      </button>
      <button type="button" class="choice" data-panel="teirei">
        <span class="choice-icon">${ico("landmark")}</span>
        <strong>定例<small class="choice-role">部門長・副部門長</small></strong>
      </button>` : todays?.is_open ? `<a class="choice" href="#/teirei/${todays.id}">
        <span class="choice-icon">${ico("play")}</span>
        <strong>今日の定例を開く</strong>
      </a>` : ""}
    </div>
    <div id="panel"></div>`;
  enhanceRich(el);

  const panel = el.querySelector("#panel");
  let opened = "";
  const show = (key, html) => {
    opened = key;
    panel.innerHTML = `<div class="confirm-start narrow">${html}</div>`;
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  const loadSlots = () => api("/api/dept-schedules");

  // 定例：始める／予定する
  const teireiPanel = () => show("teirei", `
    ${todays?.is_open ? `<a class="button primary" href="#/teirei/${todays.id}">${ico("play")} 今日の定例を開く</a>` : ""}
    <button type="button" class="${todays?.is_open ? "" : "primary"}" data-act="start">${ico("play")} 定例を始める</button>
    <a class="button" href="#/teirei/schedule">${ico("calendar")} 定例を予定する</a>`);

  // 定例を始める：予定から直近3回の日時を出す。押すとその日時の定例（議事録）を作る
  const startPanel = async () => {
    const { upcoming } = await loadSlots();
    const todayInList = upcoming.some((x) => x.starts_at.startsWith(today));
    show("teirei", `
      <p><strong>どの定例を始めますか？</strong></p>
      ${upcoming.length ? `<ul class="planned-list">${upcoming.map((x, i) => `
        <li><div><strong>${slotLabel(x.starts_at)}</strong>${x.starts_at.startsWith(today) ? `<span class="tag">今日</span>` : ""}${stateTag(x.meeting)}</div>
          ${!x.meeting ? `<button type="button" class="${i === 0 ? "primary" : ""}" data-start="${x.starts_at}">この日時の定例を始める</button>`
            : x.meeting.ended_at && x.meeting.held_on === today ? `<span class="row-left"><a class="button" href="#/teirei/${x.meeting.id}">議事録を開く</a><button type="button" data-reopen="${x.meeting.id}">${ico("undo")} 再開する</button></span>`
            : `<a class="button ${x.meeting.ended_at ? "" : "primary"}" href="#/teirei/${x.meeting.id}">${x.meeting.ended_at ? "議事録を開く" : "開く"}</a>`}</li>`).join("")}</ul>`
        : `<p class="muted small">定例の予定がありません。「定例を予定する」から登録できます。</p>`}
      ${todays && !todayInList ? `<p class="small">今日の定例（予定外）：${stateTag(todays)}
          <a href="#/teirei/${todays.id}">開く</a>${todays.ended_at ? ` <button type="button" class="link-btn" data-reopen="${todays.id}">${ico("undo")} 再開する</button>` : ""}</p>`
        : !todays && !todayInList ? `<button type="button" class="link-btn" data-adhoc>予定外で今日の定例を始める</button>` : ""}
      <div class="form-actions"><button type="button" data-back>← 戻る</button></div>`);
    panel.querySelectorAll("[data-start]").forEach((b) => b.addEventListener("click", () =>
      busy(b, () => api("/api/dept-meetings", { method: "POST", body: { starts_at: b.dataset.start } }))
        .then((res) => { location.hash = `#/teirei/${res.id}`; }).catch(() => {})));
    panel.querySelector("[data-adhoc]")?.addEventListener("click", (e) => busy(e.currentTarget, () => api("/api/dept-meetings", { method: "POST", body: {} }))
      .then((res) => { location.hash = `#/teirei/${res.id}`; }).catch(() => {}));
    panel.querySelectorAll("[data-reopen]").forEach((b) => b.addEventListener("click", () =>
      busy(b, () => reopenTeirei(Number(b.dataset.reopen))).then(() => { location.hash = `#/teirei/${b.dataset.reopen}`; }).catch(() => {})));
    panel.querySelector("[data-back]").addEventListener("click", teireiPanel);
  };

  // 事務連絡を書く：予定から直近3回の日時を出して、どの定例の事務連絡を書くか選ぶ
  const noticePanel = async () => {
    const { upcoming } = await loadSlots();
    show("notice", `
      <p><strong>どの定例の事務連絡を書きますか？</strong></p>
      ${upcoming.length ? `<ul class="planned-list">${upcoming.map((x, i) => `
        <li><div><strong>${slotLabel(x.starts_at)}</strong>${x.starts_at.startsWith(today) ? `<span class="tag">今日</span>` : ""}${stateTag(x.meeting)}
            ${x.has_notice ? `<span class="tag">書き置きあり</span>` : ""}</div>
          <a class="button ${i === 0 ? "primary" : ""}" href="#/teirei/notice?day=${x.starts_at.slice(0, 10)}">この定例の事務連絡を書く</a></li>`).join("")}</ul>`
        : `<p class="muted small">定例の予定がありません。「定例」→「定例を予定する」から登録できます。</p>
          <a class="button" href="#/teirei/notice">日付を決めずに書く（次の定例に入ります）</a>`}`);
  };

  el.querySelectorAll("[data-panel]").forEach((b) => b.addEventListener("click", () => {
    if (opened === b.dataset.panel) { panel.innerHTML = ""; opened = ""; return; }
    if (b.dataset.panel === "teirei") teireiPanel();
    else noticePanel().catch((e) => toast(e.message, "error"));
  }));
  panel.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="start"]')) startPanel().catch((err) => toast(err.message, "error"));
  });
}

// ---------- 議事録の一覧 ----------
export async function renderTeireiMinutes(el) {
  const { meetings } = await api("/api/dept-meetings");
  el.innerHTML = `
    <nav class="breadcrumb"><a href="#/teirei">定例</a> / 定例の議事録</nav>
    <div class="page-heading left"><h1>${ico("doc")} 定例の議事録</h1></div>
    ${meetings.length ? `<ul class="list">${meetings.map((m) => `
      <li class="list-item"><a href="#/teirei/${m.id}">${meetingLabel(m)}</a>
        <div class="meta">${m.is_open ? `<span class="due is-soon">進行中</span>` : ""}
          <span class="muted small">進捗共有 ${m.reports}件</span>${m.event ? `<span class="tag">${EVENTS[m.event]}</span>` : ""}</div></li>`).join("")}</ul>`
      : `<div class="empty"><p>まだ定例はありません。</p></div>`}`;
  enhanceRich(el);
}

// ---------- 定例の議事録：事務連絡 → 各PJの進捗共有 → メモ → イベント → 定例を終わる ----------
export async function renderTeirei(el, id) {
  const { meeting: m, reports, missing, canEdit } = await api(`/api/dept-meetings/${id}`);
  let version = m.version;
  // 枠の並び順と、部門長・副部門長が足した枠
  const layout = parseLayout(m.layout);
  const textSec = (k, empty) => `<section class="card" data-sec="${k}">
        <div class="section-head"><h2>${iconText(FIXED[k])}</h2><span class="row-left">${secTools(k, canEdit)}</span></div>
        ${canEdit ? `<textarea name="${k}" data-rich rows="${k === "notice" ? 5 : 3}" maxlength="30000" aria-label="${FIXED[k]}">${esc(m[k])}</textarea>`
          : m[k] ? richView(m[k]) : `<p class="muted">${empty}</p>`}
      </section>`;
  const SECTION = {
    notice: () => textSec("notice", "事務連絡はありません。"),
    news: () => textSec("news", "なし"),
    exchange: () => textSec("exchange", "なし"),
    reports: () => `<section class="card" data-sec="reports">
        <div class="section-head"><h2>${iconText(FIXED.reports)}</h2><span class="row-left">${m.is_open ? `<button type="button" class="small" id="reload">最新にする</button>` : ""}${secTools("reports", canEdit)}</span></div>
        ${reports.length || missing.length ? `<div class="report-toggles">
          ${reports.map((r) => `
            <details class="report-toggle">
              <summary><span class="rt-name">${esc(r.project_name)}${r.member_names ? `<small class="rt-members">${esc(r.member_names)}</small>` : ""}</span><span class="stage-pill">${stageLabel(r)}</span></summary>
              <div class="rt-body">
                <div class="section-head"><a class="small" href="#/projects/${r.project_id}">PJを開く</a></div>
                ${paragraphs(r)}
                <p class="muted small">${esc(r.updated_by_name || "")}・${fmtDateTime(jstDateTime(r.updated_at))}</p>
              </div>
            </details>`).join("")}
          ${missing.map((p) => `
            <details class="report-toggle is-missing">
              <summary><span class="rt-name">${esc(p.name)}${p.member_names ? `<small class="rt-members">${esc(p.member_names)}</small>` : ""}</span><span class="stage-pill">${stageLabel(p)}</span><span class="muted small">未記入</span></summary>
              <div class="rt-body"><p class="muted small">まだ書かれていません。PJが「進捗を書く」で書くと、ここに入ります。<a href="#/report/${p.id}">進捗を書く</a></p></div>
            </details>`).join("")}
        </div>` : `<p class="muted">進捗共有はありません。</p>`}
      </section>`,
  };
  el.innerHTML = `
    <nav class="breadcrumb"><a href="#/teirei">定例</a> / <a href="#/teirei/minutes">定例の議事録</a> / ${fmtDate(m.held_on)}</nav>
    ${m.is_open ? timerHtml(`teirei-${m.id}`, { bar: true }) : ""}
    <div class="page-heading left"><h1>${ico("landmark")} ${meetingLabel(m)} ${stateTag(m)}</h1>
      ${m.updated_by_name ? `<p>最終更新：${esc(m.updated_by_name)}・${fmtDateTime(jstDateTime(m.updated_at))}</p>` : ""}</div>

    <form class="minutes" id="teirei-form">
      <div id="secs">${layout.order.map((k) => SECTION[k]?.() ?? customSection(k, layout.custom[k], canEdit, richView)).join("")}
      ${canEdit ? addSectionBox() : ""}</div>

      ${m.memo ? `<section class="card">
        <div class="section-head"><h2>${ico("note")} メモ</h2></div>
        ${canEdit ? `<textarea name="memo" data-rich rows="4" maxlength="50000" aria-label="メモ">${esc(m.memo)}</textarea>` : `<div class="rich-view">${richHtml(m.memo)}</div>`}
      </section>` : ""}

      <div class="form-actions sticky">
        ${canEdit ? `<span class="muted small auto-status" id="auto-status">自動で保存されます</span>` : ""}
        ${canEdit ? `<button type="submit" data-save>保存する</button>
          ${m.is_open ? `<button type="submit" class="primary" data-end>定例を終わる</button>`
            : m.is_today ? `<button type="button" data-reopen>${ico("undo")} 定例を再開する</button>` : ""}` : ""}
      </div>
    </form>`;
  enhanceRich(el);

  const form = el.querySelector("#teirei-form");
  guardForm(form);
  // 定例を始めた時刻から数える（前もって作った定例は、予定の開始時刻から）
  if (m.is_open) bindTimer(el, `teirei-${m.id}`, { since: Math.max(m.created_at, m.starts_at ? Date.parse(`${m.starts_at}:00+09:00`) : 0) });
  el.querySelector("#reload")?.addEventListener("click", () => renderTeirei(el, id));
  el.querySelector("[data-reopen]")?.addEventListener("click", (e) => busy(e.currentTarget, () => reopenTeirei(id, version))
    .then(() => { toast("定例を再開しました"); renderTeirei(el, id); }).catch(() => {}));


  // 最後にサーバーと一致していた内容（ぶつかったときにまとめるため）
  const KEYS = ["notice", "news", "exchange", "memo"].filter((k) => form[k]);
  const values = () => ({ ...Object.fromEntries(KEYS.map((k) => [k, form[k].value])), ...(canEdit ? { layout: layoutValue(form, layout) } : {}) });
  if (canEdit) bindLayout(el.querySelector("#secs"), layout, { onChange: () => form.dispatchEvent(new Event("input", { bubbles: true })) });
  let base = Object.fromEntries(KEYS.map((k) => [k, m[k]]));
  let baseLayout = parseLayout(m.layout);
  // auto：自動保存（Notionへは送らない。「保存する」「定例を終わる」で送る）
  const send = (end, auto = false) => api(`/api/dept-meetings/${id}`, {
    method: "PATCH", body: { ...values(), end, auto, version },
  }).catch(async (err) => {
    if (!/他の人が更新/.test(err.message)) throw err;
    // ほかの部門長・副部門長も同時に書いていた：相手の変更を取り込んで、もう一度保存する
    const { meeting: latest } = await api(`/api/dept-meetings/${id}`);
    let both = false;
    for (const k of KEYS) {
      const r = mergeText(base[k], form[k].value, latest[k]);
      form[k].value = r.text;
      both ||= r.both;
    }
    // 足した枠：相手が足した枠も取り込み、同じ枠の中身はまとめる
    const theirs = parseLayout(latest.layout);
    for (const [cid, c] of Object.entries(theirs.custom)) {
      if (!layout.custom[cid]) { layout.custom[cid] = c; layout.order.push(cid); continue; }
      const field = form[`sec_${cid}`];
      const r = mergeText(baseLayout.custom[cid]?.body || "", field ? field.value : layout.custom[cid].body, c.body);
      if (field) field.value = r.text; else layout.custom[cid].body = r.text;
      both ||= r.both;
    }
    base = Object.fromEntries(KEYS.map((k) => [k, latest[k]]));
    baseLayout = theirs;
    version = latest.version;
    if (both) toast("ほかの人も同じ欄を書いていたので、両方の内容を残しました。確認してください");
    return api(`/api/dept-meetings/${id}`, {
      method: "PATCH", body: { ...values(), end, auto, version },
    });
  });
  const saveNow = (end, auto) => send(end, auto).then((res) => {
    base = values();
    baseLayout = parseLayout(layoutValue(form, layout));
    version = res.version;
    return res;
  });
  // 書くのが止まったら、自動で保存する
  const auto = canEdit ? autoSave(form, () => saveNow(false, true), { status: el.querySelector("#auto-status"), key: `teirei:${id}`, label: "定例の議事録" }) : null;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const end = "end" in e.submitter.dataset;
    if (auto?.pending()) await auto.flush();
    busy(e.submitter, () => saveNow(end, false)).then(() => {
      markSaved(form);
      toast(end ? "定例を終わりました。議事録を保存しました" : "議事録を保存しました");
      if (end) renderTeirei(el, id);
    }).catch(() => {});
  });
}

// ---------- どの定例か選ぶ（進捗を書く・定例イベントのMTG）：最近の定例・今日の定例・これからの定例 ----------
export const teireiTargetLabel = (t) => `${t.number ? `第${t.number}回 ` : ""}${fmtDate(t.day)}${t.starts_at ? ` ${t.starts_at.slice(11, 16)}` : ""}の定例`;
export function teireiTargetList(targets, suggested, href, today) {
  if (!targets.length) return `<p class="muted small">定例の予定がありません。部門長・副部門長が「定例」→「定例を予定する」から登録できます。</p>`;
  return `<ul class="pick-list">${targets.map((t) => pickItem({
    href: href(t), name: teireiTargetLabel(t),
    // 印は1つだけ：終了／進行中／今日／予定
    note: t.meeting?.ended_at ? `<span class="tag">終了</span>` : t.meeting?.is_open ? `<span class="due is-soon">進行中</span>`
      : t.day === today ? `<span class="tag">今日</span>` : `<span class="tag">予定</span>`,
  })).join("")}</ul>`;
}

// ---------- 定例の議事録を書く：定例を選ぶ → PJを選ぶ ----------
export async function renderReportList(el) {
  const day = hashQuery().get("day");
  if (!day) {
    const { today, targets, suggested } = await api("/api/teirei-targets");
    // 定例の予定も記録もないときは、今までどおり「次の定例」に向けて書く
    if (targets.length) {
      el.innerHTML = `
        <nav class="breadcrumb"><a href="#/teirei">定例</a> / 進捗を書く</nav>
        <div class="page-heading left"><h1>${ico("note")} どの定例の進捗を書きますか？</h1></div>
        ${teireiTargetList(targets, suggested, (t) => `#/report?day=${t.day}`, today)}`;
      return;
    }
  }
  const { projects, meeting } = await api(`/api/dept-reports${day ? `?day=${encodeURIComponent(day)}` : ""}`);
  el.innerHTML = `
    <nav class="breadcrumb"><a href="#/teirei">定例</a> / <a href="#/report">進捗を書く</a>${day ? ` / ${fmtDate(day)}の定例` : ""}</nav>
    <div class="page-heading left"><h1>${ico("note")} どのPJの進捗を書きますか？</h1>
      <p>${day ? `${fmtDate(day)}の定例${meeting?.ended_at ? "（終わった定例）" : ""}` : meeting ? "今日の定例" : "次の定例"}に向けて書きます</p></div>
    ${pjPicker(projects, (p) => pickItem({ href: `#/report/${p.id}${day ? `?day=${day}` : ""}`, name: p.name,
      note: p.written_at ? `<span class="tag">記入済み</span>` : "" }))}`;
  enhanceRich(el);
}

// ---------- 定例の議事録を書く：進捗共有の記入 ----------
export async function renderReport(el, projectId) {
  const day = hashQuery().get("day");
  // どの定例に向けて書くか、毎回選ぶ（定例の予定も記録もないときは「次の定例」）
  if (!day) {
    const { today, targets, suggested } = await api("/api/teirei-targets");
    if (targets.length) {
      el.innerHTML = `
        <nav class="breadcrumb"><a href="#/teirei">定例</a> / <a href="#/report">進捗を書く</a></nav>
        <div class="page-heading left"><h1>${ico("note")} どの定例の進捗を書きますか？</h1></div>
        ${teireiTargetList(targets, suggested, (t) => `#/report/${projectId}?day=${t.day}`, today)}`;
      return;
    }
  }
  const q = day ? `?day=${encodeURIComponent(day)}` : "";
  const { project: p, meeting, report, previous } = await api(`/api/projects/${projectId}/dept-report${q}`);
  let version = report.version;
  el.innerHTML = `
    <nav class="breadcrumb"><a href="#/teirei">定例</a> / <a href="#/report">進捗を書く</a> / ${esc(p.name)}</nav>
    <div class="page-heading left"><h1>${ico("note")} ${esc(p.name)}</h1>
      <p>${day ? `${fmtDate(day)}の定例` : meeting ? `${fmtDate(meeting.held_on)}の定例` : "次の定例"}で共有する進捗です（<a href="#/report/${p.id}">定例を選び直す</a>）。いまの工程：${stageLabel(p)}・<a href="#/projects/${p.id}">PJ画面へ</a></p>
      ${meeting?.ended_at ? `<p class="small">${ico("info")} 終わった定例です。「保存する」を押すと、Notionの定例の議事録にも入ります。</p>` : ""}</div>
    <form class="card form" id="report">
      ${FIELDS.map(([k, label]) => `<div class="field"><div class="section-head"><strong>${label}</strong></div><textarea name="${k}" data-rich rows="4" maxlength="20000" aria-label="${label}">${esc(report[k])}</textarea></div>`).join("")}
      <div class="form-actions">
        ${report.updated_at ? `<span class="muted small">最終更新：${esc(report.updated_by_name || "")}・${fmtDateTime(jstDateTime(report.updated_at))}</span>` : ""}
        <span class="muted small auto-status" id="auto-status">自動で保存されます</span>
        <button class="primary">保存する</button></div>
    </form>
    ${previous ? `<details class="card"><summary>前回（${fmtDate(previous.held_on)}）の定例で共有した内容</summary>${paragraphs(previous)}</details>` : ""}`;
  enhanceRich(el);
  const form = el.querySelector("#report");
  guardForm(form);
  let base = { done: report.done, next: report.next, issues: report.issues };
  let sync = false; // 「保存する」を押したときだけ、終わった定例ならNotionにも入れる
  const send = () => api(`/api/projects/${projectId}/dept-report`, { method: "PUT", body: { ...formData(form), version, day, sync } })
    .catch(async (err) => {
      if (!/他の人が更新/.test(err.message)) throw err;
      // 同じPJのメンバーも同時に書いていた：相手の変更を取り込んで、もう一度保存する
      const { report: latest } = await api(`/api/projects/${projectId}/dept-report${q}`);
      let both = false;
      for (const [k] of FIELDS) {
        const r = mergeText(base[k], form[k].value, latest[k]);
        form[k].value = r.text;
        both ||= r.both;
      }
      base = { done: latest.done, next: latest.next, issues: latest.issues };
      version = latest.version;
      if (both) toast("同じPJのメンバーも同じ欄を書いていたので、両方の内容を残しました。確認してください");
      return api(`/api/projects/${projectId}/dept-report`, { method: "PUT", body: { ...formData(form), version, day, sync } });
    });
  const saveNow = () => send().then((res) => { base = formData(form); version = res.version; return res; });
  const auto = autoSave(form, saveNow, { status: el.querySelector("#auto-status"), key: `report:${projectId}:${day || meeting?.id || "next"}`, label: "進捗" });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (auto.pending()) await auto.flush();
    busy(e.submitter, () => { sync = true; return saveNow().finally(() => { sync = false; }); })
      .then(() => { markSaved(form); toast("保存しました"); }).catch(() => {});
  });
}

// ---------- 事務連絡を書く（部門長・副部門長） ----------
export async function renderTeireiNotice(el) {
  const day = hashQuery().get("day");
  const d = await api(`/api/dept-notice${day ? `?day=${encodeURIComponent(day)}` : ""}`);
  let version = d.version;
  const layout = parseLayout(d.layout);
  const where = d.target === "meeting" ? `${fmtDate(d.day)}の定例の議事録に直接書きます`
    : d.target === "day" ? `${fmtDate(d.day)}の定例に向けて書いておきます（その日の定例を始めると、議事録の事務連絡に移ります）`
    : "次の定例に入ります（「定例を始める」を押すと、その定例の議事録に移ります）";
  el.innerHTML = `
    <nav class="breadcrumb"><a href="#/teirei">定例</a> / 事務連絡を書く</nav>
    <div class="page-heading left"><h1>${ico("megaphone")} ${d.day ? `${fmtDate(d.day)}の定例の` : ""}事務連絡</h1><p>${where}</p></div>
    <form class="minutes" id="notice-form">
      <div id="secs">${layout.order.map((k) => k === "reports"
        ? `<section class="card" data-sec="reports"><div class="section-head"><h2>${iconText(FIXED.reports)}</h2>${secTools("reports", true)}</div>
            <p class="muted small">各PJが「進捗を書く」で書いたものが、PJごとのトグルで自動で入ります。</p></section>`
        : FIXED[k] ? `<section class="card" data-sec="${k}"><div class="section-head"><h2>${iconText(FIXED[k])}</h2>${secTools(k, true)}</div>
            <textarea name="${k}" data-rich rows="${k === "notice" ? 6 : 3}" maxlength="30000" aria-label="${FIXED[k]}">${esc(d[k])}</textarea></section>`
        : customSection(k, layout.custom[k], true, richView)).join("")}
        ${addSectionBox()}</div>
      <div class="form-actions sticky">
        ${d.updated_at ? `<span class="muted small">最終更新：${esc(d.updated_by_name)}・${fmtDateTime(jstDateTime(d.updated_at))}</span>` : ""}
        <span class="muted small auto-status" id="auto-status">自動で保存されます</span>
        ${d.target === "meeting" ? `<a class="button" href="#/teirei/${d.meeting.id}">この定例を開く</a>` : ""}
        <button class="primary">保存する</button>
      </div>
    </form>`;
  enhanceRich(el);
  const noticeForm = el.querySelector("#notice-form");
  guardForm(noticeForm);
  bindLayout(el.querySelector("#secs"), layout, { onChange: () => noticeForm.dispatchEvent(new Event("input", { bubbles: true })) });
  const f = noticeForm;
  let sync = false; // 「保存する」を押したときだけ、Notionの定例の議事録にも入れる
  const body = () => ({ notice: f.notice.value, news: f.news.value, exchange: f.exchange.value, layout: layoutValue(f, layout), version, target: d.target, day: d.target === "next" ? null : d.day, sync });
  let base = { notice: d.notice, news: d.news, exchange: d.exchange };
  const saveNow = () => api("/api/dept-notice", { method: "PUT", body: body() })
    .catch(async (err) => {
      if (!/他の人が更新/.test(err.message)) throw err;
      // ほかの部門長・副部門長も同時に書いていた：相手の変更を取り込んで、もう一度保存する
      const latest = await api(`/api/dept-notice${day ? `?day=${encodeURIComponent(day)}` : ""}`);
      let both = false;
      for (const k of ["notice", "news", "exchange"]) {
        const r = mergeText(base[k] || "", f[k].value, latest[k] || "");
        f[k].value = r.text;
        both ||= r.both;
      }
      const theirs = parseLayout(latest.layout);
      for (const [cid, c] of Object.entries(theirs.custom)) if (!layout.custom[cid]) { layout.custom[cid] = c; layout.order.push(cid); }
      version = latest.version;
      if (both) toast("ほかの人も同じ欄を書いていたので、両方の内容を残しました。確認してください");
      return api("/api/dept-notice", { method: "PUT", body: body() });
    })
    .then((res) => { version = res.version; base = { notice: f.notice.value, news: f.news.value, exchange: f.exchange.value }; return res; });
  const auto = autoSave(noticeForm, saveNow, { status: el.querySelector("#auto-status"), key: `notice:${d.target}:${d.day || ""}`, label: "事務連絡" });
  noticeForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (auto.pending()) await auto.flush();
    busy(e.submitter, () => { sync = true; return saveNow().finally(() => { sync = false; }); })
      .then(() => { markSaved(noticeForm); toast(d.target === "next" ? "保存しました" : "保存しました。Notionの定例の議事録にも入ります"); }).catch(() => {});
  });
}

// ---------- 定例を予定する（部門長・副部門長）：毎週◯曜日の◯時、この日からこの日まで ----------
export async function renderTeireiSchedule(el) {
  const { today, schedules, upcoming } = await api("/api/dept-schedules");
  el.innerHTML = `
    <nav class="breadcrumb"><a href="#/teirei">定例</a> / 定例を予定する</nav>
    <div class="page-heading left"><h1>${ico("calendar")} 定例を予定する</h1></div>
    <form class="card form" id="schedule-form">
      <div class="grid-2">
        <label>曜日<select name="weekday">${WEEK_JA.map((w, i) => `<option value="${i}" ${i === 1 ? "selected" : ""}>${w}曜日</option>`).join("")}</select></label>
        <label>時刻<input name="time" type="time" required value="22:00"></label>
        <label>この日から<input name="from_date" type="date" required value="${today}"></label>
        <label>この日まで<input name="to_date" type="date" required value="${addDays(today, 90)}"></label>
      </div>
      <div class="form-actions"><button class="primary">予定に追加</button></div>
    </form>
    <h2>登録している予定</h2>
    ${schedules.length ? `<ul class="list">${schedules.map((x) => `
      <li class="list-item"><span><strong>毎週${WEEK_JA[x.weekday]}曜 ${esc(x.time)}</strong>
        <span class="muted small">${fmtDate(x.from_date)}〜${fmtDate(x.to_date)}${x.to_date < today ? "（終了）" : ""}</span></span>
        <div class="meta"><button class="link-btn danger" data-del="${x.id}">削除</button></div></li>`).join("")}</ul>`
      : `<p class="muted">まだ予定はありません。</p>`}
    ${upcoming.length ? `<p class="small" style="margin-top:12px"><strong>次の定例：</strong>${upcoming.map((x) => slotLabel(x.starts_at)).join("、")}</p>` : ""}`;
  enhanceRich(el);
  el.querySelector("#schedule-form").addEventListener("submit", (e) => {
    e.preventDefault();
    busy(e.submitter, () => api("/api/dept-schedules", { method: "POST", body: formData(e.target) }))
      .then((res) => { toast(`${res.label}の定例を予定しました`); renderTeireiSchedule(el); }).catch(() => {});
  });
  el.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
    if (!await confirmDialog("この定例の予定を削除しますか？（作成済みの定例の議事録は消えません）")) return;
    busy(b, () => api(`/api/dept-schedules/${b.dataset.del}`, { method: "DELETE", body: {} })).then(() => renderTeireiSchedule(el)).catch(() => {});
  }));
}

// 終えた今日の定例を、もう一度進行中にする（終えたあとに書かれた進捗共有・事務連絡もまとめ直す）
async function reopenTeirei(id, version) {
  const v = version ?? (await api(`/api/dept-meetings/${id}`)).meeting.version;
  return api(`/api/dept-meetings/${id}`, { method: "PATCH", body: { reopen: true, version: v } });
}

// ---------- 定例イベント（ニュース勉強会・意見交換会）のMTG：選んだ定例の議事録の、そのイベントの欄に書く ----------
// 作ってある定例なら議事録に直接、まだ始めていない定例なら書き置き（定例を始めると議事録に移る）
// MTGとして始めたとき（start=1）だけタイマーと「MTGを終える」を出す
export async function renderTeireiEvent(el) {
  const qs = hashQuery();
  const day = qs.get("day");
  const event = qs.get("event");
  const inMeeting = qs.get("start") === "1";
  const query = `?day=${encodeURIComponent(day || "")}&event=${encodeURIComponent(event || "")}`;
  const d = await api(`/api/dept-event${query}`);
  const label = EVENTS[d.event];
  let version = d.version;
  let base = d.text;
  let sync = false;
  el.innerHTML = `
    <nav class="breadcrumb"><a href="#/teirei">定例</a> / ${esc(label)}</nav>
    <div class="page-heading left"><h1>${ico("news")} ${esc(label)}</h1>
      <p>${d.meeting?.number ? `第${d.meeting.number}回 ` : ""}${fmtDate(d.day)}の定例の議事録の「${esc(label)}」に入ります${d.target === "day" ? "（その日の定例を始めると、議事録に移ります）" : ""}。</p></div>
    ${inMeeting ? timerHtml(`event-${d.day}-${d.event}`, { bar: true }) : ""}
    <form class="minutes" id="event-form">
      <section class="card"><div class="section-head"><h2>${esc(label)}</h2></div>
        <textarea name="text" data-rich rows="10" maxlength="30000" aria-label="${esc(label)}">${esc(d.text)}</textarea></section>
      <div class="form-actions sticky">
        ${d.updated_at ? `<span class="muted small">最終更新：${esc(d.updated_by_name)}・${fmtDateTime(jstDateTime(d.updated_at))}</span>` : ""}
        <span class="muted small auto-status" id="auto-status">自動で保存されます</span>
        ${d.meeting ? `<a class="button" href="#/teirei/${d.meeting.id}">定例の議事録を開く</a>` : ""}
        ${inMeeting ? `<button type="button" class="primary" data-end>MTGを終える</button>` : `<button class="primary">保存する</button>`}
      </div>
    </form>`;
  enhanceRich(el);
  if (inMeeting) bindTimer(el, `event-${d.day}-${d.event}`, { auto: true });
  const form = el.querySelector("#event-form");
  guardForm(form);
  const put = () => api("/api/dept-event", { method: "PUT", body: { day: d.day, event: d.event, target: d.target, text: form.text.value, version, sync } });
  const saveNow = () => put()
    .catch(async (err) => {
      if (!/他の人が更新/.test(err.message)) throw err;
      // ほかの人も同時に書いていた：相手の変更を取り込んで、もう一度保存する
      const latest = await api(`/api/dept-event${query}`);
      const r = mergeText(base, form.text.value, latest.text);
      form.text.value = r.text;
      version = latest.version;
      if (r.both) toast("ほかの人も同じ欄を書いていたので、両方の内容を残しました。確認してください");
      return put();
    })
    .then((res) => { version = res.version; base = form.text.value; return res; });
  const auto = autoSave(form, saveNow, { status: el.querySelector("#auto-status"), key: `event:${d.day}:${d.event}`, label });
  if (inMeeting) guardMeetingBack(async () => { if (auto.pending()) await auto.flush(); await saveNow(); });
  const finish = async (button, done) => {
    if (auto.pending()) await auto.flush();
    busy(button, () => { sync = true; return saveNow().finally(() => { sync = false; }); })
      .then(() => { markSaved(form); done(); }).catch(() => {});
  };
  form.addEventListener("submit", (e) => { e.preventDefault(); finish(e.submitter, () => toast("保存しました")); });
  form.querySelector("[data-end]")?.addEventListener("click", async (e) => {
    if (!await confirmDialog(`${label}のMTGを終えますか？\n\n書いた内容は、${fmtDate(d.day)}の定例の議事録に入ります。`, { ok: "MTGを終える" })) return;
    finish(e.currentTarget, () => { toast("MTGを終えました。議事録は定例に入りました"); replaceHash(d.meeting ? `#/teirei/${d.meeting.id}` : "#/"); });
  });
}
