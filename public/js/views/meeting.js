// 議事録：前回の宿題（自動引き継ぎ）／話し合うこと／概要／キーワード／次回までにやること
// 詳細なフィードバックはGoogleドキュメントに残す運用なので、入力欄は短くしている
import { api, esc, state, fmtDateTime, fmtDate, busy, toast, memberOptions, dueBadge, addDays, embedUrl, membersFirst, copyForNotion, copyButton, bindCopyButtons, hashQuery, timerHtml, bindTimer, clearTimer, syncTimerStart, confirmDialog, guardPending, putUnsent, settleUnsent, restoreUnsent, setSaveAlert, saveAlertText, reportSaveTrouble, celebrateProgress, setProgressHint, skipButton, bindSkipButtons, assigneePicker, idsOf, forgetUnsaved, confirmTaskDone, doneEffect } from "../lib.js";
import { enhanceRich } from "../rich.js";
import { schedulePollLinks } from "./schedule-poll.js";
import { ico, iconText } from "../icons.js";

export async function renderMeeting(el, id) {
  const data = await api(`/api/meetings/${id}`);
  // 下書き（次回の日程・MTGの進め方の選びかけ）
  try { data.draft = JSON.parse(data.meeting.draft || "{}") || {}; } catch { data.draft = {}; }
  const { meeting: m, minute, project: p, previous, canEdit } = data;
  // 意見交換会（定例イベント）：リサーチドキュメントと、話したことのメモだけ。宿題・やること・次回の日程などは出さない
  const ex = m.kind === "exchange";
  const exHide = ex ? "hidden" : "";
  // 「議事録を見る」で開いたときは読むだけ。ただし「今回話し合うこと」はMTGの前に書いておける
  const viewOnly = hashQuery().get("mode") === "view";
  // MTG中：「MTGを始める・再開する」から開いたとき（?start=1）だけ。タイマーを動かし、MTGを始めた時刻を残し、「MTGを終える」を出す
  // PJ画面・カレンダーなどから議事録を開いたときは、確認と書き直しだけ（タイマーは動かさない）
  const inMeeting = !viewOnly && hashQuery().get("start") === "1";
  const ro = canEdit && !viewOnly ? "" : "disabled";
  const baseRo = ro;
  // 同時編集の状態。locked：ほかの人が書いている項目 → その人の名前
  // base：項目ごとに、サーバーの内容として最後に知っている値（保存のときに送り、ほかの人の内容を上書きで消さないようにする）
  // touched：項目ごとに、最後に書いた・保存した時刻（それより前に問い合わせた古い内容で、画面を上書きしないため）
  const unsentKey = `meeting:${m.id}`; // 端末への一時保存の名前（lib.js の putUnsent）
  const live = { focus: null, dirty: new Set(), chain: {}, timers: {}, locked: {}, busy: false, inflight: new Set(),
    base: { agenda: minute?.agenda || "", summary: minute?.summary || "" }, touched: {}, retries: {}, restore: new Set(),
    // サーバーにあると分かっている「次回までにやること」のタスク（消すのは、この中から一覧で外したものだけ）
    knownTodoIds: new Set(data.todos.map((t) => t.id)) };
  // key：画面の行の目印（自動保存で新しく作ったタスクの id を、どの行のものか受け取るため）
  const newKey = () => Math.random().toString(36).slice(2, 10);
  // 担当は複数人（assignee_ids）。notified：もう「担当になりました」を知らせた人
  const withIds = (t) => ({ ...t, assignee_ids: idsOf(t), notified: (t.notified_ids || "").split(",").filter(Boolean) });
  let todos = data.todos.map((t) => ({ ...withIds(t), key: newKey() }));
  const memberUsers = membersFirst(data.members);

  el.innerHTML = `
    <nav class="breadcrumb"><a href="#/projects/${p.id}">${esc(p.name)}</a> / 議事録</nav>
    ${inMeeting ? timerHtml(`meeting-${m.id}`, { bar: true }) : ""}
    <div class="page-heading left">
      <h1>${fmtDateTime(m.starts_at)} ${ex ? "の意見交換会" : "のMTG"}</h1>
      <p class="live-line small"><span id="live-viewers"></span> <span class="muted" id="live-status">${canEdit ? "自動で保存・みんなで同時に書けます" : ""}</span></p>
      <p>${minute ? `最終更新：${esc(minute.updated_by_name || "")}` : "短く、要点だけ。詳しい内容はGoogleドキュメントへ。"}</p>
      ${canEdit && !ex ? `<p class="small"><a href="#/report/${p.id}">${ico("note")} このPJの定例の進捗を書く</a></p>` : ""}
      ${ex ? `<p class="small">「${esc(p.name)}」の意見交換会です。リサーチドキュメントを見ながら、話したことをメモします。PJの議事録として残ります。</p>` : ""}
      ${viewOnly && canEdit ? `<p class="small">「今回話し合うこと」は、MTGの前に書いておけます。</p>
        <a class="button primary small" href="#/meetings/${m.id}">${ico("edit")} このMTGの議事録を書く</a>` : ""}
    </div>

    ${data.isFirst && canEdit && !viewOnly && !ex ? firstMeetingCard(data, memberUsers) : ""}

    <form class="minutes" id="minutes-form">
      <section class="card" ${exHide}>
        <div class="section-head"><h2>前回MTGで決まった宿題</h2>${previous?.homework.length ? copyButton("homework") : ""}</div>
        ${previous ? `<p class="muted small">${fmtDateTime(previous.starts_at)} のMTGの「次回までにやること」</p>
          ${previous.homework.length ? `<ul class="checklist">${previous.homework.map((t) => `
            <li><label class="check"><input type="checkbox" data-hw="${t.id}" data-title="${esc(t.title)}" ${t.status === "done" ? "checked" : ""} ${ro}>
              <span>${esc(t.title)}<small>${esc(t.assignee_name || "担当なし")}${t.due_date ? `・${fmtDate(t.due_date)}` : ""}</small></span></label>
              ${t.status !== "done" ? dueBadge(t.due_date) : ""}</li>`).join("")}</ul>`
            : `<p class="muted">前回の宿題はありません。</p>`}`
          : `<p class="muted">このPJで最初の議事録です。</p>`}
      </section>

      <section class="card" data-live="agenda" ${exHide}>
        <div class="section-head"><h2>今回話し合うこと <span class="live-badge" data-badge="agenda"></span></h2><span class="row-left">${canEdit ? `<button type="button" class="copy-btn" data-history="agenda" title="これまでに保存した内容">${ico("history")} 履歴</button>` : ""}${copyButton("agenda")}</span></div>
        <label><textarea name="agenda" data-rich rows="3" maxlength="50000" aria-label="今回話し合うこと" ${canEdit ? "" : "disabled"} placeholder="・先行事例の共有&#10;・課題の絞り込み">${esc(minute?.agenda)}</textarea>
          <small class="counter" data-for="agenda"></small></label>
      </section>

      ${memoDocSection(p)}

      <section class="card" data-live="summary">
        <div class="section-head"><h2>${ex ? "話したことのメモ" : "話し合いの概要"} <span class="live-badge" data-badge="summary"></span></h2><span class="row-left">${canEdit ? `<button type="button" class="copy-btn" data-history="summary" title="これまでに保存した内容">${ico("history")} 履歴</button>` : ""}${copyButton("summary")}</span></div>
        <label><textarea name="summary" data-rich rows="3" maxlength="50000" aria-label="${ex ? "話したことのメモ" : "話し合いの概要"}" ${ro} placeholder="${ex ? "出た意見・質問・アドバイスなど" : "決まったこと・方向性だけを数行で"}">${esc(minute?.summary)}</textarea>
          <small class="counter" data-for="summary"></small></label>
      </section>


      ${ex ? "" : checklistSection(data, ro)}

      <section class="card" data-live="todos" ${exHide}>
        <div class="section-head"><h2>次回MTGまでにやること <span class="live-badge" data-badge="todos"></span></h2>${copyButton("todos")}</div>
        <p class="muted small">保存するとPJのタスクに登録され、次回の議事録に「宿題」として引き継がれます。</p>
        <div id="todos"></div>
        ${ro ? "" : `<button type="button" class="small" id="add-todo">＋ 追加</button>`}
      </section>

      ${p.meeting_mode === "adhoc" && !ex ? nextMeetingSection(data, ro) : ""}

      <div class="form-actions sticky">
        ${canEdit || m.notion_url ? `<button type="button" id="notion-make" class="notion-btn" title="${m.notion_url ? "Notionの議事録を開く" : "Notionに議事録を作る"}">${ico("note")}<span class="hide-sm"> ${m.notion_url ? "Notionの議事録を開く" : "Notionに議事録を作る"}</span></button>` : ""}
        ${canEdit ? `<button class="${viewOnly ? "primary" : ""}" type="submit">${viewOnly ? "話すことを保存" : "保存する"}</button>` : ""}
        ${canEdit && inMeeting ? `<button class="primary" type="button" id="end-meeting">${ico("check")} MTGを終える</button>` : ""}
        ${canEdit && !viewOnly && !inMeeting ? `<a class="button primary" href="#/meetings/${m.id}?from=project&start=1" title="タイマーを動かして、MTGを始めます">${ico("play")} MTGを始める</a>` : ""}
      </div>
      <div class="card notion-setup" id="notion-setup" hidden>
        <strong>このPJのNotionページを登録</strong>
        <p class="muted small">Notionで、このPJのページ（見出し「議事録」があるページ）を開き、右上の「リンクをコピー」で取ったURLを貼ってください。1回登録すれば、次からはボタン1つで作れます。</p>
        <div class="row-left"><input id="notion-url" type="url" placeholder="https://app.notion.com/p/…" aria-label="NotionのページのURL">
          <button type="button" class="primary small" id="notion-url-save">登録して作る</button></div>
      </div>
    </form>`;

  const form = el.querySelector("#minutes-form");
  enhanceRich(form);
  // 初回のMTG：決めること（PM・MTGの進め方・次回・最初のアクション）
  if (data.isFirst && canEdit && !viewOnly && !ex) bindFirstMeeting(el, data, p);
  // このMTGを削除する（間違えて開いた・二重に始めたとき）。議事録とタスクも消える
  if (canEdit) {
    el.insertAdjacentHTML("beforeend", `<p class="danger-zone"><button type="button" class="link-btn danger" id="delete-mtg">${ico("trash")} このMTGを削除する</button></p>`);
    el.querySelector("#delete-mtg").addEventListener("click", async (e) => {
      const n = todos.filter((t) => t.id).length;
      const has = form.agenda.value.trim() || form.summary.value.trim() || n;
      if (!await confirmDialog(`${fmtDateTime(m.starts_at)} のMTGを削除しますか？${has ? `\n議事録${n ? `と、ここで作ったタスク${n}件` : ""}も消えます。30日のあいだは「確認する」→「最近削除した項目」から戻せます。` : ""}${m.kind === "regular" ? "\n定例の回なので「中止」になります。" : ""}`)) return;
      forgetUnsaved(form);
      clearTimer(`meeting-${m.id}`);
      busy(e.currentTarget, () => api(`/api/meetings/${m.id}`, { method: "DELETE", body: { with_minutes: true } }))
        .then(() => { toast("MTGを削除しました"); location.hash = `#/projects/${p.id}`; }).catch(() => {});
    });
  }
  // 下書き：次回の日程・MTGの進め方は、選ぶたびに残す（画面を移っても消えない。決まるのは「保存する」「決める」のとき）
  if (canEdit && !viewOnly) {
    let draftTimer = null;
    let draftPending = false;
    let draftTries = 0;
    const draftNow = () => {
      draftTimer = null;
      const fm = el.querySelector(".first-meeting");
      const draft = {
        next_starts_at: form.next_starts_at?.value || "", next_place: form.next_place?.value || "",
        ...(fm ? { plan: { mode: fm.querySelector("[name=fm-mode]:checked")?.value, weekdays: [...fm.querySelectorAll("[name=fm-wd]:checked")].map((c) => c.value),
          time: fm.querySelector("#fm-time")?.value, interval: Number(fm.querySelector("#fm-interval")?.value) } } : {}),
      };
      draftPending = true;
      api(`/api/meetings/${m.id}/draft`, { method: "PUT", body: { draft } }).then(() => {
        draftPending = false;
        draftTries = 0;
        const st = el.querySelector("#draft-status");
        if (st && draft.next_starts_at && !data.nextMeeting) st.textContent = "✓ 残しました。「保存する」か「MTGを終える」で決まり、メンバーに届きます。";
      }).catch(() => {
        // 送れなかったら、少し待ってやり直す（あいだに選び直していたら、その内容で送る）
        if (++draftTries <= 100) { clearTimeout(draftTimer); draftTimer = setTimeout(draftNow, Math.min(10000, 2000 * draftTries)); }
      });
    };
    const isDraftField = (t) => t.matches?.("[name=next_starts_at],[name=next_place],[name=fm-mode],[name=fm-wd],#fm-time,#fm-interval");
    const onDraft = (e) => { if (!isDraftField(e.target)) return; clearTimeout(draftTimer); draftTimer = setTimeout(draftNow, 800); };
    el.addEventListener("input", onDraft);
    el.addEventListener("change", onDraft);
    window.addEventListener("hashchange", () => { if (draftTimer) { clearTimeout(draftTimer); draftNow(); } }, { once: true });
    guardPending(form, () => Boolean(draftTimer) || draftPending, () => { if (draftTimer) { clearTimeout(draftTimer); draftNow(); } });
  }
  // 次回の日程が決められないとき：日程調整アンケート
  const spBox = el.querySelector("#sp-links");
  if (spBox) schedulePollLinks(spBox, p.id, canEdit).catch(() => {});
  if (inMeeting) bindTimer(el, `meeting-${m.id}`, { auto: true });
  const todoBox = el.querySelector("#todos");
  const defaultDue = () => (data.nextMeeting ? data.nextMeeting.starts_at.slice(0, 10) : addDays(m.starts_at.slice(0, 10), 7));

  const drawTodos = () => {
    const ro = baseRo;
    el.querySelector("#add-todo")?.toggleAttribute("disabled", Boolean(ro));
    todoBox.innerHTML = todos.length ? todos.map((t, i) => `
      <div class="todo-row" data-i="${i}">
        <input data-k="title" maxlength="120" value="${esc(t.title)}" placeholder="やること" ${ro}>
        ${assigneePicker(memberUsers, t.assignee_ids, { ro, members: data.members.map((u) => u.id) })}
        <input data-k="due_date" type="date" value="${esc(t.due_date || "")}" ${ro} aria-label="期限">
        ${t.status === "done" ? `<span class="tag">完了</span>` : ""}
        ${ro ? "" : `<button type="button" class="link-btn danger" data-rm="${i}" aria-label="削除">×</button>`}
      </div>`).join("") : `<p class="muted">まだありません。</p>`;
  };
  drawTodos();

  todoBox.addEventListener("input", (e) => {
    const row = e.target.closest("[data-i]");
    if (row && e.target.dataset.k) {
      todos[row.dataset.i][e.target.dataset.k] = e.target.value;
      todos[row.dataset.i].changed = true;
      markDirty("todos");
    }
  });
  // 担当を選んだ（複数人）
  todoBox.addEventListener("assignees", (e) => {
    const row = e.target.closest("[data-i]");
    if (!row) return;
    todos[row.dataset.i].assignee_ids = e.detail;
    todos[row.dataset.i].changed = true;
    markDirty("todos");
  });
  todoBox.addEventListener("click", (e) => {
    if (e.target.dataset.rm === undefined) return;
    todos.splice(Number(e.target.dataset.rm), 1);
    drawTodos();
    markDirty("todos");
  });
  el.querySelector("#add-todo")?.addEventListener("click", () => {
    todos.push({ key: newKey(), title: "", assignee_ids: [], notified: [], due_date: defaultDue() });
    drawTodos();
    todoBox.querySelector(".todo-row:last-child input")?.focus();
  });

  const counters = () => form.querySelectorAll(".counter").forEach((c) => {
    const f = form[c.dataset.for];
    c.textContent = `${f.value.length}/${f.maxLength}`;
  });
  form.addEventListener("input", (e) => {
    counters();
    if (["agenda", "summary"].includes(e.target.name)) markDirty(e.target.name);
  });
  counters();

  el.querySelectorAll("[data-hw]").forEach((cb) => cb.addEventListener("change", async () => {
    // 完了にするときだけ確かめる（外すときはそのまま）
    if (cb.checked && !await confirmTaskDone(cb.dataset.title)) { cb.checked = false; return; }
    if (cb.checked) doneEffect(cb);
    busy(cb, () => api(`/api/tasks/${cb.dataset.hw}`, { method: "PATCH", body: { status: cb.checked ? "done" : "todo" } }))
      .catch(() => (cb.checked = !cb.checked));
  }));

  // 工程のチェック：ここで入れると、このMTGに結び付く（PJの工程画面から議事録を開ける）
  el.querySelectorAll("[data-stage-check]").forEach((cb) => cb.addEventListener("change", async () => {
    const item = data.checklist.find((c) => c.id === Number(cb.dataset.stageCheck));
    if (cb.checked && item?.notify_leaders && !item.done_at
      && !await confirmDialog(`「${item.label}」にチェックしますか？\n部門長・副部門長にお知らせが届きます。`, { ok: "チェックして知らせる" })) {
      cb.checked = false;
      return;
    }
    busy(cb, () => api(`/api/checklist/${cb.dataset.stageCheck}`, {
      method: "PATCH", body: cb.checked ? { done: true, meeting_id: m.id } : { done: false },
    })).then(() => {
      const note = cb.closest("li").querySelector(".linked");
      if (note) note.textContent = cb.checked ? "このMTGで完了" : "";
      if (item) item.done_at = cb.checked ? Date.now() : null;
      toast(cb.checked ? "このMTGに結び付けて完了にしました" : "チェックを外しました");
    }).catch(() => (cb.checked = !cb.checked));
  }));

  // 項目ごとのコピー（編集中の内容を使う）。まとめては、Notionに自動で入るのでなし
  const sections = () => minutesSections({ previous, form, todos, memberUsers, el });
  bindCopyButtons(form, (key) => (sections()[key] || []).join("\n"));
  const copyAll = () => {
    const s = sections();
    copyForNotion([`## ${p.name} MTG ${fmtDateTime(m.starts_at)}`, "", ...s.homework, ...s.agenda, ...s.summary, ...s.todos].join("\n"));
  };

  // スキップしても書きかけの議事録が消えないよう、保存してから描き直す
  bindSkipButtons(form, () => flushAll().then(() => renderMeeting(el, id)).catch(() => {}));

  // ---------- 同時編集：自動保存と、ほかの人の書いた内容の反映 ----------
  const canWrite = (f) => canEdit && (f === "agenda" || !viewOnly);
  const fieldOf = (node) => {
    const f = node?.closest?.("[data-live]")?.dataset.live;
    return f && canWrite(f) ? f : null;
  };
  const valueOf = (f) => (f === "todos"
    ? { todos: todos.map(({ key, id, title, assignee_ids, due_date, changed }) => ({ key, id, title, assignee_ids, due_date, changed: !id || Boolean(changed) })),
      known_ids: [...live.knownTodoIds] }
    : { [f]: form[f].value });
  const FIELD_LABEL = { agenda: "今回話し合うこと", summary: "話し合いの概要", todos: "次回までにやること" };
  const status = (text) => { const x = el.querySelector("#live-status"); if (x) { x.textContent = text; x.classList.toggle("save-warn", text.startsWith("⚠")); } };

  function markDirty(f) {
    if (!canWrite(f)) return;
    live.dirty.add(f);
    live.touched[f] = Date.now();
    if (f !== "todos") putUnsent(unsentKey, { [f]: form[f].value }, { [f]: live.base[f] });
    status("入力中…");
    clearTimeout(live.timers[f]);
    live.timers[f] = setTimeout(() => saveField(f).catch(() => {}), 1000);
  }
  // 1項目ずつ、順番に保存する（前の保存が終わってから次を送る）
  function saveField(f, { keepalive = false } = {}) {
    clearTimeout(live.timers[f]);
    // 前の保存が失敗していても、次の保存は必ず送る（失敗したままつなぐと、それ以降の保存がすべて止まってしまう）
    live.chain[f] = (live.chain[f] || Promise.resolve()).catch(() => {}).then(async () => {
      if (!live.dirty.has(f)) return;
      live.dirty.delete(f);
      live.inflight.add(f);
      try {
        const sent = valueOf(f);
        const body = f === "todos" ? sent : { ...sent, base: { [f]: live.base[f] }, restore: live.restore.delete(f) || undefined };
        const rowSig = (t) => JSON.stringify([t.title, t.assignee_ids, t.due_date]);
        const sentRows = f === "todos" ? new Map(sent.todos.map((t) => [t.key, rowSig(t)])) : null;
        const res = await api(`/api/meetings/${m.id}/minutes`, { method: "PUT", body, keepalive });
        live.touched[f] = Date.now();
        if (live.retries[f] >= 2) reportSaveTrouble(`MTGの議事録（${FIELD_LABEL[f]}）が一時的に保存できず、${live.retries[f]}回やり直して保存できました`);
        if (live.retries[f]) { live.retries[f] = 0; if (!form.isConnected) toast("✓ MTGの議事録を保存できました"); }
        if (!Object.values(live.retries).some((n) => n > 0)) setSaveAlert(alertId, null);
        if (f !== "todos") {
          const saved = res.merged?.[f] ?? sent[f];
          if (form[f].value === sent[f]) {
            live.base[f] = saved;
            // ほかの人の内容と合わせた：書き足していなければ画面にも映す
            if (res.merged?.[f] !== undefined) { form[f].value = saved; flash(f); }
          } else {
            // 送ったあとにも書き足している：合わせた分は次の保存でもう一度合わさるよう、送った内容を基準にしておく
            live.base[f] = sent[f];
          }
          if (res.merged?.[f] !== undefined) toast("ほかの人が同じ欄を書き換えていたので、両方の内容を残しました");
          // 端末の一時保存：保存できた内容と同じなら外す（書き足していれば残す）
          settleUnsent(unsentKey, f, [saved, sent[f]]);
        } else {
          // 消したタスクは、もうサーバーにない。送ったときから変えていない行は「書き換えた」の印を外す
          const sentIds = new Set(sent.todos.map((t) => t.id).filter(Boolean));
          for (const id of sent.known_ids) if (!sentIds.has(id)) live.knownTodoIds.delete(id);
          for (const t of todos) if (sentRows.get(t.key) === rowSig(t)) t.changed = false;
        }
        // 新しく作ったタスクは、知っているものに入れる
        for (const [key, tid] of Object.entries(res.ids || {})) {
          const t = todos.find((x) => x.key === key);
          if (t) t.id = tid;
          live.knownTodoIds.add(tid);
        }
        // ほかの欄がまだ保存できていないときは「保存しました」と出さない（1つの表示をみんなで使っているので、失敗が隠れないように）
        const failing = Object.keys(live.retries).filter((x) => live.retries[x] > 0);
        status(failing.length
          ? `⚠ 「${failing.map((x) => ({ agenda: "今回話し合うこと", summary: "話し合いの概要", todos: "次回までにやること" })[x]).join("・")}」がまだ保存できていません。自動でやり直しています…`
          : `✓ 自動で保存しました（${new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}）`);
      } catch (err) {
        live.dirty.add(f);
        // 保存できるまで、少し待って自動でやり直す（画面を移っても続ける）
        live.retries[f] = (live.retries[f] || 0) + 1;
        status(`⚠ まだ保存できていません（${err.message}）。自動でやり直しています…`);
        setSaveAlert(alertId, saveAlertText(`MTGの議事録（${FIELD_LABEL[f]}）`, err));
        if (live.retries[f] <= 200) live.timers[f] = setTimeout(() => saveField(f).catch(() => {}), Math.min(10000, 2000 * live.retries[f]));
        throw err;
      } finally {
        live.inflight.delete(f);
      }
    });
    return live.chain[f];
  }
  const alertId = `meeting-${m.id}`;
  const flushAll = (opts) => Promise.all(["agenda", "summary", "todos"].map((f) => saveField(f, opts)));
  // ほかの画面へ移るとき：書きかけをすぐ保存する（保存は画面を移っても続く。失敗したら知らせる）
  const pending = () => live.dirty.size > 0 || live.inflight.size > 0;
  window.addEventListener("hashchange", () => { if (live.dirty.size) flushAll().catch(() => {}); }, { once: true });
  // アプリを切り替える・画面を閉じるときは、ページが閉じても送り切るようにして保存する
  document.addEventListener("visibilitychange", () => { if (document.hidden && form.isConnected && live.dirty.size) flushAll({ keepalive: true }).catch(() => {}); });
  window.addEventListener("pagehide", () => { if (form.isConnected && live.dirty.size) flushAll({ keepalive: true }).catch(() => {}); });
  // タブを閉じる・再読み込みするときは、保存が終わっていなければ確かめる
  const onUnload = (e) => {
    if (!form.isConnected) { window.removeEventListener("beforeunload", onUnload); return; }
    if (!pending()) return;
    flushAll({ keepalive: true }).catch(() => {});
    e.preventDefault();
    e.returnValue = "";
  };
  window.addEventListener("beforeunload", onUnload);
  // ほかの画面へ移るときは、保存が終わるのを待つ（app.js。保存できなければ確かめる）
  guardPending(form, pending, flushAll);
  // 前に送れなかった書きかけ（端末に置いてあるもの）があれば戻して、保存する
  {
    const restored = canEdit ? restoreUnsent(unsentKey, Object.fromEntries(["agenda", "summary"].filter(canWrite).map((f) => [f, form[f]]))) : [];
    if (restored.length) {
      for (const f of restored) markDirty(f);
      toast("前に保存できていなかった書きかけを戻しました");
    }
  }
  // 電波が戻ったら、すぐ送り直す
  window.addEventListener("online", () => { if (live.dirty.size) flushAll().catch(() => {}); });

  // 🕘 履歴：今回話し合うこと・概要の、これまでに保存した内容を見て戻す
  el.querySelectorAll("[data-history]").forEach((b) => b.addEventListener("click", () => openHistory(b.dataset.history)));
  async function openHistory(f) {
    const { revisions } = await api(`/api/meetings/${m.id}/revisions?field=${f}`);
    const back = document.createElement("div");
    back.className = "dialog-backdrop";
    const label = f === "summary" ? "話し合いの概要" : "今回話し合うこと";
    back.innerHTML = `<div class="dialog history-dialog" role="dialog" aria-modal="true" aria-label="${label}の履歴">
      <h3>${ico("history")} ${label}の履歴</h3>
      <p class="muted small">これまでに保存した内容です（新しい順）。「この内容に戻す」を押すと、今の内容も履歴に残したまま戻します。</p>
      <div class="history-list">${revisions.length ? revisions.map((r) => `
        <div class="history-item"><div class="history-meta"><strong>${esc(new Date(r.updated_at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }))}</strong> ${esc(r.name || "")}</div>
          <pre class="history-body">${esc(r.body)}</pre>
          ${canWrite(f) ? `<button type="button" class="small" data-restore="${r.id}">この内容に戻す</button>` : ""}</div>`).join("") : `<p class="muted">まだ履歴はありません。</p>`}</div>
      <div class="form-actions"><button type="button" data-close>閉じる</button></div></div>`;
    const close = () => back.remove();
    back.addEventListener("click", (e) => { if (e.target === back || e.target.closest("[data-close]")) close(); });
    back.querySelectorAll("[data-restore]").forEach((rb) => rb.addEventListener("click", () => {
      const r = revisions.find((x) => String(x.id) === rb.dataset.restore);
      form[f].value = r.body;
      live.restore.add(f);
      markDirty(f);
      saveField(f).catch(() => {});
      close();
      flash(f);
      toast("履歴の内容に戻しました（戻す前の内容も履歴に残っています）");
    }));
    document.body.append(back);
  }

  // 自分が書いている・保存待ち・保存中の項目は、ほかの人の内容で上書きしない
  const mine = (f) => live.focus === f || live.dirty.has(f) || live.inflight.has(f);
  const sameTodos = (a, b) => JSON.stringify(a.map((t) => [t.id, t.title, (t.assignee_ids || []).join(","), t.due_date || "", t.status || ""]))
    === JSON.stringify(b.map((t) => [t.id, t.title, (t.assignee_ids || []).join(","), t.due_date || "", t.status || ""]));
  const flash = (f) => {
    const sec = form.querySelector(`[data-live="${f}"]`);
    sec?.classList.remove("live-updated");
    void sec?.offsetWidth;
    sec?.classList.add("live-updated");
  };

  function apply(r, askedAt = 0) {
    live.locked = Object.fromEntries(r.editors.map((e) => [e.field, e.name || "ほかの人"]));
    for (const f of ["agenda", "summary"]) {
      const v = r.minute?.[f] ?? "";
      // 問い合わせたあとに自分が書いた・保存した項目は、古い内容なので映さない
      const stale = (live.touched[f] || 0) >= askedAt;
      if (!mine(f) && !stale) {
        live.base[f] = v;
        if (form[f].value !== v) { form[f].value = v; flash(f); }
      }
      if (canWrite(f)) form[f].readOnly = false; // 文章の欄はロックしない（同時に書いたら両方残す）
    }
    // 問い合わせたあとに自分が書いた・保存した「やること」は、古い内容なので映さない
    if (!mine("todos") && (live.touched.todos || 0) < askedAt) {
      live.knownTodoIds = new Set(r.todos.map((t) => t.id));
      const next = r.todos.map((t) => ({ ...withIds(t), key: todos.find((x) => x.id === t.id)?.key || newKey() }));
      const drafts = todos.filter((t) => !t.id && !t.title.trim());
      if (!sameTodos(next, todos.filter((t) => t.id || t.title.trim()))) {
        todos = [...next, ...drafts];
        drawTodos();
        flash("todos");
      }
    }
    for (const h of r.homework) {
      const cb = el.querySelector(`[data-hw="${h.id}"]`);
      if (cb && !cb.disabled) cb.checked = h.status === "done";
    }
    el.querySelectorAll("[data-badge]").forEach((b) => {
      const who = live.locked[b.dataset.badge];
      b.innerHTML = who ? `${ico("edit")} ${esc(who)}さんも書いています（両方残ります）` : "";
    });
    const v = el.querySelector("#live-viewers");
    if (v) v.innerHTML = r.viewers.length ? `${ico("users")} ${esc(r.viewers.join("、"))}さんも開いています` : "";
    counters();
  }

  async function beat() {
    if (live.busy) return;
    live.busy = true;
    try {
      const askedAt = Date.now();
      const r = await api(`/api/meetings/${m.id}/live`, { method: "POST", body: { field: live.focus, start: inMeeting && !live.started } });
      if (r.started_at && inMeeting) {
        live.started = true;
        syncTimerStart(`meeting-${m.id}`, r.started_at);
      }
      apply(r, askedAt);
    } catch { /* 通信が途切れても、次の合図でやり直す */ } finally {
      live.busy = false;
    }
  }
  // 書きはじめた項目を押さえる。ほかの人が書いている項目には入らない
  form.addEventListener("focusin", (e) => {
    const f = fieldOf(e.target);
    if (!f || f === live.focus) return;
    live.focus = f;
    beat();
  });
  form.addEventListener("focusout", () => setTimeout(() => {
    const f = fieldOf(document.activeElement);
    if (f === live.focus) return;
    const left = live.focus;
    live.focus = f;
    (left ? saveField(left) : Promise.resolve()).catch(() => {}).finally(beat);
  }, 200));
  const LIVE_MS = 4000;
  const tick = setInterval(() => {
    if (!document.body.contains(form)) clearInterval(tick);
    else if (!document.hidden) beat();
  }, LIVE_MS);
  beat();

  // 保存ボタン・MTGを終える：自動保存の残りを送ってから、次回の日程（毎回決めるPJ）を送る
  const save = async () => {
    await flushAll();
    return api(`/api/meetings/${m.id}/minutes`, {
      method: "PUT",
      // 毎回決めるPJ：次回の日程（任意）。入っていれば一緒に登録する。「議事録を見る」から保存するときは触れない
      // notify_todos：まだ知らせていない「次回までにやること」の担当に、ここでまとめて知らせる
      body: { next_meeting: !viewOnly && form.next_starts_at?.value ? { starts_at: form.next_starts_at.value, place: form.next_place.value } : undefined, notify_todos: !viewOnly, notion: true },
    });
  };
  // 保存すると届くお知らせ（確認画面に出す）
  const nameOfUser = (uid) => memberUsers.find((u) => u.id === uid)?.name || state.users.find((u) => u.id === uid)?.name || "";
  const pendingNotices = () => {
    if (viewOnly) return [];
    const lines = todos.filter((t) => t.title.trim()).flatMap((t) => (t.assignee_ids || []).filter((uid) => !(t.notified || []).includes(uid))
      .map((uid) => `・${nameOfUser(uid)}さん：「${t.title.trim()}」の担当になったこと`));
    const next = form.next_starts_at?.value;
    if (next && next !== (data.nextMeeting?.starts_at || "")) lines.push(`・PJメンバー：次回MTGの日程（${fmtDateTime(next)}）`);
    return lines;
  };
  const noticeText = (lines) => (lines.length ? `\n\n次のお知らせが届きます：\n${lines.join("\n")}` : "");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = e.submitter;
    const lines = pendingNotices();
    if (lines.length && !await confirmDialog(`議事録を保存しますか？${noticeText(lines)}`, { ok: "保存して知らせる" })) return;
    busy(button, async () => {
      const res = await save();
      toast(viewOnly ? "話すことを保存しました" : res.nextMeeting ? `議事録と次回の日程（${fmtDateTime(res.nextMeeting)}）を保存しました` : "議事録を保存しました");
      if (res.notion) setTimeout(() => toast(m.notion_url ? "Notionの議事録も書き直しました" : "Notionの「議事録」にもページを作りました"), 900);
      renderMeeting(el, id);
    }).catch(() => {});
  });

  // MTGを終える：議事録を保存して、タイマーを止め、始めた画面へ戻る（あとから「前回の続き（再開）」で開き直せる）
  // Notionに議事録を作る：PJのNotionページ（見出し「議事録」の下）に、この議事録を書いたページを作って開く
  const notionBtn = el.querySelector("#notion-make");
  const openNotion = (url, win) => { if (win) win.location.href = url; else window.open(url, "_blank", "noopener"); };
  const makeNotion = async (button) => {
    if (m.notion_url) return openNotion(m.notion_url);
    if (!data.notion) {
      // 連携がまだのときは、コピーしてPJのNotionページを開く（貼り付けるだけ）
      copyAll();
      if (p.notion_url) openNotion(p.notion_url);
      setTimeout(() => toast("Notion用にコピーしました。Notionの「議事録」の下に新しいページを作って、貼り付けてください"), 700);
      return;
    }
    if (!p.notion_url) {
      el.querySelector("#notion-setup").hidden = false;
      el.querySelector("#notion-url").focus();
      return;
    }
    if (!await confirmDialog(`このMTGの議事録を、NotionのPJページ（見出し「議事録」の下）に新しいページとして作りますか？\n今回話し合うこと・概要・次回までにやることが、そのまま入ります。`, { ok: "Notionに作る" })) return;
    const win = window.open("about:blank", "_blank"); // あとで開くと止められることがあるので、先に開いておく
    try {
      await flushAll();
      const res = await busy(button, () => api(`/api/meetings/${m.id}/notion`, { method: "POST", body: {} }));
      m.notion_url = res.url;
      button.innerHTML = `${ico("note")}<span class="hide-sm"> Notionの議事録を開く</span>`;
      toast(res.existed ? "Notionの議事録を開きます" : "Notionに議事録を作りました");
      openNotion(res.url, win);
    } catch (err) {
      win?.close();
    }
  };
  notionBtn?.addEventListener("click", (e) => makeNotion(e.currentTarget));
  el.querySelector("#notion-url-save")?.addEventListener("click", (e) => {
    const url = el.querySelector("#notion-url").value.trim();
    busy(e.currentTarget, () => api(`/api/projects/${p.id}/notion`, { method: "POST", body: { url } }))
      .then(() => { p.notion_url = url; el.querySelector("#notion-setup").hidden = true; makeNotion(notionBtn); }).catch(() => {});
  });

  el.querySelector("#end-meeting")?.addEventListener("click", async (e) => {
    const b = e.currentTarget;
    if (!await confirmDialog(`MTGを終えますか？\n議事録を保存して、タイマーを止めます。${noticeText(pendingNotices())}`, { ok: "MTGを終える" })) return;
    busy(b, async () => {
      const res = await save();
      clearTimer(`meeting-${m.id}`);
      // 意見交換会：PJの記録に残ったことを知らせて、そのPJの記録へ
      if (ex) {
        toast("意見交換会を終えました。議事録はPJの記録に入りました");
        location.hash = `#/projects/${p.id}?tab=records`;
        return;
      }
      // このMTGでどれだけ進んだか：PJ全体の工程のチェックのうち、このMTGで済んだ分を「前 → 後」で見せる
      const pj = await api(`/api/projects/${p.id}`).catch(() => null);
      const items = (pj?.checklist || []).filter((c) => c.stage_no > 0 && !c.skipped_at);
      const doneNow = items.filter((c) => c.done_at);
      const doneHere = doneNow.filter((c) => c.meeting_id === m.id);
      const next = res.nextMeeting ? `次回は ${fmtDateTime(res.nextMeeting)}` : "";
      const from = hashQuery().get("from");
      const toProject = from !== "home" && from !== "calendar";
      if (toProject && pj) {
        // PJ画面の数直線で、いまの工程の進み具合を「前 → 後」に伸ばして見せる
        const cur = items.filter((c) => c.stage_no === pj.project.current_stage);
        const doneCur = cur.filter((c) => c.done_at).length;
        const hereCur = cur.filter((c) => c.done_at && c.meeting_id === m.id).length;
        setProgressHint({ projectId: p.id, from: cur.length ? (doneCur - hereCur) / cur.length : 0, gained: doneHere.length, next });
      } else if (items.length) {
        await celebrateProgress({
          title: doneHere.length ? `このMTGで ${doneHere.length}項目 進みました！` : "MTGを終えました。おつかれさまでした",
          sub: [state.types[p.type]?.stages.find((s) => s.no === pj.project.current_stage)?.name ? `いまの工程：${state.types[p.type].stages.find((s) => s.no === pj.project.current_stage).name}` : "", next].filter(Boolean).join("・"),
          from: doneNow.length - doneHere.length, to: doneNow.length, total: items.length,
          items: doneHere.map((c) => c.label),
        });
      } else {
        toast(next ? `MTGを終えました。${next}です` : "MTGを終えました。おつかれさまでした");
      }
      // 始めた画面へ戻る（ホームから始めたらホーム、カレンダーからならカレンダー、それ以外はPJ画面）
      location.hash = from === "home" ? "#/" : from === "calendar" ? "#/calendar" : `#/projects/${p.id}`;
    }).catch(() => {});
  });
}

