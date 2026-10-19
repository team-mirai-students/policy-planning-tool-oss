// 外部ヒアリングの申請：一覧（全員が見られる）／申請フォーム（必須は「誰に」「何のために」だけ）／詳細と承認
import { api, esc, state, avatar, fmtDate, busy, toast, formData, hashQuery, jstDateTime, copyButton, bindCopyButtons, confirmDialog, guardForm, markSaved, replaceHash } from "../lib.js";

const STEPS = [["pending", "申請中"], ["head_ok", "部門長確認済"], ["rep_ok", "代表確認済・スレッド作成"], ["done", "実施済"]];
const STATUS_CLASS = { pending: "is-soon", head_ok: "is-soon", returned: "is-over", rep_ok: "", done: "", recorded: "", withdrawn: "" };
const RULES = `
  <div class="notice">
    学生チーム外の人にヒアリングするときは、ここから申請します。相手の種類によって、事前確認（部門長 → 代表）が必要かどうかが決まります。
    <strong>相手の連絡先（メール・電話）は書かないでください。</strong>外部とのやりとりは、承認後に作られる渉外フォーラムのスレッドで行います。
  </div>`;

function statusBadge(status, statuses) {
  return `<span class="due ${STATUS_CLASS[status] ?? ""}">${esc(statuses[status] || status)}</span>`;
}

