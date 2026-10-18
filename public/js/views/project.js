// PJ詳細：工程ナビ（チェックリスト・期限）／タスク／MTG
import { api, esc, state, avatar, dueBadge, fmtDate, fmtDateTime, busy, toast, formData, memberOptions, TASK_STATUS, gcalEventUrl, gcalAllDayUrl, gcalLink, gcalChoice, weeklyRrule, hashQuery, WEEK, membersFirst, jstDateTime, stageStepper, bindFold, keepView, celebrate, takeProgressHint, doneTasksToggle, bindDoneTasksToggle, confirmDialog, skipButton, bindSkipButtons, assigneePicker, idsOf, pickerIds, confirmTaskDone } from "../lib.js";
import { renderTreeTab, renderMeasuresTab, renderSourcesView } from "./research.js";
import { renderPresentationTab } from "./presentation.js";
import { renderProjectRecords } from "./search.js";
import { roundsTable } from "./seeds.js";
import { schedulePollLinks } from "./schedule-poll.js";
import { ico } from "../icons.js";

export async function renderProject(el, id) {
  const data = await api(`/api/projects/${id}`);
  const { project: p, canEdit } = data;
  const type = state.types[p.type];
  const tab = hashQuery().get("tab") || "stages";
  // いまの工程のチェックの進み具合（スキップした項目は数えない）
  const cur = data.checklist.filter((c) => c.stage_no === p.current_stage && !c.skipped_at);
  const stageProgress = cur.length ? cur.filter((c) => c.done_at).length / cur.length : 0;
  // MTGを終えて戻ってきたとき：数直線をMTGの前の位置から始めて、今の位置まで伸ばす
  const hint = p.status === "active" ? takeProgressHint(p.id) : null;
  const ro = canEdit ? "" : "disabled";

  const tabs = [["stages", "工程"], ["tasks", `タスク（${data.tasks.filter((t) => t.status !== "done").length}）`], ["records", "記録"],
    ["tree", "樹形図"], ["measures", "施策"], ["sources", "資料"], ["present", "発表の準備・提出"]];
  el.innerHTML = `
    <nav class="breadcrumb"><a href="#/projects">PJ</a> / ${esc(p.name)}</nav>
    <div class="pj-header card">
      <div class="pj-header-main">
        <span class="stage-pill">${esc(type.label)}${p.personal ? "・個人PJ" : ""}${p.status === "done" ? "・完了" : p.status === "archived" ? "・一時中止" : ""}</span>
        <h1>${esc(p.name)}</h1>
        ${p.description ? `<p class="desc fold">${esc(p.description)}</p>` : ""}
        <div class="people-stack">${data.members.map((m) => avatar(m)).join("")}<span class="more">${data.members.map((m) => `<a href="#/members/${encodeURIComponent(m.id)}">${esc(m.name)}</a>${m.id === p.pm_id ? '<span class="pm-tag">PM</span>' : ""}`).join("、")}</span></div>
        ${data.origin ? `<details class="pj-origin" data-origin-seed="${data.origin.seed_id}" data-origin-round="${data.origin.round_id}">
          <summary class="muted small">${ico("sprout")} ${esc(data.origin.round_title)} から生まれたPJ（どうやって選ばれたか）</summary>
          <div class="pj-origin-body"><p class="loading small">読み込み中…</p></div></details>` : ""}
      </div>
      <div class="pj-header-actions">
        ${p.memo_doc_url ? `<a class="button small" href="${esc(p.memo_doc_url)}" target="_blank" rel="noopener">${ico("search")} リサーチドキュメント</a>` : ""}
        ${p.share_doc_url ? `<a class="button small" href="${esc(p.share_doc_url)}" target="_blank" rel="noopener">${ico("chart")} 課題共有</a>` : ""}
        ${p.doc_url ? `<a class="button small" href="${esc(p.doc_url)}" target="_blank" rel="noopener">${ico("doc")} 政調用の本文</a>` : ""}
        ${p.script_doc_url ? `<a class="button small" href="${esc(p.script_doc_url)}" target="_blank" rel="noopener">${ico("mic")} 台本</a>` : ""}
        ${p.discord_channel_id && state.guildId ? `<a class="button small" href="https://discord.com/channels/${esc(state.guildId)}/${esc(p.discord_channel_id)}" target="_blank" rel="noopener">${ico("chat")} Discord</a>` : ""}
        ${canEdit ? `<a class="button small" href="#/projects/${p.id}/edit">編集</a>` : ""}
        ${state.me.canSeeHearings ? `<a class="button small" href="#/hearings/new?project=${p.id}">${ico("handshake")} ヒアリング申請</a>` : ""}
      </div>
    </div>
    ${canEdit ? "" : `<p class="notice">閲覧のみです。編集できるのはPJメンバーと管理者です。</p>`}
    ${completionBanner(p, canEdit)}
    ${p.status === "active" ? `<nav class="pj-quick" aria-label="このPJでよく使う操作">
      ${canEdit ? `<a class="button small primary" href="#/start?project=${p.id}">${ico("play")} <span>MTG<span class="hide-sm">を始める</span></span></a>` : ""}
      <a class="button small" href="#/present/${p.id}">${ico("mic")} <span>発表<span class="hide-sm">する</span></span></a>
      ${canEdit ? `<a class="button small" href="#/report/${p.id}">${ico("note")} <span><span class="hide-sm">定例の</span>進捗<span class="hide-sm">を書く</span></span></a>` : ""}
    </nav>` : ""}
    ${stageStepper(p, data.stages, { progress: hint ? hint.from : stageProgress })}
    <div class="tabs" role="tablist">
      ${tabs.map(([k, l]) => `<a role="tab" class="tab" aria-selected="${tab === k}" href="#/projects/${p.id}?tab=${k}">${l}</a>`).join("")}
    </div>
    <div id="tab-body"></div>`;

  bindFold(el);
  bindOrigin(el);
  if (hint) animateStepper(el, hint, stageProgress);
  bindCompletion(el, p, () => keepView(el, () => renderProject(el, id)));
  const body = el.querySelector("#tab-body");
  // チェックなどで描き直しても、開いていた欄とスクロールの位置はそのまま（上に戻らないように）
  const reload = () => keepView(el, () => renderProject(el, id));
  const renderTab = async (k, target) => {
    if (k === "present") await renderPresentationTab(target, p.id);
    else if (k === "tree") await renderTreeTab(target, p.id, reload);
    else if (k === "measures") await renderMeasuresTab(target, p.id, reload);
    else if (k === "sources") await renderSourcesView(target, { projectId: p.id, canAdd: canEdit });
    else if (k === "tasks") renderTasks(target, data, ro, reload);
    else if (k === "records") await renderProjectRecords(target, p.id);
    else renderStages(target, data, ro, reload);
  };
  await renderTab(tab, body);

  // タブの切り替えは、PJ全体を読み直さずに、下の中身だけを描き替える（すぐ切り替わるように）。
  // 工程・タスクは手元のデータですぐ出す。ほかのタブは新しい枠で読み込み、出来たら差し替える
  let switching = 0;
  const tabKey = (a) => new URLSearchParams(a.getAttribute("href").split("?")[1] || "").get("tab") || "stages";
  const isQuick = (k) => k === "stages" || k === "tasks";
  // 先読み：タブに指が触れた・マウスが乗った時点で、裏で描いておく（押したときにすぐ出るように）
  const pre = {};
  const prerender = (k) => (pre[k] ||= (async () => {
    const box = document.createElement("div");
    box.id = "tab-body";
    try { await renderTab(k, box); } catch (err) { box.innerHTML = `<div class="empty"><p>${esc(err.message)}</p></div>`; }
    return box;
  })());
  const tabsEl = el.querySelector(".tabs");
  const onIntent = (e) => {
    const a = e.target.closest?.("a[role=tab]");
    if (a && a.getAttribute("aria-selected") !== "true" && !isQuick(tabKey(a))) prerender(tabKey(a));
  };
  tabsEl?.addEventListener("pointerover", onIntent, { passive: true });
  tabsEl?.addEventListener("touchstart", onIntent, { passive: true });
  tabsEl?.addEventListener("focusin", onIntent);
  tabsEl?.addEventListener("click", async (e) => {
    const a = e.target.closest("a[role=tab]");
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    if (a.getAttribute("aria-selected") === "true") return;
    const k = tabKey(a);
    el.querySelectorAll(".tabs a[role=tab]").forEach((t) => t.setAttribute("aria-selected", String(t === a)));
    // タブの切り替えは「戻る」の対象にしない（戻るでPJの前の画面へ戻れるように）。URLだけ今のタブに合わせる
    history.replaceState(history.state, "", a.getAttribute("href"));
    const mine = ++switching;
    let next;
    if (isQuick(k)) {
      next = document.createElement("div");
      next.id = "tab-body";
      renderTab(k, next);
    } else {
      // 先読みが間に合っていればすぐ出る。0.3秒たっても出来なければ「読み込み中…」
      const current = el.querySelector("#tab-body");
      const timer = setTimeout(() => {
        if (mine === switching) current.innerHTML = `<p class="loading" style="min-height:${Math.min(current.offsetHeight, 400)}px">読み込み中…</p>`;
      }, 300);
      next = await prerender(k);
      clearTimeout(timer);
      delete pre[k]; // 一度使ったら、次に開くときは描き直す（新しい内容にする）
    }
    if (mine !== switching) return; // その間に別のタブを押していたら、そちらを優先する
    next.classList.add("tab-in");
    el.querySelector("#tab-body").replaceWith(next);
    bindFold(next);
  });
}

