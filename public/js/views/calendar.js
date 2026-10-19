// カレンダー：MTG・リハーサル・タスクの期限・工程の期限を、月／週／3日／1日／スケジュールで表示する（表示は手動で切り替え）
import { api, esc, state, fmtDate, todayStr, addDays, WEEK, gcalEventUrl, gcalAllDayUrl, gcalLink, gcalChoice, weeklyRrule, doneTasksToggle, bindDoneTasksToggle, TASK_STATUS, confirmDialog, busy, toast, fmtDateTime, jstDateTime } from "../lib.js";
import { ico, iconText } from "../icons.js";

// 画面を開いているあいだだけ覚えておく（ブラウザには保存しない）
// スマホでは、文字が切れずに読める「スケジュール」（一覧）から始める
let view = window.matchMedia("(max-width: 760px)").matches ? "schedule" : "month";
let anchor = todayStr(); // 表示の基準日
let mine = true;
const hiddenKinds = new Set(); // 表示しない予定の種類
let filterOpen = false; // 「表示」の設定パネルを開いているか（切り替えて描き直しても開いたままにする）

const VIEWS = [["month", "月"], ["week", "週"], ["3day", "3日"], ["day", "1日"], ["schedule", "スケジュール"]];
const KINDS = [["teirei", "部門の定例"], ["meeting", "MTG"], ["rehearsal", "リハーサル"], ["task", "タスクの期限"], ["stage", "工程の期限"]];
const HOUR_PX = 48; // 時間軸の1時間の高さ

const weekday = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const monthOf = (d) => d.slice(0, 7);
const shiftMonth = (d, n) => {
  const [y, m] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
};

// 表示する日の範囲
function range() {
  if (view === "month") {
    const first = `${monthOf(anchor)}-01`;
    const start = addDays(first, -weekday(first));
    return { from: start, days: 42 };
  }
  if (view === "week") return { from: addDays(anchor, -weekday(anchor)), days: 7 };
  if (view === "3day") return { from: anchor, days: 3 };
  if (view === "day") return { from: anchor, days: 1 };
  return { from: anchor, days: 31 }; // スケジュール：基準日から1カ月
}

function move(n) {
  if (view === "month") anchor = shiftMonth(anchor, n);
  else if (view === "schedule") anchor = addDays(anchor, 31 * n);
  else anchor = addDays(anchor, n * { week: 7, "3day": 3, day: 1 }[view]);
}

function title(days) {
  if (view === "month") {
    const [y, m] = monthOf(anchor).split("-").map(Number);
    return `${y}年${m}月`;
  }
  const first = days[0];
  const last = days[days.length - 1];
  return days.length === 1 ? fmtDate(first) : `${fmtDate(first)}〜${fmtDate(last)}`;
}

// 予定を「時刻のあるもの（MTG・リハーサル）」と「終日のもの（タスク・工程の期限）」に分けて、日ごとにまとめる
// 押したときに詳細を出すため、表示中の予定を番号で引けるようにしておく
let events = [];
const hhmm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

