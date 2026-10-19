// 日程調整アンケート：候補の日時を並べて作る／○△× で答える／いちばん集まった日時に決める
import { api, esc, shareButton, avatar, busy, toast, confirmDialog, fmtDateTime, state, addDays, celebrate, replaceHash } from "../lib.js";
import { sendPollImage } from "../poll-image.js";
import { ico } from "../icons.js";

const MARK = { yes: "○", maybe: "△", no: "×" };
const LABEL = { yes: "行ける", maybe: "たぶん", no: "無理" };

// ---------- 作る ----------
export async function renderSchedulePollNew(el, projectId) {
  const { project: p } = await api(`/api/projects/${projectId}`);
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const time = p.meeting_time || "21:00";
  // はじめは、明日から5日分を同じ時刻で候補にしておく（消したり変えたりできる）
  const initial = [1, 2, 3, 4, 5].map((d) => `${addDays(today, d)}T${time}`);
  el.innerHTML = `
    <nav class="breadcrumb"><a href="#/projects/${p.id}">${esc(p.name)}</a> / 日程調整アンケート</nav>
    <div class="page-heading left"><h1>${ico("calendar")} 日程調整アンケートを作る</h1>
      <p>次回MTGの候補の日時を並べると、PJのメンバーが ○△× で答えます。いちばん集まった日時に、ボタン1つで決められます。</p></div>
    <form class="card form" id="poll-form">
      <div class="field"><strong>候補の日時</strong>
        <div id="slots">${initial.map(slotRow).join("")}</div>
        <div class="row-left"><button type="button" class="small" id="add-slot">＋ 候補を足す</button>
          <button type="button" class="small" id="add-week">＋ 1週間分を足す（同じ時刻）</button></div>
      </div>
      <div class="row-left">
        <label>長さ（分）<input name="duration_min" type="number" min="15" max="480" step="15" value="${esc(p.meeting_duration || 60)}"></label>
        <label style="flex:1">場所・URL（任意）<input name="place" maxlength="200" value="${esc(p.meeting_place || "")}"></label>
      </div>
      <label>ひとこと（任意）<input name="note" maxlength="500" placeholder="例：金曜までに答えてください"></label>
      <div class="form-actions"><a class="button" href="#/projects/${p.id}">キャンセル</a><button class="primary">作ってメンバーに知らせる</button></div>
    </form>`;
  const box = el.querySelector("#slots");
  el.querySelector("#add-slot").addEventListener("click", () => {
    const last = [...box.querySelectorAll("input")].pop()?.value || `${today}T${time}`;
    box.insertAdjacentHTML("beforeend", slotRow(`${addDays(last.slice(0, 10), 1)}T${last.slice(11, 16)}`));
  });
  el.querySelector("#add-week").addEventListener("click", () => {
    const last = [...box.querySelectorAll("input")].pop()?.value || `${today}T${time}`;
    for (let d = 1; d <= 7; d++) box.insertAdjacentHTML("beforeend", slotRow(`${addDays(last.slice(0, 10), d)}T${last.slice(11, 16)}`));
  });
  box.addEventListener("click", (e) => { if (e.target.closest("[data-del]")) e.target.closest(".opt-row").remove(); });
  el.querySelector("#poll-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const slots = [...box.querySelectorAll("input")].map((i) => i.value).filter(Boolean);
    if (slots.length < 2) { toast("候補を2つ以上入れてください", "error"); return; }
    if (!await confirmDialog(`候補${slots.length}つで日程調整アンケートを作りますか？\nPJメンバーに「答えてください」のお知らせが届きます。`, { ok: "作って知らせる" })) return;
    busy(e.submitter, () => api(`/api/projects/${p.id}/schedule-polls`, { method: "POST",
      body: { slots, duration_min: f.duration_min.value, place: f.place.value, note: f.note.value } }))
      .then((res) => { toast("日程調整アンケートを作りました"); replaceHash(`#/schedule-polls/${res.id}`); }).catch(() => {});
  });
}
const slotRow = (v) => `<div class="opt-row"><input type="datetime-local" value="${esc(v)}" aria-label="候補の日時"><button type="button" class="link-btn" data-del aria-label="この候補を消す">✕</button></div>`;