function renderStages(body, data, ro, reload) {
  const { project: p, stages, checklist } = data;
  const type = state.types[p.type];
  const stageRow = (no) => stages.find((s) => s.stage_no === no) || {};
  // 結び付けられるMTG（中止でない、始まっているもの）
  const pastMeetings = data.meetings.filter((m) => !m.cancelled && m.starts_at <= data.now);
  // 各MTGを、開いた日が入る工程に振り分ける（どの工程の期間にも入らなければ、直前に始まった工程へ）
  const ordered = [...stages].sort((a, b) => a.stage_no - b.stage_no);
  const stageOfDate = (date) => {
    const hit = ordered.filter((r) => r.start_date && r.start_date <= date && date <= r.due_date).pop();
    if (hit) return hit.stage_no;
    return ordered.filter((r) => r.start_date && r.start_date <= date).pop()?.stage_no ?? 0;
  };
  const heldMeetings = data.meetings.filter((m) => !m.cancelled && (m.starts_at <= data.now || m.minute_id));
  const meetingsOfStage = (no) => heldMeetings.filter((m) => stageOfDate(m.starts_at.slice(0, 10)) === no)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const meetingLink = (c) => c.meeting_id
    ? `<a class="minute-link" href="#/meetings/${c.meeting_id}">${ico("note")} ${fmtDateTime(c.meeting_starts_at)} のMTG${c.meeting_has_minutes ? "" : "（議事録なし）"}</a>`
    : `<span class="muted small">議事録なし</span>`;

  const stageCard = (s) => {
    const row = stageRow(s.no);
    const items = checklist.filter((c) => c.stage_no === s.no);
    const done = items.filter((c) => c.done_at).length;
    const needed = items.filter((c) => !c.skipped_at).length;
    const isCurrent = s.no === p.current_stage;
    const isLast = s.no === type.stages.length - 1;
    const ms = meetingsOfStage(s.no);
    return `
      <details class="stage card ${isCurrent ? "is-current" : ""}" data-key="stage-${s.no}" ${isCurrent ? "open" : ""}>
        <summary>
          <span class="stage-no">${s.no}</span>
          <span class="stage-title"><strong>${esc(s.name)}</strong><small>${esc(s.period)}・${fmtDate(row.start_date)}〜${fmtDate(row.due_date)}</small></span>
          <span class="stage-progress">${done}/${needed}</span>
          ${isCurrent ? `<span class="status-now">いまここ</span>` : ""}
        </summary>
        <p class="stage-summary">${esc(s.summary)}</p>
        ${["final_prep", "presentation", "final"].includes(s.role) ? `<p><a class="button small" href="#/projects/${p.id}?tab=present">${ico("mic")} ${s.role === "final" ? "フィードバックと最終提出" : "発表準備（役割分担・リハーサルなど）"}を「発表の準備・提出」タブで管理する</a></p>` : ""}
        ${["research", "share_prep", "measures", "final_prep"].includes(s.role) ? `<p class="caution">${ico("warning")} AIで調べた情報は必ず一次出典を確認する。出典のない数字は使わない。</p>` : ""}
        <ul class="checklist">
          ${items.map((c) => `
            <li class="${c.skipped_at ? "is-skipped" : ""}">
              <label class="check"><input type="checkbox" data-check="${c.id}" ${c.done_at ? "checked" : ""} ${ro || (c.skipped_at ? "disabled" : "")}>
                <span>${esc(c.label)}${c.hint ? `<small>${esc(c.hint)}</small>` : ""}</span></label>
              ${c.skipped_at ? `<span class="muted small">スキップ${c.skipped_by_name ? `・${esc(c.skipped_by_name)}` : ""}</span>` : ""}
              ${skipButton(c, ro)}
              ${c.done_at ? `<span class="done-meta">
                <span class="muted small">${fmtDate(jstDateTime(c.done_at))}${c.done_by_name ? `・${esc(c.done_by_name)}` : ""}</span>
                ${meetingLink(c)}
                ${ro ? "" : `<button class="link-btn" data-pick="${c.id}">議事録を選ぶ</button>`}
              </span>` : ""}
              ${c.is_custom && !ro ? `<button class="link-btn danger" data-del-check="${c.id}" aria-label="削除">削除</button>` : ""}
            </li>`).join("")}
        </ul>
        ${ms.length ? `<div class="stage-minutes"><h4>この工程のMTG・議事録</h4><ul>${ms.map((m) => `
          <li><a class="minute-link" href="#/meetings/${m.id}">${ico("note")} ${fmtDateTime(m.starts_at)} のMTG${m.minute_id ? "" : "（議事録まだ）"}</a></li>`).join("")}</ul></div>` : ""}
        ${ro ? "" : `
          <form class="inline-form" data-add-check="${s.no}">
            <input name="label" maxlength="120" placeholder="このPJ独自の項目を追加" required>
            <button class="small">追加</button>
          </form>
          <div class="stage-actions">
            <label class="small">期限
              <input type="date" data-due="${s.no}" value="${esc(row.due_date || "")}">
              ${row.due_manual ? `<button class="link-btn" data-due-reset="${s.no}">自動に戻す</button>` : `<span class="muted small">（自動）</span>`}
            </label>
            ${isCurrent && !isLast ? `<button class="primary small" data-stage="${s.no + 1}">この工程を完了して「${esc(type.stages[s.no + 1].name)}」へ</button>` : ""}
            ${isCurrent && isLast && p.status === "active" && !p.completion_requested_at ? `<button type="button" class="primary small" data-completion="request">${ico("party")} 部門長に完了の承認を依頼する</button>` : ""}
            ${!isCurrent ? `<button class="small" data-stage="${s.no}">この工程を「いまここ」にする</button>` : ""}
          </div>`}
      </details>`;
  };
  // 済んだ工程はまとめて畳み、いまの工程がすぐ見えるようにする
  const doneStages = type.stages.filter((s) => s.no < p.current_stage);
  body.innerHTML = meetingPanel(data, ro)
    + type.stages.filter((s) => s.no >= p.current_stage).map(stageCard).join("")
    + (doneStages.length ? `<details class="done-stages" data-key="done-stages"><summary>✓ 済んだ工程を表示（${doneStages.length}）</summary>${doneStages.map(stageCard).join("")}</details>` : "");

  bindMeetingPanel(body, data, reload);
  bindSkipButtons(body, reload);
  body.querySelectorAll("[data-check]").forEach((cb) => cb.addEventListener("change", async () => {
    const item = checklist.find((c) => c.id === Number(cb.dataset.check));
    if (cb.checked && item?.notify_leaders && !item.done_at
      && !await confirmDialog(`「${item.label}」にチェックしますか？\n部門長・副部門長にお知らせが届きます。`, { ok: "チェックして知らせる" })) {
      cb.checked = false;
      return;
    }
    busy(cb, () => api(`/api/checklist/${cb.dataset.check}`, { method: "PATCH", body: { done: cb.checked } }))
      .then(() => {
        if (cb.checked && item) {
          const rest = checklist.filter((c) => c.stage_no === item.stage_no && c.id !== item.id && !c.done_at && !c.skipped_at);
          if (!rest.length) celebrate("この工程のチェックがすべて済みました！", "準備ができたら、次の工程へ進みましょう");
        }
        reload();
      }).catch(() => (cb.checked = !cb.checked));
  }));
  // チェックした項目に結び付けるMTGを選び直す
  body.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => {
    const c = checklist.find((x) => x.id === Number(b.dataset.pick));
    const select = document.createElement("select");
    select.className = "pick-meeting";
    select.innerHTML = `<option value="">（議事録なし）</option>` + pastMeetings.map((m) =>
      `<option value="${m.id}" ${m.id === c.meeting_id ? "selected" : ""}>${fmtDateTime(m.starts_at)} のMTG${m.minute_id ? "" : "（議事録なし）"}</option>`).join("");
    b.replaceWith(select);
    select.focus();
    select.addEventListener("change", () =>
      busy(select, () => api(`/api/checklist/${c.id}`, { method: "PATCH", body: { meeting_id: select.value ? Number(select.value) : null } }))
        .then(reload).catch(() => {}));
  }));
  body.querySelectorAll("[data-del-check]").forEach((b) => b.addEventListener("click", async () => {
    if (!await confirmDialog("この項目を削除しますか？")) return;
    busy(b, () => api(`/api/checklist/${b.dataset.delCheck}`, { method: "DELETE", body: {} })).then(reload).catch(() => {});
  }));
  body.querySelectorAll("[data-add-check]").forEach((f) => f.addEventListener("submit", (e) => {
    e.preventDefault();
    busy(e.submitter, () => api(`/api/projects/${p.id}/checklist`, {
      method: "POST", body: { stage_no: Number(f.dataset.addCheck), label: f.label.value },
    })).then(reload).catch(() => {});
  }));
  body.querySelectorAll("[data-due]").forEach((input) => input.addEventListener("change", () =>
    busy(input, () => api(`/api/projects/${p.id}/stages/${input.dataset.due}`, { method: "PUT", body: { due_date: input.value || null } }))
      .then(() => { toast("期限を変更しました"); reload(); }).catch(() => {})));
  body.querySelectorAll("[data-due-reset]").forEach((b) => b.addEventListener("click", () =>
    busy(b, () => api(`/api/projects/${p.id}/stages/${b.dataset.dueReset}`, { method: "PUT", body: { due_date: null } }))
      .then(reload).catch(() => {})));
  body.querySelectorAll("[data-stage]").forEach((b) => b.addEventListener("click", async () => {
    const to = Number(b.dataset.stage);
    const left = checklist.filter((c) => c.stage_no < to && c.stage_no >= p.current_stage && !c.done_at && !c.skipped_at).length;
    const toName = type.stages.find((s) => s.no === to)?.name || "";
    if (!await confirmDialog(`工程を「${toName}」にしますか？${left ? `\nチェックが済んでいない項目が${left}件あります。` : ""}\nPJメンバーにお知らせが届きます。`, { ok: "工程を変える" })) return;
    busy(b, () => api(`/api/projects/${p.id}/stage`, { method: "POST", body: { stage_no: to } }))
      .then(() => {
        if (to > p.current_stage) celebrate(`工程「${type.stages.find((s) => s.no === p.current_stage)?.name || ""}」を完了！`, `次は「${toName}」`);
        else toast("工程を更新しました");
        reload();
      }).catch(() => {});
  }));
}

