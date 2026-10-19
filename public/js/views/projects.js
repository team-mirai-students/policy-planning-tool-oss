// PJ一覧と、PJの作成・編集フォーム
import { api, esc, state, avatar, dueBadge, fmtDateTime, fmtDate, busy, formData, toast, confirmDialog, WEEK, addDays, nextMonday, stageStepper, guardForm, markSaved, bindMemberFilter, viewSwitch, bindViewSwitch, replaceHash } from "../lib.js";
import { ico } from "../icons.js";

// 「政策の種を出す」：受付中のPJ決めを開いて、投稿欄を出す（受付中がなければ「次のPJ決め」ができる）
export function openSeedBox(button) {
  return busy(button, () => api("/api/seed-box", { method: "POST", body: {} }))
    .then(({ id }) => { location.hash = `#/seeds/${id}?post=1`; }).catch(() => {});
}

export async function renderProjects(el) {
  const [{ projects }, { rounds }] = await Promise.all([api("/api/projects?archived=1"), api("/api/rounds").catch(() => ({ rounds: [] }))]);
  // 赤ポチ：締め切りが決まっていて受付中のPJ決めがあるときだけ（締め切りなしの「次のPJ決め」はいつもあるので出さない）
  const open = rounds.find((r) => !r.archived && !r.closed && r.deadline);

  // 参加中のPJがない人（部門長など）は、進行中すべてから見せる
  let filter = projects.some((p) => p.isMine && p.status !== "archived") ? "mine" : "active";
  const stageName = (p) => state.types[p.type]?.stages.find((s) => s.no === p.current_stage)?.name || "";

  const draw = () => {
    // アーカイブ：完了したPJと、一時中止（アーカイブ）したPJ
    const list = projects.filter((p) => filter === "archive" ? p.status !== "active"
      : p.status !== "archived" && (filter === "mine" ? p.isMine : p.status === "active"));
    el.innerHTML = `
      <div class="page-heading">${viewSwitch("pj", { seedsOpen: Boolean(open) })}</div>
      <div class="board-tools">
        <div class="tabs" role="tablist">
          ${[["mine", "参加中"], ["active", "進行中（部門）"], ["archive", "アーカイブ"]].map(([k, l]) =>
            `<button role="tab" aria-selected="${filter === k}" data-filter="${k}">${l}</button>`).join("")}
        </div>
        <span class="row-left">${state.me.isAdmin ? `<a class="button" href="#/schedule">${ico("calendar")} 期日を設定する</a>` : ""}<button type="button" class="button primary" data-seed-box>${ico("sprout")} 政策の種を出す</button></span>
      </div>
      ${filter === "archive" ? archiveList(list) : list.length ? `<div class="card-grid">${list.map((p) => `
        <a class="card pj-card" href="#/projects/${p.id}">
          <span class="stage-pill">${p.status === "done" ? "完了" : `工程${p.current_stage}・${esc(stageName(p))}`}${p.personal ? "・個人PJ" : ""}</span>
          ${p.status === "active" && p.completion_requested_at ? `<span class="due is-soon">完了の承認待ち</span>` : ""}
          <h3>${esc(p.name)}</h3>
          ${stageStepper(p, p.stages || [], { compact: true })}
        </a>`).join("")}</div>`
        : `<div class="empty"><p>該当するPJはありません。</p><p class="muted small">PJは、PJ決めの種から始めます（種の「⋯」→「個人PJとして進める」、または部門のPJ決め）。</p></div>`}`;
    el.querySelector("[data-seed-box]")?.addEventListener("click", (e) => openSeedBox(e.currentTarget));
    // 一時中止したPJを、もう一度PJ決めのアンケートに入れる（記録はPJに残り、PJにするときに記録ごと戻せる）
    el.querySelectorAll("[data-requeue]").forEach((b) => b.addEventListener("click", async () => {
      const p = projects.find((x) => x.id === Number(b.dataset.requeue));
      if (!await confirmDialog(`「${p.name}」を、もう一度PJ決めのアンケートに種として入れますか？

議事録・タスクなどの記録は残ったままです。この種をまたPJにするとき、記録ごと戻せます。`, { ok: "PJ決めに入れる" })) return;
      busy(b, () => api(`/api/projects/${p.id}/requeue`, { method: "POST", body: {} }))
        .then((res) => { p.requeued = 1; toast(`「${res.round_title}」に種として入れました`); draw(); }).catch(() => {});
    }));
    bindViewSwitch(el);
    el.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => {
      filter = b.dataset.filter;
      draw();
    }));
  };
  draw();
}