// 毎回決めるPJ：議事録の最後に次回の日程を決める（任意。未定のままなら翌朝からリマインドが届く）
function nextMeetingSection({ nextMeeting, meeting: m, draft }, ro) {
  return `
    <section class="card next-date">
      <h2>${ico("calendar")} 次回のミーティング日程 <small class="muted">任意</small></h2>
      <p class="muted small">${nextMeeting
        ? `次回は <strong>${fmtDateTime(nextMeeting.starts_at)}</strong> に決まっています。変える場合は日時を直して保存してください。`
        : "MTGの最後に決めましょう。未定のままだと、翌朝からPJメンバーにリマインドが届きます。"}</p>
      <div class="inline-form">
        <input name="next_starts_at" type="datetime-local" min="${esc(m.starts_at)}" value="${esc(nextMeeting?.starts_at || draft.next_starts_at || "")}" aria-label="次回の日時" ${ro}>
        <input name="next_place" maxlength="200" placeholder="場所・URL（任意）" value="${esc(nextMeeting?.place || draft.next_place || m.place || "")}" ${ro}>
      </div>
      <p class="muted small" id="draft-status">${!nextMeeting && draft.next_starts_at ? "前に選んだ日時を残してあります。「保存する」か「MTGを終える」で決まり、メンバーに届きます。" : ""}</p>
      ${nextMeeting ? "" : `<div class="sp-links" id="sp-links"></div>`}
    </section>`;
}