export async function renderHearings(el) {
  const data = await api("/api/hearings");
  let filter = hashQuery().get("filter") || (data.toReview ? "review" : "all");
  let q = "";

  const draw = () => {
    const mine = (h) => h.applicant_id === state.me.id;
    const needsMe = (h) => (h.status === "pending" && state.me.isHead) || (h.status === "head_ok" && state.me.isRep);
    const list = data.hearings.filter((h) =>
      (filter === "all" ? h.status !== "withdrawn"
        : filter === "review" ? needsMe(h)
        : filter === "mine" ? mine(h)
        : filter === "active" ? ["pending", "head_ok", "rep_ok", "returned", "recorded"].includes(h.status)
        : h.status === "done")
      && (!q || `${h.target_affiliation}${h.target_name}${h.purpose}`.includes(q)));
    const tabs = [["all", "すべて"], ["active", "進行中"], ["done", "実施済"], ["mine", "自分の申請"]];
    if (state.me.isHead || state.me.isRep) tabs.unshift(["review", `確認待ち（${data.toReview}）`]);

    el.innerHTML = `
      <div class="page-heading"><h1>外部ヒアリング</h1></div>
      <div class="board-tools">
        <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${filter === k}" data-filter="${k}">${l}</button>`).join("")}</div>
        <a class="button primary" href="#/hearings/new">＋ ヒアリングを申請する</a>
      </div>
      <input type="search" id="q" placeholder="相手の所属・名前・目的で探す" value="${esc(q)}" style="margin-bottom:16px">
      ${list.length ? `<ul class="list">${list.map((h) => `
        <li class="list-item">
          <a class="hearing-row" href="#/hearings/${h.id}">
            <strong>${esc(h.target_affiliation)} ${esc(h.target_name)}さん</strong>
            <span class="muted small">${esc(h.purpose)}</span>
          </a>
          <div class="meta">
            ${statusBadge(h.status, data.statuses)}
            <span>${avatar({ name: h.applicant_name, avatar: h.applicant_avatar })} ${esc(h.applicant_name)}</span>
            ${h.project_name ? `<span class="tag">${esc(h.project_name)}</span>` : ""}
            <span class="muted">${fmtDate(jstDateTime(h.created_at))}</span>
            ${h.thread_url ? `<a href="${esc(h.thread_url)}" target="_blank" rel="noopener">スレッド</a>` : ""}
          </div>
        </li>`).join("")}</ul>` : `<div class="empty"><p>該当する申請はありません。</p></div>`}`;

    el.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => { filter = b.dataset.filter; draw(); }));
    const search = el.querySelector("#q");
    search.addEventListener("input", () => {
      q = search.value.trim();
      const pos = search.selectionStart;
      draw();
      const s2 = el.querySelector("#q");
      s2.focus();
      s2.setSelectionRange(pos, pos);
    });
  };
  draw();
}

function hearingForm(types, projects, h = {}) {
  return `
    <form class="card form" id="hearing-form">
      <fieldset>
        <legend>誰に <span class="req">必須</span></legend>
        <div class="grid-2">
          <label>所属<input name="target_affiliation" maxlength="80" required value="${esc(h.target_affiliation || "")}" placeholder="例：〇〇大学 公共政策学部"></label>
          <label>名前<input name="target_name" maxlength="40" required value="${esc(h.target_name || "")}" placeholder="例：山田太郎（敬称なし）"></label>
        </div>
        <div id="dup"></div>
      </fieldset>
      <fieldset>
        <legend>相手の種類 <span class="req">必須</span></legend>
        <div class="type-picker">
          ${Object.entries(types).map(([k, t]) => `
            <label class="chip-check"><input type="radio" name="target_type" value="${k}" required ${h.target_type === k ? "checked" : ""}>
              <span>${esc(t.label)}</span><small class="${t.approval ? "need" : "free"}">${t.approval ? "要承認" : "承認不要"}</small></label>`).join("")}
        </div>
        <p class="muted small" id="flow-note"></p>
      </fieldset>
      <label>何のために <span class="req">必須</span>
        <textarea name="purpose" maxlength="300" rows="3" required placeholder="例：地熱発電の導入が進まない理由について、自治体の立場から現場の課題を聞きたい">${esc(h.purpose || "")}</textarea>
      </label>
      <details ${h.related_issue || h.memo || h.project_id ? "open" : ""}>
        <summary class="small"><strong>任意の項目（関連する課題・PJ・メモ）</strong></summary>
        <div class="form" style="margin-top:12px">
          <label>関連するPJ<select name="project_id"><option value="">（なし）</option>
            ${projects.map((p) => `<option value="${p.id}" ${h.project_id === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
          <label>関連する課題（樹形図から）<select name="node_id" data-node-value="${esc(h.node_id || "")}"><option value="">（PJを選ぶと出ます）</option></select></label>
          <label>関連する課題（自由記述）<input name="related_issue" maxlength="120" value="${esc(h.related_issue || "")}" placeholder="例：地元の温泉事業者との合意形成"></label>
          <label>メモ<textarea name="memo" maxlength="300" rows="2">${esc(h.memo || "")}</textarea></label>
        </div>
      </details>
      <p class="muted small">文面（先方に送る文章）はここには不要です。連絡先は書かないでください。</p>
      <div class="form-actions">
        <a class="button" href="${h.id ? `#/hearings/${h.id}` : "#/hearings"}">キャンセル</a>
        <button class="primary">${h.id ? (h.status === "returned" ? "修正して再申請する" : "保存する") : "申請する"}</button>
      </div>
    </form>`;
}

function bindHearingForm(el, types, existing, h, onSubmit) {
  const form = el.querySelector("#hearing-form");
  const note = form.querySelector("#flow-note");
  const syncType = () => {
    const t = types[form.target_type.value];
    note.textContent = !t ? "" : t.approval
      ? "この相手は事前確認が必要です。部門長 → 代表の順に確認され、承認されると渉外フォーラムにスレッドが作られます。"
      : "この相手は承認不要です。申請の記録だけが残ります（承認の流れはありません）。";
  };
  // 同じ相手への申請がすでにあれば知らせる（重複連絡を防ぐ）
  const syncDup = () => {
    const a = form.target_affiliation.value.trim();
    const n = form.target_name.value.trim();
    const hits = existing.filter((x) => x.id !== h?.id && x.status !== "withdrawn"
      && ((n && x.target_name === n) || (a.length >= 3 && x.target_affiliation.includes(a))));
    form.querySelector("#dup").innerHTML = hits.length ? `<p class="caution small">同じ相手への申請があります：${hits.slice(0, 5).map((x) =>
      `<a href="#/hearings/${x.id}">${esc(x.target_affiliation)} ${esc(x.target_name)}さん（${esc(x.applicant_name)}）</a>`).join("、")}</p>` : "";
  };
  // 関連するPJを選ぶと、そのPJの樹形図のノードを選べるようにする
  const syncNodes = async () => {
    const select = form.node_id;
    const pid = form.project_id.value;
    const keep = select.value || select.dataset.nodeValue;
    select.dataset.nodeValue = "";
    if (!pid) { select.innerHTML = `<option value="">（PJを選ぶと出ます）</option>`; return; }
    const { nodes } = await api(`/api/projects/${pid}/tree`).catch(() => ({ nodes: [] }));
    select.innerHTML = `<option value="">（選ばない）</option>` + nodes.map((n) =>
      `<option value="${n.id}" ${String(n.id) === String(keep) ? "selected" : ""}>${n.kind === "issue" ? "課題" : "原因"}：${esc(n.title)}</option>`).join("");
  };
  form.project_id.addEventListener("change", syncNodes);
  syncNodes().then(() => guardForm(form));
  form.addEventListener("change", syncType);
  form.addEventListener("input", syncDup);
  syncType();
  syncDup();
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    // 送る前に「保存済み」にしておく（送ったあと別の画面へ移るため）。失敗したら書きかけに戻す
    markSaved(form);
    busy(e.submitter, () => onSubmit({ ...formData(form), version: h?.version })).catch(() => { form.dataset.saved = ""; });
    // （確認画面で「キャンセル」を押したときも、ここで書きかけに戻る）
  });
}

export async function renderHearingNew(el) {
  const [{ hearings, types }, { projects }] = await Promise.all([api("/api/hearings"), api("/api/projects")]);
  const projectId = Number(hashQuery().get("project")) || null;
  const from = projects.find((p) => p.id === projectId);
  el.innerHTML = `
    <nav class="breadcrumb">${from ? `<a href="#/projects/${from.id}">${esc(from.name)}</a>` : `<a href="#/hearings">外部ヒアリング</a>`} / ヒアリング申請</nav>
    <div class="page-heading left"><h1>ヒアリングを申請する</h1><p>必須は「誰に」と「何のために」だけです。気軽に出してください。</p></div>
    ${RULES}
    ${hearingForm(types, projects.filter((p) => p.status === "active"), { project_id: projectId })}
    <p class="muted small" style="text-align:center"><a href="#/hearings">これまでのヒアリング申請の一覧を見る</a></p>`;
  bindHearingForm(el, types, hearings, null, async (body) => {
    const needs = types[body.target_type]?.approval;
    if (!await confirmDialog(needs ? "この内容で申請しますか？\n部門長にお知らせが届きます。" : "この内容で記録しますか？（承認は不要です）", { ok: needs ? "申請して知らせる" : "記録する" })) throw Object.assign(new Error("キャンセル"), { silent: true });
    const res = await api("/api/hearings", { method: "POST", body });
    toast(res.status === "recorded" ? "記録しました（承認不要）" : "申請しました。部門長に通知します");
    replaceHash(`#/hearings/${res.id}`);
  });
}