// アーカイブ欄：完了したPJと、一時中止したPJ。一時中止したPJは、もう一度PJ決めに入れられる（PJメンバーと管理者）
function archiveList(list) {
  if (!list.length) return `<div class="empty"><p>アーカイブしたPJはありません。</p></div>`;
  const row = (p) => `
    <li class="list-item">
      <span><a href="#/projects/${p.id}"><strong>${esc(p.name)}</strong></a>
        <span class="muted small">${p.status === "done" ? "完了" : "一時中止"}${p.personal ? "・個人PJ" : ""}</span></span>
      ${p.status === "archived" ? `<div class="meta">${p.requeued ? `<span class="muted small">${ico("check")} PJ決めに入っています</span>`
        : state.me.isAdmin || p.isMine ? `<button type="button" class="small" data-requeue="${p.id}">${ico("ballot")} PJ決めのアンケートに入れる</button>` : ""}</div>` : ""}
    </li>`;
  const paused = list.filter((p) => p.status === "archived");
  const done = list.filter((p) => p.status === "done");
  return `${paused.length ? `<h2>一時中止</h2><ul class="list">${paused.map(row).join("")}</ul>` : ""}
    ${done.length ? `<h2>完了</h2><ul class="list">${done.map(row).join("")}</ul>` : ""}`;
}