// 議事録の各項目を、Notionに貼ると見出し・箇条書き・チェックボックスになるMarkdownにする（項目ごとにコピーできるよう分けておく）
function minutesSections({ previous, form, todos, memberUsers, el }) {
  const nameOf = (id) => memberUsers.find((u) => u.id === id)?.name || "担当未定";
  const block = (title, text) => [`### ${title}`,
    ...(text.trim() ? text.replace(/\s+$/, "").split("\n").filter((l) => l.trim()).map((l) => l.replace(/^(\s*)・\s*/, "$1- ")) : ["（なし）"]), ""];
  const valid = todos.filter((t) => t.title.trim());
  return {
    homework: previous?.homework.length ? ["### 前回の宿題", ...previous.homework.map((t) =>
      `- [${el.querySelector(`[data-hw="${t.id}"]`)?.checked ? "x" : " "}] ${t.title}（${t.assignee_name || "担当未定"}）`), ""] : [],
    agenda: block("今回話し合うこと", form.agenda.value),
    summary: block("概要", form.summary.value),
    todos: ["### 次回までにやること", ...(valid.length
      ? valid.map((t) => `- [ ] ${t.title}（${(t.assignee_ids || []).map(nameOf).join("・") || "担当未定"}${t.due_date ? `・${fmtDate(t.due_date)}まで` : ""}）`) : ["（なし）"])],
  };
}

