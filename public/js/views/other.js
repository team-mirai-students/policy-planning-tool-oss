// その他のMTG（PJ・定例以外）：カテゴリー → プロジェクト（今あるものから選ぶ／新しく作る）→ 議事録（タイマーつき）
// 議事録は、Notionの「その他」ページの「プロジェクト」欄の、そのプロジェクトのページの中に入る
import { api, esc, fmtDate, fmtDateTime, jstDateTime, hashQuery, busy, toast, confirmDialog, timerHtml, bindTimer, guardForm, markSaved, mergeText, autoSave, pickItem, guardMeetingBack } from "../lib.js";
import { enhanceRich } from "../rich.js";
import { ico } from "../icons.js";

// 今の日本時間を5分単位に切り下げたもの
const nowRounded = () => { const now = Date.now(); return jstDateTime(now - (now % (5 * 60 * 1000))); };

// MTGを始める → その他のMTG
export async function renderOtherStart(el) {
  const { categories, groups } = await api("/api/other-groups");
  const draw = (cat) => {
    const list = groups.filter((g) => g.category === cat?.key);
    el.innerHTML = `
      <nav class="breadcrumb"><a href="#/start">MTGを始める</a> / その他のMTG</nav>
      <div class="page-heading left"><h1>${ico("talk")} ${cat ? `${esc(cat.label)}：どのプロジェクトのMTGですか？` : "どのカテゴリーのMTGですか？"}</h1></div>
      ${cat ? `
        ${list.length ? `<ul class="pick-list">${list.map((g) => pickItem({ attrs: `data-group="${g.id}"`, name: g.name,
          note: g.last_at ? `<span class="muted small">前回 ${fmtDate(g.last_at.slice(0, 10))}</span>` : "" })).join("")}</ul>`
          : `<p class="muted">まだプロジェクトはありません。下で新しく作ります。</p>`}
        <form class="card form" id="new-group" style="margin-top:12px">
          <label>${ico("folder")} 新しいプロジェクトを作る
            <input name="name" maxlength="60" required placeholder="例：〇〇との勉強会"></label>
          <small class="muted">Notionの「${esc(cat.label)}」ページの「プロジェクト」欄に、このプロジェクトのページができます。次からはここから選べます。</small>
          <div class="form-actions">${categories.length > 1 ? `<button type="button" data-back>← カテゴリーを選び直す</button>` : ""}<button class="primary">作ってMTGを始める</button></div>
        </form>`
      : `<ul class="pick-list">${categories.map((c) => pickItem({ attrs: `data-cat="${c.key}"`, name: c.label })).join("")}</ul>`}`;
    el.querySelectorAll("[data-cat]").forEach((b) => b.addEventListener("click", () => draw(categories.find((c) => c.key === b.dataset.cat))));
    el.querySelector("[data-back]")?.addEventListener("click", () => draw(null));
    el.querySelectorAll("[data-group]").forEach((b) => b.addEventListener("click", async () => {
      const g = groups.find((x) => x.id === Number(b.dataset.group));
      if (!await confirmDialog(`「${g.name}」のMTGを始めますか？`, { ok: "MTGを始める" })) return;
      busy(b, () => start(g.id)).catch(() => {});
    }));
    el.querySelector("#new-group")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = e.target.name.value.trim();
      busy(e.submitter, async () => {
        const { id } = await api("/api/other-groups", { method: "POST", body: { category: cat.key, name } });
        await start(id);
      }).catch(() => {});
    });
  };
  const start = async (groupId) => {
    const { id } = await api(`/api/other-groups/${groupId}/meetings`, { method: "POST", body: { starts_at: nowRounded() } });
    location.hash = `#/other-meetings/${id}?start=1`;
  };
  // カテゴリーが1つだけのあいだは、選ぶ手間をはぶく
  draw(categories.length === 1 ? categories[0] : null);
}