let taskAddOpen = false; // 追加欄を開いたままにする（続けて追加できるように）

function renderTasks(body, data, ro, reload) {
  const { project: p, tasks } = data;
  const type = state.types[p.type];
  const stageOptions = (sel) => type.stages.map((s) => `<option value="${s.no}" ${s.no === sel ? "selected" : ""}>工程${s.no} ${esc(s.name)}</option>`).join("");

  const draw = () => {
    const list = tasks.filter((t) => state.showDoneTasks || t.status !== "done");
    body.innerHTML = `
      ${ro ? "" : `<details class="add-box" ${taskAddOpen ? "open" : ""}><summary class="button small">＋ タスクを追加</summary>
      <form class="card form task-form" id="task-form">
        <input name="title" maxlength="120" placeholder="タスクを追加（例：先行事例を3件集める）" required>
        ${assigneePicker(membersFirst(data.members), [state.me.id], { empty: "担当なし", members: data.members.map((m) => m.id) })}
        <input name="due_date" type="date" aria-label="期限">
        <select name="stage_no" aria-label="工程">${stageOptions(p.current_stage)}</select>
        <button class="primary">追加</button>
      </form></details>`}
      <div class="board-tools">
        ${doneTasksToggle(tasks.filter((t) => t.status === "done").length)}
      </div>
      ${list.length ? `<ul class="list task-list">${list.map((t) => `
        <li class="list-item ${t.status === "done" ? "is-done" : ""}">
          <div class="task-main">
            <select class="status-select s-${t.status}" data-status="${t.id}" ${ro} aria-label="状態">
              ${Object.entries(TASK_STATUS).map(([k, l]) => `<option value="${k}" ${k === t.status ? "selected" : ""}>${l}</option>`).join("")}
            </select>
            <span class="task-title">${esc(t.title)}</span>
          </div>
          <div class="meta">
            ${t.stage_no !== null ? `<span class="tag">工程${t.stage_no}</span>` : ""}
            ${t.assignee_name ? `<span>${idsOf(t).length > 1 ? ico("users") : avatar({ name: t.assignee_name, avatar: t.assignee_avatar })} ${esc(t.assignee_name)}</span>` : `<span class="muted">担当なし</span>`}
            ${dueBadge(t.due_date, t.status === "done")}
            ${t.due_date ? gcalLink(gcalAllDayUrl({ title: `【期限】${t.title}（${p.name}）`, date: t.due_date }), "") : ""}
            ${ro ? "" : `<button class="link-btn" data-edit="${t.id}">編集</button><button class="link-btn danger" data-del="${t.id}">削除</button>`}
          </div>
        </li>`).join("")}</ul>` : `<p class="muted">タスクはありません。</p>`}`;

    bindDoneTasksToggle(body, draw);
    body.querySelector(".add-box")?.addEventListener("toggle", (e) => { taskAddOpen = e.target.open; });
    // 自分以外を担当にするときは、その人にお知らせが届くので確認する
    const nameOfId = (id) => data.members.find((m) => m.id === id)?.name || state.users.find((u) => u.id === id)?.name || "";
    const confirmAssignee = (ids, title) => {
      const others = ids.filter((id) => id !== state.me.id);
      return others.length ? confirmDialog(`「${title}」の担当を${ids.map(nameOfId).join("・")}さんにしますか？\n担当の人にお知らせが届きます。`, { ok: "担当にして知らせる" }) : Promise.resolve(true);
    };
    body.querySelector("#task-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = { ...formData(e.target), assignee_ids: pickerIds(e.target) };
      const button = e.submitter;
      if (!await confirmAssignee(f.assignee_ids, f.title)) return;
      busy(button, () => api(`/api/projects/${p.id}/tasks`, { method: "POST", body: f }))
        .then(reload).catch(() => {});
    });
    body.querySelectorAll("[data-status]").forEach((s) => s.addEventListener("change", async () => {
      const t = tasks.find((x) => x.id === Number(s.dataset.status));
      if (s.value === "done" && !await confirmTaskDone(t.title)) { s.value = t.status; return; }
      busy(s, () => api(`/api/tasks/${t.id}`, { method: "PATCH", body: { status: s.value, version: t.version } }))
        .then(reload).catch(() => reload());
    }));
    body.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!await confirmDialog("このタスクを削除しますか？")) return;
      busy(b, () => api(`/api/tasks/${b.dataset.del}`, { method: "DELETE", body: {} })).then(reload).catch(() => {});
    }));
    body.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => {
      const t = tasks.find((x) => x.id === Number(b.dataset.edit));
      const li = b.closest("li");
      li.innerHTML = `
        <form class="task-form edit">
          <input name="title" maxlength="120" required value="${esc(t.title)}">
          ${assigneePicker(membersFirst(data.members), idsOf(t), { empty: "担当なし", members: data.members.map((m) => m.id) })}
          <input name="due_date" type="date" value="${esc(t.due_date || "")}">
          <select name="stage_no">${stageOptions(t.stage_no)}</select>
          <button class="primary small">保存</button><button type="button" class="small" data-cancel>やめる</button>
        </form>`;
      li.querySelector("[data-cancel]").addEventListener("click", draw);
      li.querySelector("form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = { ...formData(e.target), assignee_ids: pickerIds(e.target) };
        const button = e.submitter;
        const added = f.assignee_ids.filter((id) => !idsOf(t).includes(id));
        if (added.length && !await confirmAssignee(added, f.title)) return;
        busy(button, () => api(`/api/tasks/${t.id}`, { method: "PATCH", body: { ...f, version: t.version } }))
          .then(reload).catch(() => {});
      });
    }));
  };
  draw();
}