// ---------- 答える・決める ----------
export async function renderSchedulePoll(el, id) {
  const d = await api(`/api/schedule-polls/${id}`);
  const { poll, slots, members, project: p, canEdit } = d;
  const closed = Boolean(poll.closed_at);
  const me = state.me.id;
  const ans = {}; // slotId → userId → answer
  for (const a of d.answers) (ans[a.slot_id] ||= {})[a.user_id] = a.answer;
  const mine = Object.fromEntries(slots.map((s) => [s.id, ans[s.id]?.[me] || ""]));
  const score = (s) => Object.values(ans[s.id] || {}).reduce((n, a) => n + (a === "yes" ? 2 : a === "maybe" ? 1 : 0), 0);
  const noCount = (s) => Object.values(ans[s.id] || {}).filter((a) => a === "no").length;
  const best = Math.max(0, ...slots.map(score));
  const answered = new Set(d.answers.map((a) => a.user_id));
  const waiting = members.filter((m) => !answered.has(m.id));

  el.innerHTML = `
    <nav class="breadcrumb"><a href="#/projects/${p.id}">${esc(p.name)}</a> / 日程調整アンケート</nav>
    <div class="page-heading left"><h1>${ico("calendar")} 次回MTGの日程調整</h1>
      <p>${closed ? (poll.meeting_id ? `決まりました。<a href="#/meetings/${poll.meeting_id}">次回MTGを開く</a>` : "締め切りました。") : "行ける日時に ○、たぶん行けるなら △、無理なら × を押してください。"}
        <span class="muted small">回答 ${answered.size} / ${members.length}人</span> ${shareButton("p", poll.id)}</p>
      ${poll.note ? `<p class="survey-desc">${esc(poll.note)}</p>` : ""}</div>

    <form class="card" id="answers">
      <ul class="sp-slots">${slots.map((s) => {
        const sc = score(s);
        const who = members.map((m) => ({ m, a: ans[s.id]?.[m.id] })).filter((x) => x.a && x.a !== "no");
        return `<li class="sp-slot ${sc && sc === best && !closed ? "is-best" : ""}">
          <div class="sp-when"><strong>${fmtDateTime(s.starts_at)}</strong>
            ${sc && sc === best ? `<span class="tag sp-best">いちばん集まっている</span>` : ""}
            <span class="small muted">○ ${Object.values(ans[s.id] || {}).filter((a) => a === "yes").length}・△ ${Object.values(ans[s.id] || {}).filter((a) => a === "maybe").length}・× ${noCount(s)}</span>
            <span class="sp-who">${who.map(({ m, a }) => `<span class="sp-person" title="${esc(m.name)}：${LABEL[a]}">${avatar(m, "sm")}<b>${MARK[a]}</b></span>`).join("")}</span>
          </div>
          ${closed ? "" : `<div class="sp-pick" role="radiogroup" aria-label="${esc(fmtDateTime(s.starts_at))}">${["yes", "maybe", "no"].map((k) =>
            `<button type="button" class="sp-btn sp-${k} ${mine[s.id] === k ? "is-on" : ""}" data-slot="${s.id}" data-a="${k}" aria-pressed="${mine[s.id] === k}" title="${LABEL[k]}">${MARK[k]}</button>`).join("")}</div>`}
          ${canEdit && !closed ? `<button type="button" class="small sp-decide" data-decide="${s.id}">この日に決める</button>` : ""}
        </li>`;
      }).join("")}</ul>
      ${closed ? "" : `<div class="form-actions"><span class="muted small" id="sp-left"></span><button class="primary" type="submit">回答する</button></div>`}
    </form>
    ${waiting.length && !closed ? `<p class="muted small">まだ答えていない人：${waiting.map((m) => esc(m.name)).join("、")}</p>` : ""}
    ${canEdit && !closed ? `<p><button type="button" class="link-btn danger" id="sp-close">決めずに締め切る</button></p>` : ""}`;

  // Discordに投稿してあれば、いまの状態の「画面そっくりの画像」を作って、投稿を書き直す
  if (d.discord) sendPollImage(d).catch(() => {});
  el.querySelector(".page-heading")?.addEventListener("discord-posted", () => renderSchedulePoll(el, id));

  const form = el.querySelector("#answers");
  const left = () => {
    const n = slots.filter((s) => !mine[s.id]).length;
    const t = el.querySelector("#sp-left");
    if (t) t.textContent = n ? `あと${n}つ` : "全部に答えました";
  };
  left();
  form.addEventListener("click", (e) => {
    const b = e.target.closest("[data-a]");
    if (b) {
      mine[b.dataset.slot] = b.dataset.a;
      b.parentElement.querySelectorAll("[data-a]").forEach((x) => { x.classList.toggle("is-on", x === b); x.setAttribute("aria-pressed", String(x === b)); });
      left();
      return;
    }
    const dec = e.target.closest("[data-decide]");
    if (dec) decide(Number(dec.dataset.decide), dec);
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const answers = Object.fromEntries(Object.entries(mine).filter(([, a]) => a));
    busy(e.submitter, () => api(`/api/schedule-polls/${id}/answers`, { method: "PUT", body: { answers } }))
      .then(() => { toast("回答しました"); renderSchedulePoll(el, id); }).catch(() => {});
  });
  const decide = async (slotId, button) => {
    const s = slots.find((x) => x.id === slotId);
    const nos = members.filter((m) => ans[slotId]?.[m.id] === "no").map((m) => m.name);
    if (!await confirmDialog(`次回MTGを ${fmtDateTime(s.starts_at)} に決めますか？${nos.length ? `\n× の人：${nos.join("、")}` : ""}\nこのアンケートは締め切られ、PJメンバーにお知らせが届きます。`, { ok: "決めて知らせる" })) return;
    busy(button, () => api(`/api/schedule-polls/${id}/decide`, { method: "POST", body: { slot_id: slotId } }))
      .then((res) => { celebrate("次回MTGが決まりました", fmtDateTime(res.starts_at)); renderSchedulePoll(el, id); }).catch(() => {});
  };
  el.querySelector("#sp-close")?.addEventListener("click", async (e) => {
    if (!await confirmDialog("決めずに締め切りますか？（MTGは作られません）")) return;
    busy(e.currentTarget, () => api(`/api/schedule-polls/${id}`, { method: "DELETE" })).then(() => renderSchedulePoll(el, id)).catch(() => {});
  });
}

// PJのページ・議事録に出す入口：受付中のアンケート（答えたか）と「作る」ボタン
export async function schedulePollLinks(box, projectId, canEdit) {
  const { polls } = await api(`/api/projects/${projectId}/schedule-polls`);
  box.innerHTML = `${polls.map((x) => `<a class="survey-btn ${x.mine ? "is-done" : ""}" href="#/schedule-polls/${x.id}">
      <span class="survey-icon">${ico("calendar")}</span><strong>日程調整アンケート</strong><span class="small">${x.mine ? `✓ 回答済み（${x.answered}人）` : "回答する ›"}</span></a>`).join("")}
    ${canEdit && !polls.length ? `<a class="button small" href="#/projects/${projectId}/schedule-poll">${ico("calendar")} 日程が決まらないときは、日程調整アンケートを作る</a>` : ""}`;
}