export async function renderProjectForm(el, id) {
  // PJは、PJ決めの種から始める（ここから新しくは作らない）
  if (!id) {
    el.innerHTML = `<div class="empty"><p>PJは、PJ決めの種から始めます。</p>
      <p class="muted small">種のカードの「⋯」→「個人PJとして進める」で、自分のPJとして始められます。</p>
      <p><a class="button primary" href="#/seeds">${ico("sprout")} PJ決めを開く</a></p></div>`;
    return;
  }
  const data = id ? await api(`/api/projects/${id}`) : null;
  if (data && !data.canEdit) throw new Error("このPJを編集できるのは、PJメンバーと管理者です");
  const p = data?.project || {
    name: "", description: "", doc_url: "", memo_doc_url: "", script_doc_url: "", share_doc_url: "", type: "teigen", start_date: nextMonday(), presentation_date: "",
    meeting_mode: "regular", meeting_weekdays: "", meeting_time: "21:00", meeting_interval: 1, meeting_duration: 60,
    meeting_place: "", status: "active",
  };
  const memberIds = new Set(data ? data.members.map((m) => m.id) : [state.me.id]);
  const weekdays = new Set((p.meeting_weekdays || "").split(",").filter(Boolean));

  el.innerHTML = `
    <nav class="breadcrumb"><a href="#/projects">PJ</a> / ${id ? `<a href="#/projects/${id}">${esc(p.name)}</a> / 編集` : "PJを作る"}</nav>
    <div class="page-heading left"><h1>${id ? "PJを編集" : "PJを作る"}</h1>
      <p>${id ? "" : "PJ決め（工程0）が終わったら作ります。作ると工程1「課題・現状リサーチ」から始まります。"}</p></div>
    <form class="card form" id="pj-form">
      <label>PJ名 <span class="req">必須</span>
        <input name="name" maxlength="60" required value="${esc(p.name)}" placeholder="例：なぜ地熱発電の推進は進まないのか">
      </label>
      ${Object.keys(state.types).length > 1 ? `<label>PJの型
        <select name="type" ${id ? "disabled" : ""}>
          ${Object.entries(state.types).map(([k, t]) => `<option value="${k}" ${p.type === k ? "selected" : ""}>${esc(t.label)}</option>`).join("")}
        </select>
      </label>` : `<input type="hidden" name="type" value="${esc(p.type)}">`}
      <label>概要（任意）
        <textarea name="description" maxlength="400" rows="2">${esc(p.description)}</textarea>
      </label>
      <fieldset class="doc-urls">
        <legend>Googleドキュメント（任意・あとから登録できます）</legend>
        <label>${ico("search")} リサーチドキュメント <small class="muted">調べたことをメンバーがタブを分けて書き残す。議事録の画面に表示されます</small>
          <input name="memo_doc_url" type="url" value="${esc(p.memo_doc_url)}" placeholder="https://docs.google.com/document/...">
        </label>
        <label>${ico("chart")} 課題共有の資料 <small class="muted">政調MTGの課題共有で使うもの。「発表する」で課題共有を選ぶと表示されます</small>
          <input name="share_doc_url" type="url" value="${esc(p.share_doc_url)}" placeholder="https://docs.google.com/...">
        </label>
        <label>${ico("doc")} 政調用の本文 <small class="muted">政策提言として形を整えたもの</small>
          <input name="doc_url" type="url" value="${esc(p.doc_url)}" placeholder="https://docs.google.com/document/...">
        </label>
        <label>${ico("mic")} 政調用の台本
          <input name="script_doc_url" type="url" value="${esc(p.script_doc_url)}" placeholder="https://docs.google.com/document/...">
        </label>
        <label>${ico("chat")} DiscordのチャンネルID <small class="muted">PJ画面の「${ico("chat")} Discord」ボタンで開くチャンネル（リンクを貼ってもOK）。アンケートの投稿先は、管理者メニュー「${ico("megaphone")} Discordの投稿先」で登録します</small>
          <input name="discord_channel_id" inputmode="numeric" value="${esc(p.discord_channel_id || "")}" placeholder="例：1559189147137081484">
        </label>
      </fieldset>
      <div class="grid-2">
        <label>開始日（1週目の初日） <span class="req">必須</span>
          <input name="start_date" type="date" required value="${esc(p.start_date)}">
        </label>
        <label>政調での最終発表日（決まったら）
          <input name="presentation_date" type="date" value="${esc(p.presentation_date || "")}">
          <small class="muted">未定のあいだは8週目の終わりとして各工程の期限を出します。</small>
        </label>
      </div>
      <p class="muted small" id="schedule-preview"></p>

      <fieldset>
        <legend>メンバー <span class="req">必須</span></legend>
        <div class="member-picker">
          ${state.users.map((u) => `
            <label class="chip-check"><input type="checkbox" name="member" value="${esc(u.id)}" ${memberIds.has(u.id) ? "checked" : ""}>
              ${avatar(u)}<span>${esc(u.name)}</span></label>`).join("")}
        </div>
        <small class="muted">一覧に出るのは、このツールに一度ログインした人と、希望PJアンケートで投票した人です。</small>
      </fieldset>

      <fieldset>
        <legend>MTGの進め方</legend>
        <div class="segmented">
          <label><input type="radio" name="meeting_mode" value="regular" ${p.meeting_mode === "regular" ? "checked" : ""}> 定例（曜日・時刻を決める）</label>
          <label><input type="radio" name="meeting_mode" value="adhoc" ${p.meeting_mode === "adhoc" ? "checked" : ""}> 毎回決める</label>
        </div>
        <div id="regular-fields">
          <div class="weekday-picker">
            ${WEEK.map((w, i) => `<label class="chip-check"><input type="checkbox" name="weekday" value="${i}" ${weekdays.has(String(i)) ? "checked" : ""}><span>${w}</span></label>`).join("")}
          </div>
          <div class="grid-3">
            <label>時刻<input name="meeting_time" type="time" value="${esc(p.meeting_time || "21:00")}"></label>
            <label>頻度
              <select name="meeting_interval">
                <option value="1" ${p.meeting_interval == 1 ? "selected" : ""}>毎週</option>
                <option value="2" ${p.meeting_interval == 2 ? "selected" : ""}>隔週</option>
              </select>
            </label>
            <label>長さ（分）<input name="meeting_duration" type="number" min="15" max="480" step="15" value="${esc(p.meeting_duration)}"></label>
          </div>
          <small class="muted">週2回なら曜日を2つ選びます。</small>
        </div>
        <p class="muted small" id="adhoc-note">MTGが終わって議事録を書くと「次回の日程を決める」画面が出ます。日程が未定のままなら、PJメンバーにリマインドが届きます。</p>
        <label>場所・URL（任意）<input name="meeting_place" maxlength="200" value="${esc(p.meeting_place)}" placeholder="Discordのボイスチャンネルなど"></label>
      </fieldset>

      ${id ? `<label>状態
        <select name="status">
          <option value="active" ${p.status === "active" ? "selected" : ""}>進行中</option>
          <option value="done" ${p.status === "done" ? "selected" : ""}>完了</option>
          ${state.me.isAdmin ? `<option value="archived" ${p.status === "archived" ? "selected" : ""}>一時中止（アーカイブ）</option>` : ""}
        </select></label>` : ""}

      <div class="form-actions">
        <a class="button" href="${id ? `#/projects/${id}` : "#/projects"}">キャンセル</a>
        <button class="primary" type="submit">${id ? "保存する" : "作成する"}</button>
      </div>
    </form>`;

  const form = el.querySelector("#pj-form");
  const sync = () => {
    const regular = form.meeting_mode.value === "regular";
    form.querySelector("#regular-fields").hidden = !regular;
    form.querySelector("#adhoc-note").hidden = regular;
    const start = form.start_date.value;
    if (start) {
      const pres = form.presentation_date.value || addDays(start, 55);
      form.querySelector("#schedule-preview").textContent =
        `目安：課題リサーチ〜${fmtDate(addDays(start, 9))}／課題共有 ${fmtDate(addDays(start, 13))}／施策考案〜${fmtDate(addDays(start, 34))}／最終発表 ${fmtDate(pres)}${form.presentation_date.value ? "" : "（仮）"}／最終提出〜${fmtDate(addDays(pres, 28))}`;
    }
  };
  form.addEventListener("change", sync);
  sync();
  guardForm(form);
  bindMemberFilter(form);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = formData(form);
    const body = {
      ...f,
      meeting_weekdays: [...form.querySelectorAll("[name=weekday]:checked")].map((c) => c.value),
      member_ids: [...form.querySelectorAll("[name=member]:checked")].map((c) => c.value),
      version: p.version,
    };
    if (!body.member_ids.length) return toast("メンバーを1人以上選んでください", "error");
    const nameOfId = (uid) => state.users.find((u) => u.id === uid)?.name || "";
    const added = body.member_ids.filter((uid) => !memberIds.has(uid) || !id).filter((uid) => uid !== state.me.id);
    const meetingKeys = ["meeting_mode", "meeting_time", "meeting_interval", "meeting_duration", "meeting_place", "start_date"];
    const meetingChanged = id && p.meeting_mode === "regular" && (meetingKeys.some((k) => String(p[k] ?? "") !== String(f[k] ?? ""))
      || [...weekdays].sort().join(",") !== [...body.meeting_weekdays].sort().join(","));
    const lines = [
      ...(added.length ? [`・${added.map(nameOfId).join("、")}さん：PJのメンバーになったこと`] : []),
      ...(meetingChanged && body.meeting_mode === "regular" ? ["・PJメンバー：定例MTGの曜日・時刻が変わったこと"] : []),
    ];
    const button = e.submitter;
    if (lines.length && !await confirmDialog(`${id ? "保存" : "作成"}しますか？\n\n次のお知らせが届きます：\n${lines.join("\n")}`, { ok: id ? "保存して知らせる" : "作成して知らせる" })) return;
    busy(button, async () => {
      const res = await api(id ? `/api/projects/${id}` : "/api/projects", { method: id ? "PUT" : "POST", body });
      markSaved(form);
      toast(id ? "保存しました" : "PJを作成しました");
      replaceHash(`#/projects/${id || res.id}`);
    }).catch(() => {});
  });
}
