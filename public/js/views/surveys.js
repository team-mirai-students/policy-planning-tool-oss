// ホームのアンケート：管理者が追加（PJ決めアンケート／その他のアンケート）、みんなが答える、結果を見る
import { api, esc, shareButton, state, avatar, busy, toast, confirmDialog, fmtDateTime, jstDateTime, celebrate, replaceHash } from "../lib.js";
import { ico } from "../icons.js";

const METHODS = {
  majority: ["多数決", "1つだけ選ぶ。いちばん多いものに決まる"],
  wish: ["希望を聞く", "いくつでも選べる＋ひとこと。決めずに、みんなの希望を集める"],
  rcv: ["RCV", "順位を付ける。過半数になるまで最下位を外して、1つに決める"],
  stv: ["STV", "順位を付ける。複数（例：3つ）を、票のむだが少ないように決める"],
};
const ranked = (m) => m === "rcv" || m === "stv";

// ホームに出すボタン（受付中のアンケート）と、管理者の「アンケートを追加」
export async function homeSurveys(box) {
  const [{ surveys }, { polls }] = await Promise.all([api("/api/surveys"), api("/api/schedule-polls/mine").catch(() => ({ polls: [] }))]);
  const open = surveys.filter((s) => !s.closed_at);
  box.innerHTML = `
    ${open.length || polls.length ? `<div class="survey-buttons">${polls.map((x) => `
      <a class="survey-btn" href="#/schedule-polls/${x.id}"><span class="survey-icon">${ico("calendar")}</span><strong>${esc(x.project_name)}の日程調整</strong><span class="small">回答する ›</span></a>`).join("")}${open.map((s) => `
      <a class="survey-btn ${s.answered ? "is-done" : ""}" href="${s.kind === "pj" ? `#/seeds/${s.round_id}` : `#/surveys/${s.id}`}">
        <span class="survey-icon">${ico(s.kind === "pj" ? "ballot" : "chart")}</span><strong>${esc(s.title)}</strong>
        <span class="small">${s.answered ? "✓ 回答済み" : "回答する ›"}</span></a>`).join("")}</div>` : ""}
    ${state.me.isAdmin ? `<p class="home-admin"><button type="button" class="small" id="add-survey">＋ アンケートを追加</button>
      ${surveys.some((s) => s.closed_at) ? `<a class="small" href="#/surveys">締め切ったアンケート</a>` : ""}</p>` : ""}`;
  box.querySelector("#add-survey")?.addEventListener("click", addSurveyDialog);
}

// 「アンケートを追加」：PJ決めアンケート か その他のアンケート
function addSurveyDialog() {
  const back = document.createElement("div");
  back.className = "dialog-backdrop";
  back.innerHTML = `
    <div class="dialog" role="dialog" aria-modal="true" aria-label="アンケートを追加">
      <p><strong>どのアンケートを追加しますか？</strong></p>
      <div class="survey-kinds">
        <button type="button" class="kind-btn" data-kind="pj"><span class="kind-icon">${ico("ballot")}</span><span class="kind-text"><strong>PJ決めアンケート</strong><small class="muted">政策の種に投票して、PJを決める</small></span></button>
        <button type="button" class="kind-btn" data-kind="other"><span class="kind-icon">${ico("chart")}</span><span class="kind-text"><strong>その他のアンケート</strong><small class="muted">多数決・希望を聞く・RCV・STV から選ぶ</small></span></button>
      </div>
      <div class="form-actions"><button type="button" data-no>キャンセル</button></div>
    </div>`;
  const close = () => back.remove();
  back.addEventListener("click", (e) => { if (e.target === back || e.target.closest("[data-no]")) close(); });
  back.querySelector("[data-kind=other]").addEventListener("click", () => { close(); location.hash = "#/surveys/new"; });
  back.querySelector("[data-kind=pj]").addEventListener("click", async (e) => {
    close();
    if (!await confirmDialog("PJ決めアンケートを開始しますか？\nみんなのホーム画面に「PJ決めアンケート」のボタンが出て、押すとPJ決めの投票ができます。", { ok: "開始する" })) return;
    const res = await api("/api/surveys", { method: "POST", body: { kind: "pj" } }).catch(() => null);
    if (!res) return;
    toast(res.existed ? "PJ決めアンケートはもう始まっています" : "PJ決めアンケートを開始しました");
    if (!res.existed) celebrate("PJ決めアンケートを開始しました", "みんなのホームにボタンが出ます");
    location.hash = "#/";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  document.body.append(back);
}

// その他のアンケートを作る（管理者）
export async function renderSurveyNew(el) {
  if (!state.me.isAdmin) throw new Error("アンケートを追加できるのは、管理者です");
  el.innerHTML = `
    <nav class="breadcrumb"><a href="#/">ホーム</a> / アンケートを追加</nav>
    <div class="page-heading"><h1>${ico("chart")} その他のアンケート</h1></div>
    <form class="card form" id="survey-form">
      <label>アンケートの名前<input name="title" maxlength="80" required></label>
      <label>説明（任意）<textarea name="description" rows="2" maxlength="1000"></textarea></label>
      <fieldset class="method-pick"><legend>決め方</legend>
        ${Object.entries(METHODS).map(([k, [label, note]], i) => `
          <label class="method"><input type="radio" name="method" value="${k}" ${i === 0 ? "checked" : ""}><span><strong>${label}</strong><small class="muted">${note}</small></span></label>`).join("")}
      </fieldset>
      <label id="seats-field" hidden>決める数<input name="seats" type="number" min="1" max="29" value="2"></label>
      <div class="field"><strong>選択肢</strong>
        <div id="options">${[1, 2, 3].map(() => optionRow()).join("")}</div>
        <button type="button" class="small" id="add-option">＋ 選択肢を足す</button>
      </div>
      <div class="form-actions"><a class="button" href="#/">キャンセル</a><button class="primary">ホームに出す</button></div>
    </form>`;
  const form = el.querySelector("#survey-form");
  const seats = el.querySelector("#seats-field");
  form.addEventListener("change", () => { seats.hidden = form.method.value !== "stv"; });
  el.querySelector("#add-option").addEventListener("click", () => {
    el.querySelector("#options").insertAdjacentHTML("beforeend", optionRow());
    el.querySelector("#options .opt-row:last-child input").focus();
  });
  el.querySelector("#options").addEventListener("click", (e) => { if (e.target.closest("[data-del]")) e.target.closest(".opt-row").remove(); });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const body = {
      kind: "other", title: form.title.value, description: form.description.value, method: form.method.value, seats: form.seats.value,
      options: [...form.querySelectorAll("[name=option]")].map((i) => i.value.trim()).filter(Boolean),
    };
    busy(e.submitter, () => api("/api/surveys", { method: "POST", body }))
      .then((res) => { toast("アンケートをホームに出しました"); replaceHash(`#/surveys/${res.id}`); }).catch(() => {});
  });
}
const optionRow = () => `<div class="opt-row"><input name="option" maxlength="80" aria-label="選択肢"><button type="button" class="link-btn" data-del aria-label="この選択肢を消す">✕</button></div>`;