function checklistSection({ checklist, meeting: m, project: p }, ro) {
  if (!checklist.length) return "";
  const stageName = (no) => state.types[p.type]?.stages.find((x) => x.no === no)?.name || "";
  return `
    <section class="card">
      <h2>工程のチェック <small class="muted">いまの工程：${esc(stageName(p.current_stage))}</small></h2>
      <details class="help-fold"><summary>${ico("info")} チェックすると？</summary><p class="small">このMTGで済んだ項目にチェックすると、このMTGの議事録に結び付きます。後からPJの「工程」画面で、どの議事録で進んだかを見られます。要らない項目は「スキップ」で飛ばせます。</p></details>
      <ul class="checklist">${checklist.map((c) => `
        <li class="${c.skipped_at ? "is-skipped" : ""}"><label class="check"><input type="checkbox" data-stage-check="${c.id}" ${c.done_at ? "checked" : ""} ${ro || (c.skipped_at ? "disabled" : "")}>
          <span>${c.stage_no !== p.current_stage ? `<span class="tag">工程${c.stage_no}</span> ` : ""}${esc(c.label)}${c.hint ? `<small>${esc(c.hint)}</small>` : ""}</span></label>
          <span class="muted small linked">${!c.done_at ? "" : c.meeting_id === m.id ? "このMTGで完了"
            : c.meeting_id ? `<a href="#/meetings/${c.meeting_id}">${fmtDateTime(c.meeting_starts_at)} のMTGで完了</a>` : "完了"}${c.skipped_at ? "スキップ" : ""}</span>
          ${skipButton(c, ro)}</li>`).join("")}
      </ul>
    </section>`;
}