// 工程タブのいちばん上：MTGの追加と、これからのMTG（これまでのMTGは各工程のカードに出る）
function meetingPanel(data, ro) {
  const { project: p, meetings, now } = data;
  const upcoming = meetings.filter((m) => m.starts_at >= now).reverse();
  const weekdays = (p.meeting_weekdays || "").split(",").filter(Boolean).map(Number);
  const rrule = weeklyRrule(weekdays, p.meeting_interval);
  const firstRegular = upcoming.find((m) => m.kind === "regular" && !m.cancelled);
  const row = (m) => `
    <li class="list-item ${m.cancelled ? "is-cancelled" : ""}">
      <span><strong>${fmtDateTime(m.starts_at)}</strong>
        ${m.kind === "regular" ? `<span class="tag">定例</span>` : ""}${m.cancelled ? `<span class="tag">中止</span>` : ""}
        ${m.place ? `<span class="muted small">${esc(m.place)}</span>` : ""}</span>
      <div class="meta">
        ${m.cancelled ? "" : `<a class="link-btn" href="#/meetings/${m.id}">${m.minute_id ? "議事録を見る" : "議題・議事録"}</a>`}
        ${m.cancelled ? "" : gcalChoice(gcalEventUrl({ title: `${p.name} MTG`, start: m.starts_at, durationMin: m.duration_min, location: m.place }),
          m.kind === "regular" && rrule ? gcalEventUrl({ title: `${p.name} 定例MTG`, start: m.starts_at, durationMin: p.meeting_duration, location: p.meeting_place, recur: rrule }) : "", "")}
        ${ro || (m.minute_id && m.kind === "regular") ? "" : m.cancelled
          ? `<button class="link-btn" data-restore="${m.id}">中止を取り消す</button>`
          : `<button class="link-btn danger" data-cancel="${m.id}">${m.kind === "regular" ? "この回を中止" : "削除"}</button>`}
      </div>
    </li>`;
  const shown = upcoming.slice(0, 3);
  const rest = upcoming.slice(3);
  const nextOne = upcoming.find((m) => !m.cancelled);
  return `
    <details class="card meeting-panel" data-key="meetings">
      <summary class="section-head"><h2>${ico("calendar")} ミーティング</h2>
        <span class="small">${nextOne ? `次回 <strong>${fmtDateTime(nextOne.starts_at)}</strong>`
          : p.meeting_mode === "adhoc" ? `<strong class="warn">次回未定</strong>` : `<span class="muted">予定なし</span>`}
          <span class="muted fold-hint">▼</span></span></summary>
      <p class="muted small">${p.meeting_mode === "regular"
          ? `定例：${p.meeting_interval == 2 ? "隔週" : "毎週"} ${weekdays.map((d) => WEEK[d]).join("・")}曜 ${esc(p.meeting_time)}〜`
          : "毎回、MTGの最後に次回を決める"}</p>
      ${p.meeting_mode === "adhoc" ? `<div class="sp-links" id="sp-links"></div>` : ""}
      ${ro ? "" : `
      <form class="inline-form" id="meeting-form">
        <strong class="small">MTGを追加</strong>
        <input name="starts_at" type="datetime-local" required aria-label="日時">
        <input name="place" maxlength="200" placeholder="場所・URL（任意）" value="${esc(p.meeting_place)}">
        <button class="primary small">追加</button>
      </form>`}
      <p class="small"><a href="#/projects/${p.id}?tab=records">${ico("books")} このPJの記録（議事録・定例の進捗・発表）を見る</a></p>
      <h3 class="small">これからのMTG</h3>
      ${upcoming.length ? `<ul class="list">${shown.map(row).join("")}</ul>
        ${rest.length ? `<details><summary class="small">ほか${rest.length}件を表示</summary><ul class="list">${rest.map(row).join("")}</ul></details>` : ""}`
        : `<p class="muted small">${p.meeting_mode === "adhoc" ? `<strong class="warn">次回の日程が未定です。</strong>` : "予定はありません。"}</p>`}
      ${p.meeting_mode === "regular" ? `<div class="row-left" style="margin-top:8px">
        ${firstRegular ? gcalLink(gcalEventUrl({ title: `${p.name} 定例MTG`, start: firstRegular.starts_at, durationMin: p.meeting_duration, location: p.meeting_place, recur: rrule }), "定例をGoogleカレンダーに追加（繰り返し）") : ""}
        <a class="link-btn" href="/api/projects/${p.id}/regular.ics">定例のICS</a></div>` : ""}
    </details>`;
}