// 締め切ったアンケートの一覧（管理者）
export async function renderSurveyList(el) {
  const { surveys } = await api("/api/surveys");
  el.innerHTML = `
    <nav class="breadcrumb"><a href="#/">ホーム</a> / アンケート</nav>
    <div class="page-heading"><h1>${ico("chart")} アンケート</h1></div>
    <ul class="list">${surveys.map((s) => `
      <li class="list-item"><a href="${s.kind === "pj" ? `#/seeds/${s.round_id}` : `#/surveys/${s.id}`}">${esc(s.title)}</a>
        <div class="meta">${s.closed_at ? `<span class="tag">締め切り</span>` : `<span class="due is-soon">受付中</span>`}
          ${s.kind === "pj" ? "" : `<span class="muted small">${METHODS[s.method]?.[0] || ""}</span>`}</div></li>`).join("") || `<li class="list-item muted">まだありません</li>`}</ul>`;
}

// 答える・結果を見る
export async function renderSurvey(el, id) {
  const d = await api(`/api/surveys/${id}`);
  const s = d.survey;
  if (s.kind === "pj") { location.replace(`#/seeds/${s.round_id}`); return; }
  const [mLabel, mNote] = METHODS[s.method];
  let picks = d.mine?.picks.slice() || [];
  const closed = Boolean(s.closed_at);

  el.innerHTML = `
    <nav class="breadcrumb"><a href="#/">ホーム</a> / アンケート</nav>
    <div class="page-heading"><h1>${ico("chart")} ${esc(s.title)}</h1>
      <p><span class="tag">${mLabel}${s.method === "stv" ? `・${s.seats}つ決める` : ""}</span> ${closed ? `<span class="tag">締め切り</span>` : `<span class="due is-soon">受付中</span>`} <span class="muted small">回答 ${d.count}人</span> ${shareButton("a", s.id)}</p></div>
    ${s.description ? `<p class="survey-desc">${esc(s.description)}</p>` : ""}
    ${closed ? "" : `<form class="card form" id="answer">
      <p class="muted small">${ranked(s.method) ? "希望の順に押してください（押した順が 1位・2位…。もう一度押すと外れます）" : mNote}</p>
      <div class="survey-options" id="opts"></div>
      ${s.method === "wish" ? `<label>ひとこと（任意）<textarea name="comment" rows="2" maxlength="500">${esc(d.mine?.comment || "")}</textarea></label>` : ""}
      <div class="form-actions">${d.mine ? `<span class="muted small">✓ 回答済み（書き直せます）</span>` : ""}<button class="primary">${d.mine ? "回答を書き直す" : "回答する"}</button></div>
    </form>`}
    <div id="results"></div>
    ${d.canManage ? `<div class="form-actions" style="justify-content:flex-start">
      <button type="button" id="toggle-close">${closed ? `${ico("undo")} 受付を再開する` : "締め切る"}</button>
      <button type="button" class="danger" id="delete-survey">削除する</button></div>` : ""}`;

  const opts = el.querySelector("#opts");
  const drawOptions = () => {
    if (!opts) return;
    opts.innerHTML = s.options.map((o, i) => {
      const rank = picks.indexOf(i);
      const on = rank >= 0;
      return `<button type="button" class="survey-opt ${on ? "is-on" : ""}" data-i="${i}" aria-pressed="${on}">
        <span class="opt-mark">${ranked(s.method) ? (on ? rank + 1 : "") : on ? "✓" : ""}</span><span>${esc(o)}</span></button>`;
    }).join("");
  };
  drawOptions();
  opts?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-i]");
    if (!b) return;
    const i = Number(b.dataset.i);
    if (s.method === "majority") picks = [i];
    else picks = picks.includes(i) ? picks.filter((x) => x !== i) : [...picks, i];
    drawOptions();
  });
  el.querySelector("#answer")?.addEventListener("submit", (e) => {
    e.preventDefault();
    busy(e.submitter, () => api(`/api/surveys/${id}/answer`, { method: "PUT", body: { picks, comment: e.target.comment?.value || "" } }))
      .then(() => { toast(d.mine ? "回答を書き直しました" : "回答しました"); renderSurvey(el, id); }).catch(() => {});
  });
  if (d.results) el.querySelector("#results").innerHTML = resultsHtml(s, d.results, d.answers);
  el.querySelector("#toggle-close")?.addEventListener("click", async (e) => {
    if (!closed && !await confirmDialog("このアンケートを締め切りますか？ホームのボタンが消えて、みんなが結果を見られるようになります。", { ok: "締め切る" })) return;
    busy(e.currentTarget, () => api(`/api/surveys/${id}`, { method: "PATCH", body: { closed: !closed } }))
      .then(() => { toast(closed ? "受付を再開しました" : "締め切りました"); renderSurvey(el, id); }).catch(() => {});
  });
  el.querySelector("#delete-survey")?.addEventListener("click", async (e) => {
    if (!await confirmDialog("このアンケートを削除しますか？回答も消えます。")) return;
    busy(e.currentTarget, () => api(`/api/surveys/${id}`, { method: "DELETE" }))
      .then(() => { toast("削除しました"); replaceHash("#/"); }).catch(() => {});
  });
}