// その他のMTGの議事録（start=1 のときだけタイマーと「MTGを終える」）
export async function renderOtherMeeting(el, id) {
  const inMeeting = hashQuery().get("start") === "1";
  const { meeting: m, canDelete } = await api(`/api/other-meetings/${id}`);
  let version = m.version;
  let base = m.body;
  let sync = false;
  el.innerHTML = `
    <nav class="breadcrumb"><a href="#/other-meetings">その他のMTG</a> / ${esc(m.group_name)}</nav>
    <div class="page-heading left"><h1>${ico("talk")} ${esc(m.group_name)}</h1>
      <p>${esc(m.category_label)}・${fmtDateTime(m.starts_at)}のMTG${m.notion_url ? `・<a href="${esc(m.notion_url)}" target="_blank" rel="noopener">Notionで開く</a>` : ""}</p></div>
    ${inMeeting ? timerHtml(`other-${m.id}`, { bar: true }) : ""}
    <form class="minutes" id="other-form">
      <section class="card"><div class="section-head"><h2>議事録</h2></div>
        <textarea name="body" data-rich rows="12" maxlength="50000" aria-label="議事録">${esc(m.body)}</textarea></section>
      <div class="form-actions sticky">
        ${m.updated_at && m.updated_by_name ? `<span class="muted small">最終更新：${esc(m.updated_by_name)}・${fmtDateTime(jstDateTime(m.updated_at))}</span>` : ""}
        <span class="muted small auto-status" id="auto-status">自動で保存されます</span>
        ${inMeeting ? `<button type="button" class="primary" data-end>MTGを終える</button>` : `<button class="primary">保存する</button>`}
      </div>
    </form>`;
  if (canDelete) el.insertAdjacentHTML("beforeend", `<p class="danger-zone"><button type="button" class="link-btn danger" id="delete-other">${ico("trash")} このMTGを削除する</button></p>`);
  enhanceRich(el);
  if (inMeeting) bindTimer(el, `other-${m.id}`, { auto: true });
  el.querySelector("#delete-other")?.addEventListener("click", async (e) => {
    if (!await confirmDialog(`${m.group_name}の${fmtDateTime(m.starts_at)}のMTGを削除しますか？\n\n議事録も消え、ツールからは元に戻せません（Notionの議事録ページは、Notionのゴミ箱に移ります）。`, { ok: "削除する" })) return;
    busy(e.currentTarget, () => api(`/api/other-meetings/${m.id}`, { method: "DELETE", body: {} }))
      .then(() => { markSaved(form); toast("削除しました"); location.hash = "#/other-meetings"; }).catch(() => {});
  });
  const form = el.querySelector("#other-form");
  guardForm(form);
  let end = false;
  const put = () => api(`/api/other-meetings/${m.id}`, { method: "PUT", body: { body: form.body.value, version, sync, end } });
  const saveNow = () => put()
    .catch(async (err) => {
      if (!/他の人が更新/.test(err.message)) throw err;
      // ほかの人も同時に書いていた：相手の変更を取り込んで、もう一度保存する
      const { meeting: latest } = await api(`/api/other-meetings/${m.id}`);
      const r = mergeText(base, form.body.value, latest.body);
      form.body.value = r.text;
      version = latest.version;
      if (r.both) toast("ほかの人も同じ議事録を書いていたので、両方の内容を残しました。確認してください");
      return put();
    })
    .then((res) => { version = res.version; base = form.body.value; return res; });
  const auto = autoSave(form, saveNow, { status: el.querySelector("#auto-status"), key: `other:${m.id}`, label: "議事録" });
  if (inMeeting) guardMeetingBack(async () => { if (auto.pending()) await auto.flush(); await saveNow(); });
  const finish = async (button, ending, done) => {
    if (auto.pending()) await auto.flush();
    busy(button, () => { sync = true; end = ending; return saveNow().finally(() => { sync = false; end = false; }); })
      .then(() => { markSaved(form); done(); }).catch(() => {});
  };
  form.addEventListener("submit", (e) => { e.preventDefault(); finish(e.submitter, false, () => toast("保存しました。Notionにも入ります")); });
  form.querySelector("[data-end]")?.addEventListener("click", async (e) => {
    if (!await confirmDialog("MTGを終えますか？\n\n議事録は、Notionのこのプロジェクトのページにも入ります。", { ok: "MTGを終える" })) return;
    finish(e.currentTarget, true, () => { toast("MTGを終えました"); location.hash = `#/other-meetings/${m.id}`; });
  });
}

// 確認する → その他のMTG：これまでのMTGの議事録
export async function renderOtherList(el) {
  const { meetings } = await api("/api/other-meetings");
  el.innerHTML = `
    <nav class="breadcrumb"><a href="#/check">確認する</a> / その他のMTG</nav>
    <div class="page-heading left"><h1>${ico("talk")} その他のMTG</h1><p>PJ・定例以外のMTGの議事録です。新しく始めるときは「ミーティングを始める」→「その他のMTG」。</p></div>
    ${meetings.length ? `<ul class="list">${meetings.map((m) => `
      <li class="list-item"><span><a href="#/other-meetings/${m.id}"><strong>${esc(m.group_name)}</strong></a>
        <span class="muted small">${fmtDateTime(m.starts_at)}${m.has_minutes ? "" : "・議事録なし"}</span></span>
        <div class="meta"><a class="button small" href="#/other-meetings/${m.id}?start=1">${ico("play")} 続きを書く</a></div></li>`).join("")}</ul>`
      : `<div class="empty"><p>まだその他のMTGはありません。</p></div>`}`;
}