function bindMeetingPanel(body, data, reload) {
  const p = data.project;
  const spBox = body.querySelector("#sp-links");
  if (spBox) schedulePollLinks(spBox, p.id, data.canEdit).catch(() => {});
  body.querySelector("#meeting-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    const button = e.submitter;
    if (!await confirmDialog(`${fmtDateTime(f.starts_at)} のMTGを追加しますか？\nPJメンバーにお知らせが届きます。`, { ok: "追加して知らせる" })) return;
    busy(button, () => api(`/api/projects/${p.id}/meetings`, { method: "POST", body: f }))
      .then(() => { toast("MTGを追加しました"); reload(); }).catch(() => {});
  });
  body.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", async () => {
    const mt = data.meetings.find((x) => x.id === Number(b.dataset.cancel));
    if (!await confirmDialog(`${b.textContent.includes("中止") ? "この回を中止にしますか？" : "このMTGを削除しますか？"}${mt?.minute_id ? "\n議事録と、そこで作ったタスクも消えます。" : ""}\nPJメンバーにお知らせが届きます。`)) return;
    busy(b, () => api(`/api/meetings/${b.dataset.cancel}`, { method: "DELETE", body: { with_minutes: true } })).then(reload).catch(() => {});
  }));
  body.querySelectorAll("[data-restore]").forEach((b) => b.addEventListener("click", async () => {
    if (!await confirmDialog("この回の中止を取り消しますか？\nPJメンバーにお知らせが届きます。", { ok: "取り消して知らせる" })) return;
    busy(b, () => api(`/api/meetings/${b.dataset.restore}`, { method: "PATCH", body: { cancelled: false } })).then(reload).catch(() => {});
  }));
}