function resultsHtml(s, r, answers) {
  const name = (i) => esc(s.options[i] ?? "");
  const max = Math.max(1, ...r.counts);
  const label = ranked(s.method) ? "第1希望の数" : "票数";
  const bars = s.options.map((o, i) => `
    <li class="bar-row ${r.winners?.includes(i) ? "is-win" : ""}"><span class="bar-label">${r.winners?.includes(i) ? `${ico("trophy")} ` : ""}${esc(o)}</span>
      <span class="bar"><span style="width:${(r.counts[i] / max) * 100}%"></span></span><span class="bar-n">${r.counts[i]}</span></li>`).join("");
  const rounds = (r.rounds || []).map((x, n) => `
    <li><strong>${n + 1}回目</strong>：${Object.entries(x.tallies).map(([c, v]) => `${name(c)} ${v}`).join("・")}
      ${x.winner != null ? `→ <b>${name(x.winner)}</b> に決定` : ""}
      ${x.elected?.length ? `→ <b>${x.elected.map(name).join("・")}</b> 当選` : ""}
      ${Array.isArray(x.eliminated) && x.eliminated.length ? `→ ${x.eliminated.map(name).join("・")} を外す` : typeof x.eliminated === "string" ? `→ ${name(x.eliminated)} を外す` : ""}</li>`).join("");
  return `
    <section class="card">
      <h2>結果 ${s.closed_at ? "" : `<small class="muted">（締め切るまで、見られるのは管理者だけ）</small>`}</h2>
      ${r.total ? "" : `<p class="muted">まだ回答がありません。</p>`}
      ${r.winners?.length && r.total ? `<p class="survey-winner">${s.method === "wish" ? "いちばん多い希望" : "決まったもの"}：<b>${r.winners.map(name).join("・")}</b></p>` : ""}
      <p class="muted small">${label}${s.method === "stv" ? `・当選に必要な票（基数）：${r.quota}` : ""}</p>
      <ul class="bars">${bars}</ul>
      ${rounds ? `<details><summary class="small">どうやって決まったか（${s.method === "stv" ? "STV" : "RCV"}の各回）</summary><ol class="rounds">${rounds}</ol></details>` : ""}
      ${r.comments?.length ? `<h3 class="small">ひとこと</h3><ul class="list">${r.comments.map((c) => `<li class="list-item">${esc(c)}</li>`).join("")}</ul>` : ""}
      ${answers ? `<details><summary class="small">だれが何に入れたか（管理者だけ）</summary><ul class="list">${answers.map((a) => `
        <li class="list-item"><span class="person">${avatar(a)} ${esc(a.name || "")}</span>
          <span class="small">${a.picks.map((p, i) => `${ranked(s.method) ? `${i + 1}.` : ""}${name(p)}`).join(ranked(s.method) ? " → " : "・")}${a.comment ? `「${esc(a.comment)}」` : ""}</span>
          <span class="muted small">${fmtDateTime(jstDateTime(a.updated_at))}</span></li>`).join("")}</ul></details>` : ""}
    </section>`;
}