function collect(data) {
  const byDay = {};
  events = [];
  const push = (date, ev) => {
    if (hiddenKinds.has(ev.kind)) return;
    ev.id = events.push({ ...ev, date }) - 1;
    (byDay[date] ||= []).push(ev);
  };
  const timed = (x, kind, label) => {
    const start = Number(x.starts_at.slice(11, 13)) * 60 + Number(x.starts_at.slice(14, 16));
    return { kind, timed: true, start, end: start + (x.duration_min || 60), time: x.starts_at.slice(11, 16), place: x.place, label };
  };
  for (const m of data.meetings) {
    push(m.starts_at.slice(0, 10), {
      ...timed(m, "meeting", m.project_name), sub: m.kind === "exchange" ? "意見交換会" : "MTG", kindLabel: m.kind === "exchange" ? "意見交換会" : "MTG", href: `#/meetings/${m.id}?from=calendar`,
      // 消す：議事録があれば議事録ごと（「確認する → ゴミ箱」に30日残り、戻せる）。定例の回は中止になる
      del: m.can_edit ? { url: `/api/meetings/${m.id}`, body: { with_minutes: true },
        message: `${m.project_name}の${fmtDateTime(m.starts_at)}の${m.kind === "exchange" ? "意見交換会" : "MTG"}を削除しますか？${m.has_minutes ? "\n\n議事録と、そこで作ったタスクも消えます。" : ""}\n「確認する → ゴミ箱」に30日残り、元に戻せます。${m.starts_at > nowStr() ? "\nこれからのMTGなので、PJメンバーにお知らせが届きます。" : ""}`,
        ok: m.kind === "regular" ? "この回を中止する" : "削除する" } : null,
      project: m.project_name, projectHref: `#/projects/${m.project_id}`,
      rows: [["議事録", m.has_minutes ? "記入済み" : "まだ書かれていません"]],
      // 今日以降は「MTGを始める」、過ぎたMTGは「議事録を書く」。「議事録を見る」は読むだけ（話すことは事前に書ける）
      open: m.starts_at.slice(0, 10) >= todayStr() ? "▶ MTGを始める" : "✏️ 議事録を書く",
      view: `#/meetings/${m.id}?mode=view`,
      gcal: gcalEventUrl({ title: `${m.project_name} MTG`, start: m.starts_at, durationMin: m.duration_min, location: m.place }),
      // 定例の回は「定例をまとめて（毎回くり返し）」も選べる
      gcalSeries: m.kind === "regular" && m.meeting_mode === "regular" && weeklyRrule(m.meeting_weekdays, m.meeting_interval)
        ? gcalEventUrl({ title: `${m.project_name} 定例MTG`, start: m.starts_at, durationMin: m.meeting_duration, location: m.meeting_place, recur: weeklyRrule(m.meeting_weekdays, m.meeting_interval) })
        : "",
    });
  }
  for (const t of data.teirei || []) {
    const until = t.until ? `;UNTIL=${t.until.replace(/-/g, "")}T235959Z` : "";
    push(t.starts_at.slice(0, 10), {
      ...timed({ starts_at: t.starts_at, duration_min: 60 }, "teirei", "部門の定例"), kindLabel: "部門の定例",
      href: t.meeting_id ? `#/teirei/${t.meeting_id}` : "#/teirei",
      rows: [["議事録", t.meeting_id ? (t.ended ? "終了" : "進行中・準備中") : "まだ始まっていません"]],
      open: t.meeting_id ? "定例の議事録を開く" : "定例の画面を開く",
      gcal: gcalEventUrl({ title: "部門の定例", start: t.starts_at, durationMin: 60 }),
      gcalSeries: t.weekday !== null ? gcalEventUrl({ title: "部門の定例", start: t.starts_at, durationMin: 60, recur: `${weeklyRrule([t.weekday], 1)}${until}` }) : "",
    });
  }
  for (const r of data.rehearsals || []) {
    push(r.starts_at.slice(0, 10), {
      ...timed(r, "rehearsal", `リハーサル：${r.project_name}`), kindLabel: "発表リハーサル", href: `#/projects/${r.project_id}?tab=present`,
      project: r.project_name, projectHref: `#/projects/${r.project_id}`, rows: [], open: "発表準備を開く",
      del: r.can_edit ? { url: `/api/rehearsals/${r.id}`, body: {}, message: `${r.project_name}の${fmtDateTime(r.starts_at)}のリハーサルを削除しますか？`, ok: "削除する" } : null,
      gcal: gcalEventUrl({ title: `${r.project_name} 発表リハーサル`, start: r.starts_at, durationMin: r.duration_min, location: r.place }),
    });
  }
  for (const t of data.tasks.filter((x) => state.showDoneTasks || x.status !== "done")) {
    push(t.due_date, {
      kind: "task", kindLabel: "タスクの期限", done: t.status === "done", label: t.title, sub: `${t.project_name}${t.assignee_name ? `・${t.assignee_name}` : ""}`,
      href: `#/projects/${t.project_id}?tab=tasks`, project: t.project_name, projectHref: `#/projects/${t.project_id}`,
      rows: [["担当", t.assignee_name || "担当なし"], ["状態", TASK_STATUS[t.status] || t.status]], open: "タスクを開く",
      gcal: gcalAllDayUrl({ title: `【期限】${t.title}（${t.project_name}）`, date: t.due_date }),
    });
  }
  for (const s of data.stages) {
    const name = state.types[s.type]?.stages.find((x) => x.no === s.stage_no)?.name || "";
    push(s.due_date, {
      kind: "stage", kindLabel: "工程の期限", label: `${name}の期限`, sub: s.project_name, href: `#/projects/${s.project_id}`,
      project: s.project_name, projectHref: `#/projects/${s.project_id}`, rows: [["工程", `工程${s.stage_no}・${name}`]], open: "PJの工程を開く",
      gcal: gcalAllDayUrl({ title: `【工程】${name}の期限（${s.project_name}）`, date: s.due_date }),
    });
  }
  // 時刻のある予定を先に、時刻順に
  for (const list of Object.values(byDay)) list.sort((a, b) => (a.timed ? a.start : -1) - (b.timed ? b.start : -1));
  return byDay;
}