// ---------- PJの完了：最終提出 → 部門長に承認を依頼 → 部門長が承認すると完了 ----------
function completionBanner(p, canEdit) {
  const nameOf = (id) => state.users.find((u) => u.id === id)?.name || "";
  const when = (ms) => fmtDate(jstDateTime(ms));
  if (p.status === "done") {
    return `<div class="notice completion is-done"><span>${ico("party")} <strong>このPJは完了しました</strong>
      ${p.completed_at ? `<small class="muted">（${when(p.completed_at)}${p.completed_by ? `・承認：${esc(nameOf(p.completed_by))}` : ""}）</small>` : ""}</span>
      ${state.me.isAdmin ? `<button type="button" class="small" data-completion="reopen">進行中に戻す</button>` : ""}</div>`;
  }
  if (p.status === "active" && p.completion_requested_at) {
    return `<div class="notice completion is-waiting"><span>${ico("hourglass")} <strong>最終提出が済み、部門長の承認待ちです</strong>
      <small class="muted">（${when(p.completion_requested_at)}${p.completion_requested_by ? `・依頼：${esc(nameOf(p.completion_requested_by))}` : ""}）</small></span>
      <span class="row-left">${state.me.isAdmin ? `<button type="button" class="primary small" data-completion="approve">${ico("check")} 承認してPJを完了にする</button>
        <button type="button" class="small" data-completion="reject">差し戻す</button>`
        : canEdit ? `<button type="button" class="link-btn" data-completion="cancel">依頼を取り下げる</button>` : ""}</span></div>`;
  }
  return "";
}