// PJのリサーチドキュメント（調べたことをメンバーがタブを分けて書くGoogleドキュメント）。MTG中に見ながら議事録を書く
function memoDocSection(p) {
  const embed = embedUrl(p.memo_doc_url);
  return `
    <section class="card memo-doc">
      <div class="section-head"><h2>${ico("search")} リサーチドキュメント</h2>
        ${p.memo_doc_url ? `<a class="button small" href="${esc(p.memo_doc_url)}" target="_blank" rel="noopener">新しいタブで開く</a>` : ""}</div>
      ${embed ? `<div class="doc-frame"><iframe src="${esc(embed)}" title="リサーチドキュメント" loading="lazy"></iframe></div>
        <p class="muted small">表示されないときは、ドキュメントの共有設定を確認するか「新しいタブで開く」を使ってください。書き込みやコメントは「新しいタブで開く」から。</p>`
        : p.memo_doc_url ? `<p class="muted small">このリンクは埋め込み表示できません。「新しいタブで開く」から開いてください。</p>`
        : `<p class="muted small">リサーチドキュメントが未登録です。<a href="#/projects/${p.id}/edit">PJの「編集」</a>から登録すると、ここに表示されます。</p>`}
    </section>`;
}

// ---------- 初回MTGで決めること ----------
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
function firstMeetingCard(data, memberUsers) {
  const p = data.project;
  // まだ決めていなければ、前に選びかけていたものを出す
  const plan = !p.plan_decided && p.meeting_mode !== "regular" && data.draft.plan ? data.draft.plan : null;
  const wd = new Set(plan ? plan.weekdays : (p.meeting_weekdays || "").split(",").filter(Boolean));
  const regular = plan ? plan.mode === "regular" : p.meeting_mode === "regular";
  const step = (n, key, title, body) => `
    <li class="fm-step" data-step="${key}"><span class="fm-no">${n}</span>
      <div class="fm-body"><strong>${iconText(title)}</strong>${body}</div><span class="fm-done" aria-label="決まった">✓</span></li>`;
  return `<section class="card first-meeting">
    <div class="section-head"><h2>${ico("flag")} 初回MTGで決めること <small class="muted">この5つを決めれば、PJがスタートできます</small></h2></div>
    <ol class="fm-steps">
      ${step(1, "pm", "👑 PM（まとめ役）を決める", `
        <div class="row-left"><select id="pm-select" aria-label="PM"><option value="">まだ決めていない</option>
          ${memberUsers.map((u) => `<option value="${esc(u.id)}" ${u.id === p.pm_id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>
          <button type="button" class="primary small" id="pm-save">決める</button></div>`)}
      ${step(2, "plan", "🗓 MTGの進め方を決める", `
        <div class="row-left fm-modes">
          <label class="chip-check"><input type="radio" name="fm-mode" value="regular" ${regular ? "checked" : ""}><span>定例にする（毎週同じ曜日・時刻）</span></label>
          <label class="chip-check"><input type="radio" name="fm-mode" value="adhoc" ${regular ? "" : "checked"}><span>毎回、次の日程を決める</span></label>
        </div>
        <div class="fm-regular" ${regular ? "" : "hidden"}>
          <div class="row-left">${WEEKDAYS.map((w, i) => `<label class="chip-check"><input type="checkbox" name="fm-wd" value="${i}" ${wd.has(String(i)) ? "checked" : ""}><span>${w}</span></label>`).join("")}</div>
          <div class="row-left"><input type="time" id="fm-time" value="${esc(plan?.time || p.meeting_time || "21:00")}" aria-label="時刻">
            <select id="fm-interval" aria-label="頻度"><option value="1">毎週</option><option value="2" ${(plan ? plan.interval : p.meeting_interval) === 2 ? "selected" : ""}>隔週</option></select></div>
        </div>
        <button type="button" class="primary small" id="fm-plan-save">決める</button>`)}
      ${step(3, "next", "📅 次回のMTGを決める", `
        <p class="small muted fm-next-note"></p>
        <button type="button" class="small" id="fm-go-next">次回の日程を書く ↓</button>`)}
      ${step(4, "action", "🚀 最初のアクションを決める", `
        <p class="small muted">誰が・何を・いつまでに。「次回までにやること」に書くと、担当の人のタスクになります。</p>
        <button type="button" class="small" id="fm-go-todo">最初のアクションを書く ↓</button>`)}
      ${step(5, "doc", "📄 リサーチドキュメントを追加する", `
        <p class="small muted">調べたことをメンバーがタブを分けて書く、Googleドキュメントを1つ作ります。作ったら「共有」で「リンクを知っている全員が編集可」にして、リンクを貼ってください。議事録の下にいつでも表示されます。</p>
        <div class="row-left"><a class="button small" href="https://docs.google.com/document/create" target="_blank" rel="noopener">＋ Googleドキュメントを作る</a></div>
        <div class="row-left"><input type="url" id="fm-doc-url" placeholder="https://docs.google.com/document/d/…" value="${esc(p.memo_doc_url || "")}" aria-label="リサーチドキュメントのURL">
          <button type="button" class="primary small" id="fm-doc-save">登録する</button></div>`)}
    </ol>
  </section>`;
}

function bindFirstMeeting(el, data, p) {
  const card = el.querySelector(".first-meeting");
  const mark = (key, done) => card.querySelector(`[data-step="${key}"]`)?.classList.toggle("is-done", Boolean(done));
  const refresh = () => {
    mark("pm", p.pm_id);
    mark("plan", p.plan_decided || p.meeting_mode === "regular");
    const regular = p.meeting_mode === "regular";
    const nextVal = el.querySelector("[name=next_starts_at]")?.value;
    card.querySelector(".fm-next-note").textContent = regular ? "定例なので、次回は自動でカレンダーに入ります。"
      : nextVal ? `次回：${nextVal.replace("T", " ")}` : "毎回決める場合は、MTGの最後に次回の日時を書きます。";
    card.querySelector("#fm-go-next").hidden = regular;
    mark("next", regular || nextVal);
    mark("action", [...el.querySelectorAll("#todos [data-k=title]")].some((i) => i.value.trim()));
    mark("doc", p.memo_doc_url);
  };
  // ⑤ リサーチドキュメント：登録したら、議事録の下の表示も入れ替える
  card.querySelector("#fm-doc-save").addEventListener("click", (e) => {
    const url = card.querySelector("#fm-doc-url").value.trim();
    busy(e.currentTarget, () => api(`/api/projects/${p.id}/research-doc`, { method: "POST", body: { url } }))
      .then((res) => {
        p.memo_doc_url = res.url;
        el.querySelector(".memo-doc")?.insertAdjacentHTML("afterend", memoDocSection(p));
        el.querySelector(".memo-doc")?.remove();
        toast(res.url ? "リサーチドキュメントを登録しました" : "リサーチドキュメントの登録を外しました");
        refresh();
      }).catch(() => {});
  });
  // ① PM（選んだらすぐ決まる。「決める」を押してもいい）
  card.querySelector("#pm-select").addEventListener("change", () => card.querySelector("#pm-save").click());
  card.querySelector("#pm-save").addEventListener("click", (e) => {
    const sel = card.querySelector("#pm-select");
    const name = sel.selectedOptions[0]?.textContent || "";
    busy(e.currentTarget, () => api(`/api/projects/${p.id}/pm`, { method: "POST", body: { user_id: sel.value || null } }))
      .then(() => { p.pm_id = sel.value || null; toast(sel.value ? `${name}さんをPMにしました` : "PMを未定に戻しました"); refresh(); }).catch(() => {});
  });
  // ② MTGの進め方
  card.querySelectorAll("[name=fm-mode]").forEach((r) => r.addEventListener("change", () => {
    card.querySelector(".fm-regular").hidden = card.querySelector("[name=fm-mode]:checked").value !== "regular";
  }));
  card.querySelector("#fm-plan-save").addEventListener("click", (e) => {
    const mode = card.querySelector("[name=fm-mode]:checked").value;
    const body = { meeting_mode: mode, meeting_weekdays: [...card.querySelectorAll("[name=fm-wd]:checked")].map((c) => c.value),
      meeting_time: card.querySelector("#fm-time").value, meeting_interval: Number(card.querySelector("#fm-interval").value) };
    busy(e.currentTarget, () => api(`/api/projects/${p.id}/meeting-plan`, { method: "POST", body }))
      .then(() => {
        Object.assign(p, { meeting_mode: mode, plan_decided: true });
        toast(mode === "regular" ? `定例を決めました（${body.meeting_weekdays.map((i) => WEEKDAYS[i]).join("・")}曜 ${body.meeting_time}）` : "毎回、次の日程を決めることにしました");
        refresh();
      }).catch(() => {});
  });
  // ③④ 下の欄へ
  const goTo = (sel, focus) => { const t = el.querySelector(sel); t?.scrollIntoView({ behavior: "smooth", block: "center" }); setTimeout(() => focus?.(), 400); };
  card.querySelector("#fm-go-next").addEventListener("click", () => goTo(".next-date", () => el.querySelector("[name=next_starts_at]")?.focus()));
  card.querySelector("#fm-go-todo").addEventListener("click", () => goTo("#todos", () => {
    const inputs = el.querySelectorAll("#todos [data-k=title]");
    if (!inputs.length) el.querySelector("#add-todo")?.click();
    [...el.querySelectorAll("#todos [data-k=title]")].find((i) => !i.value.trim())?.focus() || el.querySelector("#todos [data-k=title]")?.focus();
  }));
  el.addEventListener("input", refresh);
  el.addEventListener("change", refresh);
  refresh();
}