export async function renderHearing(el, id) {
  const data = await api(`/api/hearings/${id}`);
  const { hearing: h, can, statuses, types } = data;
  const reload = () => renderHearing(el, id);
  const stepIndex = { pending: 0, head_ok: 1, rep_ok: 2, done: 3 }[h.status];

  el.innerHTML = `
    <nav class="breadcrumb"><a href="#/hearings">外部ヒアリング</a> / ${esc(h.target_affiliation)} ${esc(h.target_name)}さん</nav>
    <div class="page-heading left">
      <h1>${esc(h.target_affiliation)} ${esc(h.target_name)}さん</h1>
      <p>${statusBadge(h.status, statuses)} ${esc(types[h.target_type]?.label || "")}・申請者 ${esc(h.applicant_name)}</p>
    </div>
    ${h.requires_approval && stepIndex !== undefined ? `<ol class="stepper hearing-steps">${STEPS.map(([k, l], i) => `
      <li class="${i < stepIndex ? "is-done" : i === stepIndex ? "is-current" : ""}"><span class="dot">${i < stepIndex ? "✓" : i + 1}</span><span class="label">${l}</span></li>`).join("")}</ol>` : ""}

    ${actionPanel(data)}

    <section class="card">
      ${h.result_summary ? `<div class="section-head"><h2>ヒアリングの記録</h2>${copyButton("hearing")}</div>` : ""}
      <dl class="fields">
        <dt>何のために</dt><dd>${esc(h.purpose)}</dd>
        ${h.project_name ? `<dt>関連するPJ</dt><dd><a href="#/projects/${h.project_id}">${esc(h.project_name)}</a></dd>` : ""}
        ${h.node_title ? `<dt>関連する課題（樹形図）</dt><dd><a href="#/projects/${h.project_id}?tab=tree&open=${h.node_id}">${esc(h.node_title)}</a></dd>` : ""}
        ${h.related_issue ? `<dt>関連する課題</dt><dd>${esc(h.related_issue)}</dd>` : ""}
        ${h.memo ? `<dt>メモ</dt><dd>${esc(h.memo)}</dd>` : ""}
        ${h.thread_url ? `<dt>渉外フォーラム</dt><dd><a class="button small" href="${esc(h.thread_url)}" target="_blank" rel="noopener">スレッドを開く</a></dd>`
          : h.status === "rep_ok" ? `<dt>渉外フォーラム</dt><dd class="muted">スレッドはまだ作れていません（部門長・代表が作り直せます）</dd>` : ""}
        ${h.result_summary ? `<dt>聞けた内容の要点</dt><dd class="pre">${esc(h.result_summary)}</dd>` : ""}
      </dl>
    </section>

    <div class="two-col">
      <section class="section">
        <h2>経過</h2>
        <ul class="timeline">${data.events.map((e) => `
          <li><span class="muted small">${new Date(e.created_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
            <span>${esc(EVENT_LABEL[e.action] || e.action)}${e.actor_name ? `（${esc(e.actor_name)}）` : ""}</span>
            ${e.comment ? `<p class="comment">${esc(e.comment)}</p>` : ""}</li>`).join("")}</ul>
      </section>
      <section class="section">
        <h2>同じ相手へのほかの申請</h2>
        ${data.related.length ? `<ul class="list">${data.related.map((r) => `
          <li class="list-item"><a href="#/hearings/${r.id}">${esc(r.purpose)}</a>
            <div class="meta">${statusBadge(r.status, statuses)}<span>${esc(r.applicant_name)}</span></div></li>`).join("")}</ul>`
          : `<p class="muted">ありません。</p>`}
      </section>
    </div>
    <div id="edit-box"></div>`;

  // 部門長・代表の確認
  // Notion用：ヒアリングの記録（相手・目的・聞けた内容の要点）
  bindCopyButtons(el.querySelector(".fields").parentElement, () => [
    `### ヒアリング：${h.target_affiliation} ${h.target_name}さん`, "", `- 目的：${h.purpose}`,
    ...(h.project_name ? [`- 関連するPJ：${h.project_name}`] : []), "", "#### 聞けた内容の要点", h.result_summary,
  ].join("\n"));
  el.querySelectorAll("[data-review]").forEach((b) => b.addEventListener("click", async () => {
    const comment = el.querySelector("#review-comment").value.trim();
    if (b.dataset.review === "return" && !comment) return toast("差し戻すときは、理由をコメントに書いてください", "error");
    if (b.dataset.review === "approve" && !await confirmDialog("承認しますか？\n申請した人（と、次に確認する代表）にお知らせが届きます。", { ok: "承認して知らせる" })) return;
    if (b.dataset.review === "return" && !await confirmDialog("差し戻しますか？\n申請した人に、コメントとあわせてお知らせが届きます。", { ok: "差し戻して知らせる" })) return;
    busy(b, () => api(`/api/hearings/${h.id}/review`, { method: "POST", body: { decision: b.dataset.review, comment } }))
      .then((res) => {
        toast(b.dataset.review === "return" ? "差し戻しました" : res.threadCreated === false ? "承認しました（スレッドは作れませんでした）" : "承認しました");
        reload();
      }).catch(() => {});
  }));
  el.querySelector("[data-retry]")?.addEventListener("click", async (e) => {
    const b = e.currentTarget;
    if (!await confirmDialog("渉外フォーラムにスレッドを作りますか？\n申請した人にお知らせが届きます。", { ok: "スレッドを作る" })) return;
    busy(b, () => api(`/api/hearings/${h.id}/thread`, { method: "POST", body: {} })).then(() => { toast("スレッドを作りました"); reload(); }).catch(() => {});
  });
  el.querySelector("#done-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    busy(e.submitter, () => api(`/api/hearings/${h.id}/done`, { method: "POST", body: formData(e.target) }))
      .then(() => { toast("記録しました"); reload(); }).catch(() => {});
  });
  el.querySelector("[data-withdraw]")?.addEventListener("click", async (e) => {
    if (!await confirmDialog("この申請を取り下げますか？")) return;
    busy(e.target, () => api(`/api/hearings/${h.id}/withdraw`, { method: "POST", body: {} })).then(reload).catch(() => {});
  });
  el.querySelector("[data-edit]")?.addEventListener("click", async () => {
    const [{ hearings }, { projects }] = await Promise.all([api("/api/hearings"), api("/api/projects")]);
    const box = el.querySelector("#edit-box");
    box.innerHTML = `<h2>申請を修正する</h2>${hearingForm(types, projects.filter((p) => p.status === "active"), h)}`;
    box.scrollIntoView({ behavior: "smooth" });
    bindHearingForm(box, types, hearings, h, async (body) => {
      if (h.status === "returned" && !await confirmDialog("修正した内容で再申請しますか？\n部門長にお知らせが届きます。", { ok: "再申請して知らせる" })) throw Object.assign(new Error("キャンセル"), { silent: true });
      await api(`/api/hearings/${h.id}`, { method: "PUT", body });
      toast(h.status === "returned" ? "再申請しました。部門長に通知します" : "保存しました");
      reload();
    });
  });
}

const EVENT_LABEL = {
  submit: "申請", resubmit: "修正して再申請", edit: "申請を修正", head_approve: "部門長が確認", head_return: "部門長が差し戻し",
  rep_approve: "代表が確認", rep_return: "代表が差し戻し", thread_created: "渉外フォーラムにスレッドを作成",
  thread_failed: "スレッドを作れませんでした", done: "実施済（要点を記入）", withdraw: "取り下げ",
};

function actionPanel({ hearing: h, can, events }) {
  const parts = [];
  if (can.headReview || can.repReview) {
    parts.push(`
      <section class="card review">
        <h2>${can.headReview ? "部門長の確認" : "代表の確認"}</h2>
        <textarea id="review-comment" maxlength="500" rows="2" placeholder="コメント（差し戻すときは必須）"></textarea>
        <div class="form-actions">
          <button data-review="return">差し戻す</button>
          <button class="primary" data-review="approve">${can.repReview ? "承認してスレッドを作る" : "承認して代表へ"}</button>
        </div>
      </section>`);
  }
  if (h.status === "returned") {
    const last = [...events].reverse().find((e) => e.action.endsWith("_return"));
    parts.push(`<section class="card returned"><h2>差し戻されました</h2>
      ${last ? `<p class="comment">${esc(last.comment)}</p>` : ""}
      ${can.edit ? `<p class="small">内容を直して再申請すると、部門長の確認からやり直します。</p>` : ""}</section>`);
  }
  if (can.retryThread) {
    parts.push(`<section class="card"><p>渉外フォーラムのスレッドがまだ作れていません。Botの設定を確認してから、作り直してください。</p>
      <button class="primary" data-retry>スレッドを作り直す</button></section>`);
  }
  if (can.done) {
    parts.push(`
      <form class="card form" id="done-form">
        <h2>${h.status === "done" ? "聞けた内容の要点（修正）" : "実施したら、聞けた内容の要点を記入"}</h2>
        <textarea name="result_summary" maxlength="600" rows="4" required placeholder="短く要点だけ。詳しい内容はGoogleドキュメントへ">${esc(h.result_summary)}</textarea>
        <div class="form-actions"><button class="primary">${h.status === "done" ? "保存する" : "実施済にする"}</button></div>
      </form>`);
  }
  const small = [];
  if (can.edit) small.push(`<button class="small" data-edit>申請を修正する</button>`);
  if (can.withdraw) small.push(`<button class="link-btn danger" data-withdraw>取り下げる</button>`);
  if (small.length) parts.push(`<div class="row-left" style="margin-bottom:16px">${small.join("")}</div>`);
  return parts.join("");
}