function bindCompletion(el, p, reload) {
  el.querySelectorAll("[data-completion]").forEach((b) => b.addEventListener("click", async () => {
    const action = b.dataset.completion;
    const body = { action };
    if (action === "request" && !await confirmDialog(`「${p.name}」の最終提出が済んだことを、部門長・副部門長に知らせて完了の承認を依頼しますか？`, { ok: "承認を依頼する" })) return;
    if (action === "approve" && !await confirmDialog(`「${p.name}」を完了にしますか？\nPJメンバーに知らせます。`, { ok: "承認して完了にする" })) return;
    if (action === "reopen" && !await confirmDialog(`「${p.name}」を進行中に戻しますか？\nPJメンバーにお知らせが届きます。`, { ok: "進行中に戻す" })) return;
    if (action === "reject") {
      // 理由は、その場に出す入力欄で書いてもらう
      const box = b.closest(".completion");
      if (!box.querySelector(".reject-form")) {
        box.insertAdjacentHTML("beforeend", `<form class="inline-form reject-form">
          <input name="reason" maxlength="300" placeholder="差し戻す理由（PJメンバーに届きます）" required>
          <button class="small danger">差し戻す</button></form>`);
        box.querySelector(".reject-form").addEventListener("submit", async (e) => {
          e.preventDefault();
          if (!await confirmDialog(`PJの完了を差し戻しますか？\nPJメンバーに、理由とあわせてお知らせが届きます。`, { ok: "差し戻して知らせる" })) return;
          busy(e.submitter, () => api(`/api/projects/${p.id}/completion`, { method: "POST", body: { action: "reject", reason: e.target.reason.value } }))
            .then(() => { toast("差し戻しました"); reload(); }).catch(() => {});
        });
        box.querySelector(".reject-form input").focus();
      }
      return;
    }
    busy(b, () => api(`/api/projects/${p.id}/completion`, { method: "POST", body }))
      .then(() => {
        if (action === "approve") celebrate(`「${p.name}」が完了しました！`, "おつかれさまでした");
        else toast({ request: "部門長に完了の承認を依頼しました", cancel: "依頼を取り下げました", reopen: "進行中に戻しました" }[action]);
        reload();
      }).catch(() => {});
  }));
}