const chip = (e) => `<a data-ev="${e.id}" class="chip chip-${e.kind} ${e.done ? "is-done" : ""}" href="${e.href}" title="${esc(e.label)}${e.sub ? `（${esc(e.sub)}）` : ""}">${e.timed ? `<b>${e.time}</b> ` : ""}${esc(e.label)}</a>`;

export async function renderCalendar(el) {
  const { from, days: n } = range();
  const days = Array.from({ length: n }, (_, i) => addDays(from, i));
  const data = await api(`/api/calendar?from=${from}&to=${days[n - 1]}&mine=${mine ? 1 : 0}`);
  const byDay = collect(data);
  const today = todayStr();

  el.innerHTML = `
    <div class="cal-toolbar">
      <div class="row-left">
        <button class="small" data-today>今日</button>
        <button class="small icon-btn" data-move="-1" aria-label="前へ">‹</button>
        <button class="small icon-btn" data-move="1" aria-label="次へ">›</button>
        <strong class="month-label">${title(days)}</strong>
      </div>
      <div class="row-left cal-controls">
        <select class="cal-view-select" aria-label="表示の切り替え">
          ${VIEWS.map(([k, l]) => `<option value="${k}" ${view === k ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        <details class="cal-filter" ${filterOpen ? "open" : ""}>
          <summary class="button small">表示${mine ? "：自分" : "：部門全体"}${hiddenKinds.size ? `<span class="filter-count">${hiddenKinds.size}種類 非表示</span>` : ""}</summary>
          <div class="cal-filter-panel">
            <p class="filter-label">だれの予定</p>
            <div class="tabs">
              <button aria-selected="${mine}" data-mine="1">自分の予定</button>
              <button aria-selected="${!mine}" data-mine="0">部門全体</button>
            </div>
            <p class="filter-label">予定の種類（押すと表示・非表示）</p>
            <div class="kind-toggles">${KINDS.map(([k, l]) => `
              <label class="kind-toggle chip-${k} ${hiddenKinds.has(k) ? "is-off" : ""}">
                <input type="checkbox" data-kind="${k}" ${hiddenKinds.has(k) ? "" : "checked"}> ${l}</label>`).join("")}
            </div>
            ${doneTasksToggle(data.tasks.filter((t) => t.status === "done").length)}
          </div>
        </details>
      </div>
    </div>
    <div id="cal-body">${view === "month" ? monthView(days, byDay, today) : view === "schedule" ? scheduleView(days, byDay, today) : timeGrid(days, byDay, today)}</div>`;

  el.querySelector("[data-today]").addEventListener("click", () => { anchor = today; renderCalendar(el); });
  el.querySelectorAll("[data-move]").forEach((b) => b.addEventListener("click", () => { move(Number(b.dataset.move)); renderCalendar(el); }));
  el.querySelector(".cal-view-select").addEventListener("change", (e) => { view = e.target.value; renderCalendar(el); });
  // 「表示」の設定：だれの予定・予定の種類・完了したタスク
  const filter = el.querySelector(".cal-filter");
  filter.addEventListener("toggle", () => { filterOpen = filter.open; });
  el.querySelectorAll("[data-mine]").forEach((b) => b.addEventListener("click", () => { mine = b.dataset.mine === "1"; renderCalendar(el); }));
  el.querySelectorAll("[data-kind]").forEach((cb) => cb.addEventListener("change", () => {
    if (cb.checked) hiddenKinds.delete(cb.dataset.kind);
    else hiddenKinds.add(cb.dataset.kind);
    renderCalendar(el);
  }));
  // 予定を押すと、すぐ移動せずに詳細を出す（Googleカレンダーへの追加ボタンはそのまま）
  el.querySelector("#cal-body").addEventListener("click", (e) => {
    filter.open = false; // カレンダーを触ったら設定パネルは閉じる
    const a = e.target.closest("[data-ev]");
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    showDetail(events[Number(a.dataset.ev)], () => renderCalendar(el));
  });
  // 日付を押すと、その日の1日表示へ
  el.querySelectorAll("[data-day]").forEach((b) => b.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    anchor = b.dataset.day;
    view = "day";
    renderCalendar(el);
  }));
  bindDoneTasksToggle(el, () => renderCalendar(el));
  // 時間軸の表示は、最初の予定（なければ8時）が見える位置から
  const body = el.querySelector(".tg-scroll");
  if (body) body.scrollTop = Number(body.dataset.scrollTo || 0);
}

// ---------- 月 ----------
function monthView(days, byDay, today) {
  const month = monthOf(anchor);
  const MAX = 4; // 1日に出す予定の数（それ以上は「他n件」）
  return `
    <div class="cal-grid" role="grid">
      ${WEEK.map((w) => `<div class="cal-head">${w}</div>`).join("")}
      ${days.map((d) => {
        const list = byDay[d] || [];
        return `
        <div class="cal-cell ${d.startsWith(month) ? "" : "is-other"} ${d === today ? "is-today" : ""}" data-day="${d}">
          <span class="cal-date">${Number(d.slice(8))}</span>
          ${list.slice(0, MAX).map(chip).join("")}
          ${list.length > MAX ? `<span class="more-link">他${list.length - MAX}件</span>` : ""}
        </div>`;
      }).join("")}
    </div>`;
}

// ---------- 週・3日・1日（時間軸） ----------
function timeGrid(days, byDay, today) {
  const timedAll = days.flatMap((d) => (byDay[d] || []).filter((e) => e.timed));
  const firstHour = timedAll.length ? Math.min(8, ...timedAll.map((e) => Math.floor(e.start / 60))) : 8;
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const anyAllDay = days.some((d) => (byDay[d] || []).some((e) => !e.timed));
  const scrollTo = Math.max(0, (timedAll.length ? Math.min(...timedAll.map((e) => e.start)) / 60 : firstHour) - 0.5) * HOUR_PX;

  const column = (d) => {
    const events = (byDay[d] || []).filter((e) => e.timed);
    // 重なる予定は横に並べる（重なりのまとまりごとに列を割り当てる）
    const placed = [];
    let cluster = [];
    let clusterEnd = -1;
    const flush = () => {
      const lanes = [];
      for (const e of cluster) {
        let lane = lanes.findIndex((end) => end <= e.start);
        if (lane < 0) { lane = lanes.length; lanes.push(0); }
        lanes[lane] = e.end;
        placed.push({ e, lane, lanes: 0 });
      }
      for (const p of placed.slice(placed.length - cluster.length)) p.lanes = lanes.length;
      cluster = [];
    };
    for (const e of events) {
      if (e.start >= clusterEnd && cluster.length) flush();
      cluster.push(e);
      clusterEnd = Math.max(clusterEnd, e.end);
    }
    if (cluster.length) flush();
    return `
      <div class="tg-col ${d === today ? "is-today" : ""}">
        ${placed.map(({ e, lane, lanes }) => `
          <a data-ev="${e.id}" class="tg-ev chip-${e.kind}" href="${e.href}"
             style="top:${(e.start / 60) * HOUR_PX}px;height:${Math.max(22, ((e.end - e.start) / 60) * HOUR_PX - 2)}px;left:calc(${(100 / lanes) * lane}% + 1px);width:calc(${100 / lanes}% - 3px)">
            <b>${esc(e.label)}</b><small>${e.time}${e.place ? ` ${esc(e.place)}` : ""}</small></a>`).join("")}
        ${d === today ? `<div class="tg-now" style="top:${(nowMin / 60) * HOUR_PX}px"></div>` : ""}
      </div>`;
  };

  return `
    <div class="tg" style="--days:${days.length};--hour:${HOUR_PX}px">
      <div class="tg-row tg-head">
        <div></div>
        ${days.map((d) => `<button type="button" class="tg-day ${d === today ? "is-today" : ""}" data-day="${d}">
          <span>${WEEK[weekday(d)]}</span><b>${Number(d.slice(8))}</b></button>`).join("")}
      </div>
      ${anyAllDay ? `<div class="tg-row tg-allday">
        <div class="tg-label">終日</div>
        ${days.map((d) => `<div class="tg-allday-cell">${(byDay[d] || []).filter((e) => !e.timed).map(chip).join("")}</div>`).join("")}
      </div>` : ""}
      <div class="tg-scroll" data-scroll-to="${Math.round(scrollTo)}">
        <div class="tg-row tg-body" style="height:${24 * HOUR_PX}px">
          <div class="tg-hours">${Array.from({ length: 24 }, (_, h) => h ? `<span style="top:${h * HOUR_PX}px">${h}:00</span>` : "").join("")}</div>
          ${days.map(column).join("")}
        </div>
      </div>
    </div>`;
}

// ---------- スケジュール（一覧） ----------
function scheduleView(days, byDay, today) {
  const list = days.filter((d) => byDay[d]);
  const line = (e) => `
    <div class="sch-ev chip-${e.kind} ${e.done ? "is-done" : ""}">
      <a data-ev="${e.id}" href="${e.href}"><b>${esc(e.label)}</b>
        <small>${e.timed ? `${e.time}〜${String(Math.floor(e.end / 60) % 24).padStart(2, "0")}:${String(e.end % 60).padStart(2, "0")}${e.place ? `・${esc(e.place)}` : ""}` : "終日"}${e.sub && !e.timed ? `・${esc(e.sub)}` : ""}</small></a>
      ${gcalChoice(e.gcal, e.gcalSeries, "")}
    </div>`;
  return list.length ? `<div class="sch">${list.map((d) => `
      <div class="sch-day ${d === today ? "is-today" : ""}">
        <button type="button" class="sch-date" data-day="${d}"><span>${WEEK[weekday(d)]}</span><b>${Number(d.slice(8))}</b><small>${Number(d.slice(5, 7))}月</small></button>
        <div class="sch-list">${byDay[d].map(line).join("")}</div>
      </div>`).join("")}</div>`
    : `<div class="empty"><p>${fmtDate(days[0])}から1カ月のあいだに予定はありません。</p></div>`;
}

// ---------- 予定の詳細（スマホでは下から出るシート） ----------
function showDetail(e, reload) {
  if (!e) return;
  const when = e.timed ? `${fmtDate(e.date)} ${hhmm(e.start)}〜${hhmm(e.end)}` : `${fmtDate(e.date)}（終日）`;
  const rows = [
    [e.timed ? "日時" : "期限", when],
    ...(e.timed ? [["場所", e.place || "未定"]] : []),
    ...e.rows,
  ];
  const back = document.createElement("div");
  back.className = "dialog-backdrop sheet";
  back.innerHTML = `
    <div class="dialog ev-detail" role="dialog" aria-modal="true" aria-labelledby="ev-title">
      <div class="ev-detail-head">
        <span class="ev-kind chip-${e.kind}">${esc(e.kindLabel)}</span>
        <button type="button" class="link-btn" data-close aria-label="閉じる">✕</button>
      </div>
      <h2 id="ev-title" class="${e.done ? "is-done" : ""}">${esc(e.label)}</h2>
      <dl class="ev-rows">
        ${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}
        ${e.project ? `<dt>PJ</dt><dd><a href="${e.projectHref}" data-go>${esc(e.project)}</a></dd>` : ""}
      </dl>
      <div class="form-actions">
        ${e.del ? `<button type="button" class="link-btn danger" data-del>${ico("trash")} 削除</button>` : ""}
        ${gcalChoice(e.gcal, e.gcalSeries)}
        <span class="row-left">
          ${e.view ? `<a class="button" href="${e.view}" data-go>${ico("doc")} 議事録を見る</a>` : ""}
          <a class="button primary" href="${e.href}" data-go>${iconText(e.open)}</a>
        </span>
      </div>
    </div>`;
  const close = () => { back.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (ev) => { if (ev.key === "Escape") close(); };
  back.addEventListener("click", (ev) => { if (ev.target === back || ev.target.closest("[data-close],[data-go]")) close(); });
  document.addEventListener("keydown", onKey);
  document.body.append(back);
  back.querySelector("[data-go]").focus();
  back.querySelector("[data-del]")?.addEventListener("click", async (ev) => {
    if (!await confirmDialog(e.del.message, { ok: e.del.ok })) return;
    busy(ev.currentTarget, () => api(e.del.url, { method: "DELETE", body: e.del.body }))
      .then(() => { close(); toast("削除しました"); reload(); }).catch(() => {});
  });
}

// 今の日本時間（'YYYY-MM-DDTHH:MM'）
function nowStr() { return jstDateTime(Date.now()); }