// MTGを終えて戻ってきたとき：次の工程への線が「ぐいっ」と伸び、いまの工程の丸が弾む
function animateStepper(el, hint, to) {
  const next = el.querySelector(".stepper li.is-next");
  const curDot = el.querySelector(".stepper li.is-current .dot");
  next?.scrollIntoView?.({ block: "nearest", inline: "center" });
  setTimeout(() => {
    if (next) next.style.setProperty("--fill", to.toFixed(3));
    curDot?.classList.add("is-pulse");
    toast(hint.gained ? `このMTGで ${hint.gained}項目 進みました！${hint.next ? `（${hint.next}）` : ""}` : `MTGを終えました。おつかれさまでした${hint.next ? `（${hint.next}）` : ""}`);
  }, 500);
}

// 「どうやって選ばれたか」：PJ決めの開票（ランク付け投票）で、何位に、どんなラウンドを経て選ばれたか
function bindOrigin(el) {
  const box = el.querySelector(".pj-origin");
  if (!box) return;
  box.addEventListener("toggle", async () => {
    if (!box.open || box.dataset.loaded) return;
    box.dataset.loaded = "1";
    const body = box.querySelector(".pj-origin-body");
    const seedId = Number(box.dataset.originSeed);
    try {
      // 1位から順に決めるので、数を多めにして、このPJの種が何位で選ばれたかを探す
      const r = await api(`/api/rounds/${box.dataset.originRound}/results?seats=10`);
      const seedOf = Object.fromEntries(r.seeds.map((x) => [x.id, x]));
      const title = (id) => `${seedOf[id]?.icon || ""} ${seedOf[id]?.title || ""}`;
      const i = r.winners.findIndex((w) => w.winner === seedId);
      body.innerHTML = i < 0
        ? `<p class="small">開票の上位ではありませんでしたが、管理者がこの種を選んで正式なPJにしました（投票者 ${r.ballots}人）。</p>`
        : `<p class="small"><strong>${i + 1}位</strong>で選ばれました（投票者 ${r.ballots}人）。
            ランク付け投票で、第1希望の票が少ない種から順に外し、その票を次の希望へ移して数え直しました。${i ? `${i}位までに選ばれた種を除いて、もう一度数えています。` : ""}</p>
           ${roundsTable(r.winners[i].rounds, title, { highlight: seedId, hideZero: true })}`;
    } catch (e) {
      body.innerHTML = `<p class="muted small">${esc(e.message)}</p>`;
    }
  });
}
