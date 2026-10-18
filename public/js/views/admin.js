// 管理者メニュー：管理者ができることの一覧、人事（PJの配属）、ログイン状況、管理者の追加・削除
import { api, esc, state, avatar, busy, toast, fmtDateTime, jstDateTime, confirmDialog } from "../lib.js";
import { ico } from "../icons.js";

export async function renderAdmin(el) {
  if (!state.me.isAdmin) throw new Error("管理者メニューは管理者だけが使えます");
  const data = await api("/api/admin");
  // 部門長・代表：管理者メニューで選ぶ（設定ファイルに書いた人は「固定」として出し、ここでは外せない）
  const roleData = {
    heads: { fixed: data.heads, added: data.addedHeads || [] },
    reps: { fixed: data.reps, added: data.addedReps || [] },
  };
  const roleBlock = (kind, label, note) => {
    const { fixed, added } = roleData[kind];
    const has = new Set([...fixed.map((u) => u.id), ...added.map((r) => r.user_id)]);
    return `<h3 class="small">${label}</h3>
      <ul class="list">
        ${fixed.map((u) => `<li class="list-item">${person(u)}<span class="tag">${label}（固定）</span></li>`).join("")}
        ${added.map((r) => `
          <li class="list-item">${person({ name: r.name, avatar: r.avatar })}
            <div class="meta"><span class="tag">${label}</span>${r.added_by_name ? `<span class="muted small">${esc(r.added_by_name)}が追加</span>` : ""}
              <button class="link-btn danger" data-remove-role="${kind}" data-user="${esc(r.user_id)}" data-name="${esc(r.name)}">外す</button></div></li>`).join("")}
        ${has.size ? "" : `<li class="list-item muted">まだいません</li>`}
      </ul>
      <form class="card form inline-form" data-add-role="${kind}" style="margin:8px 0 4px">
        <strong>${label}を選ぶ</strong>
        <select name="user_id" required>
          <option value="">メンバーを選ぶ</option>
          ${data.users.filter((u) => !has.has(u.id)).map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join("")}
        </select>
        <button class="primary">追加する</button>
      </form>
      <p class="muted small">${note}</p>`;
  };
  const adminIds = new Set([...data.heads, ...data.fixedAdmins].map((u) => u.id).concat(data.admins.map((a) => a.user_id), (data.addedHeads || []).map((r) => r.user_id)));
  const candidates = data.users.filter((u) => !adminIds.has(u.id));
  const person = (u) => `<span class="person">${avatar(u)} ${esc(u.name)}</span>`;
  const ok = (v, label) => `<li>${ico(v ? "check" : "warning")} ${label}${v ? "" : "：未設定"}</li>`;

  el.innerHTML = `
    <div class="page-heading"><h1>${ico("tools")} 管理者メニュー</h1></div>

    <details class="section admin-help">
      <summary><strong>管理者ができること</strong></summary>
      <div class="card-grid admin-grid">
        <a class="card admin-card" href="#/seeds">
          <strong>${ico("sprout")} PJ決め</strong>
          <ul>
            <li>PJ決めの作成・締め切り・決めるPJの数の設定</li>
            <li>種の出どころ（ニュース勉強会など）の設定、どの種でも編集・削除</li>
            <li>締め切り前でも開票結果を見る</li>
            <li><strong>決まった種を「正式なPJにする」</strong>（種のカードのボタンから。メンバーもここで決める）</li>
          </ul>
        </a>
        <a class="card admin-card" href="#/projects">
          <strong>${ico("folder")} PJ</strong>
          <ul>
            <li>メンバーでないPJも編集できる（工程・タスク・MTG・議事録）</li>
            <li>PJのアーカイブ（PJの「編集」→ 状態）</li>
            <li>「ミーティングを始める」に全PJが出る</li>
          </ul>
        </a>
        <a class="card admin-card" href="#/hearings">
          <strong>${ico("handshake")} 外部ヒアリング</strong>
          <ul>
            <li>承認は、管理者ではなく部門長 → 代表が行う</li>
            <li>部門長・代表は設定ファイル（wrangler.toml）で決まっている</li>
            <li>見られるのは、政策立案部門のロールを持つ人・代表・管理者だけ</li>
          </ul>
        </a>
      </div>
    </details>

    ${staffingSection(data, person)}
    ${loginSection(data, person, adminIds)}
    ${errorSection(data.errors || [])}

    <section class="section">
      <h2>管理者</h2>
      <ul class="list">
        ${data.heads.map((u) => `<li class="list-item">${person(u)}<div class="meta"><span class="tag">部門長（固定）</span></div></li>`).join("")}
        ${(data.addedHeads || []).map((r) => `<li class="list-item">${person({ name: r.name, avatar: r.avatar })}<div class="meta"><span class="tag">部門長</span></div></li>`).join("")}
        ${data.fixedAdmins.map((u) => `<li class="list-item">${person(u)}<div class="meta"><span class="tag">固定</span></div></li>`).join("")}
        ${data.admins.map((a) => `
          <li class="list-item">${person({ name: a.name, avatar: a.avatar })}
            <div class="meta"><span class="muted small">${a.added_by_name ? `${esc(a.added_by_name)}が追加` : ""}</span>
              <button class="link-btn danger" data-remove="${esc(a.user_id)}">${a.user_id === state.me.id ? "自分を外す" : "外す"}</button></div></li>`).join("")}
      </ul>
      <form class="card form inline-form" id="add-admin" style="margin-top:12px">
        <strong>管理者を追加</strong>
        <select name="user_id" required>
          <option value="">メンバーを選ぶ</option>
          ${candidates.map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join("")}
        </select>
        <button class="primary">追加する</button>
      </form>
      <p class="muted small">選べるのは、このツールに一度ログインした人と、希望PJアンケートで投票した人です。部門長・副部門長など設定ファイルで決まっている管理者（「固定」と表示）は、ここでは外せません。</p>
    </section>

    <div class="two-col">
      <section class="section">
        <h2>部門長・代表</h2>
        ${roleBlock("heads", "部門長", "外部ヒアリング申請の一次確認をします。管理者を兼ねます（最後の1人は外せません）")}
        ${roleBlock("reps", "代表", "外部ヒアリング申請の最終確認をし、申請の一覧を見られます")}
      </section>
      <section class="section">
        <h2>設定の状態</h2>
        <ul class="settings-list">
          <li>${ico("check")} ログイン：学生チームのDiscordサーバー（${esc(data.settings.guild)}）のメンバー全員</li>
          ${ok(data.settings.deptRole, "政策立案部門のロール（外部ヒアリングを見られる人の判定）")}
          ${ok(data.settings.bot, "Bot（DM通知）")}
          ${ok(data.settings.forum, "渉外フォーラム（ヒアリングのスレッド作成）")}
          ${ok(data.settings.notion, "Notion連携（MTG・定例の議事録をNotionに入れる）")}
        </ul>
        <p><button type="button" class="small" id="notion-check">${ico("search")} Notionにつながるか確かめる（その他のページ・定例の議事録）</button></p>
        <div id="notion-check-result"></div>
        <div id="notion-backfill"></div>
        ${data.archived.length ? `<h3 class="small">アーカイブしたPJ</h3><ul class="settings-list">${data.archived.map((p) =>
          `<li><a href="#/projects/${p.id}">${esc(p.name)}</a>（PJの「編集」→ 状態で戻せます）</li>`).join("")}</ul>` : ""}
      </section>
    </div>`;

  el.insertAdjacentHTML("beforeend", `
    <details class="section" id="accounts">
      <summary><h2 style="display:inline">${ico("link")} メンバーのアカウント</h2> <small class="muted">Discord ↔ Google・Notion</small></summary>
      <div id="accounts-body"><p class="muted">読み込み中…</p></div>
    </details>`);
  el.querySelector("#accounts").addEventListener("toggle", (e) => { if (e.target.open && !e.target.dataset.loaded) loadAccounts(el.querySelector("#accounts-body"), person); e.target.dataset.loaded = "1"; });
  el.insertAdjacentHTML("beforeend", `
    <details class="section" id="discord-hooks">
      <summary><h2 style="display:inline">${ico("megaphone")} Discordの投稿先</h2> <small class="muted">PJごとのウェブフックとスレッド</small></summary>
      <div id="discord-hooks-body"><p class="muted">読み込み中…</p></div>
    </details>`);
  el.querySelector("#discord-hooks").addEventListener("toggle", (e) => { if (e.target.open && !e.target.dataset.loaded) loadDiscordHooks(el.querySelector("#discord-hooks-body")); e.target.dataset.loaded = "1"; });
  bindNotionBackfill(el.querySelector("#notion-backfill"));
  // その他のMTGの議事録を入れるNotionのページに、ツール（インテグレーション）が入れるか
  el.querySelector("#notion-check").addEventListener("click", (e) => busy(e.currentTarget, () => api("/api/admin/notion-check"))
    .then((r) => {
      el.querySelector("#notion-check-result").innerHTML = r.results
        ? `<ul class="settings-list">${r.results.map((x) => `<li>${x.ok ? ico("check") : "⚠"} ${esc(x.label)}：${esc(x.message)}</li>`).join("")}</ul>`
        : `<p class="small">⚠ ${esc(r.message)}</p>`;
    }).catch(() => {}));
  bindStaffing(el, data, () => renderAdmin(el));
  const ROLE_LABEL = { heads: "部門長", reps: "代表" };
  const ROLE_NOTE = {
    heads: "外部ヒアリング申請の一次確認と、管理者メニュー（PJ決めの運営・全PJの編集など）が使えるようになります。",
    reps: "外部ヒアリング申請の最終確認と、申請の一覧の閲覧ができるようになります。",
  };
  el.querySelectorAll("[data-add-role]").forEach((f) => f.addEventListener("submit", (e) => {
    e.preventDefault();
    const kind = f.dataset.addRole;
    const userId = f.user_id.value;
    const name = data.users.find((u) => u.id === userId)?.name || "";
    confirmDialog(`${name}さんを${ROLE_LABEL[kind]}にしますか？
${ROLE_NOTE[kind]}`, { ok: `${ROLE_LABEL[kind]}にする` }).then((ok) => {
      if (!ok) return;
      busy(e.submitter, () => api(`/api/admin/${kind}`, { method: "POST", body: { user_id: userId } }))
        .then(() => { toast(`${ROLE_LABEL[kind]}に追加しました`); renderAdmin(el); }).catch(() => {});
    });
  }));
  el.querySelectorAll("[data-remove-role]").forEach((b) => b.addEventListener("click", async () => {
    const kind = b.dataset.removeRole;
    const self = kind === "heads" && b.dataset.user === state.me.id;
    if (!await confirmDialog(`${b.dataset.name}さんを${ROLE_LABEL[kind]}から外しますか？${self ? "\n自分を外すと、ほかに管理者の役割がなければ、このページは使えなくなります。" : ""}`)) return;
    busy(b, () => api(`/api/admin/${kind}/remove`, { method: "POST", body: { user_id: b.dataset.user } }))
      .then(() => {
        toast(`${ROLE_LABEL[kind]}から外しました`);
        if (self) { location.hash = "#/"; location.reload(); } else renderAdmin(el);
      }).catch(() => {});
  }));
  el.querySelector("#add-admin").addEventListener("submit", (e) => {
    e.preventDefault();
    const userId = e.target.user_id.value;
    busy(e.submitter, () => api("/api/admin/admins", { method: "POST", body: { user_id: userId } }))
      .then(() => { toast("管理者に追加しました"); renderAdmin(el); }).catch(() => {});
  });
  el.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", async () => {
    const self = b.dataset.remove === state.me.id;
    if (!await confirmDialog(self ? "自分を管理者から外しますか？このページは使えなくなります。" : "この人を管理者から外しますか？")) return;
    busy(b, () => api("/api/admin/admins/remove", { method: "POST", body: { user_id: b.dataset.remove } }))
      .then(() => {
        toast("管理者から外しました");
        if (!self) return renderAdmin(el);
        location.hash = "#/";
        location.reload(); // 権限が変わったので読み込み直す
      }).catch(() => {});
  }));
}

// これまでの議事録をNotionへ：Notionをつなぐ前に書いた議事録（まだNotionに入っていないもの）を、まとめて入れる
async function bindNotionBackfill(box) {
  const c = await api("/api/admin/notion-backfill").catch(() => null);
  if (!c) return;
  const left = c.meetings + c.teirei;
  if (!c.notion) {
    box.innerHTML = left ? `<p class="muted small">Notionをつなぐと、これまでの議事録（MTG ${c.meetings}件・定例 ${c.teirei}件）をまとめて入れられます。</p>` : "";
    return;
  }
  if (!left) { box.innerHTML = `<p class="muted small">${ico("check")} これまでの議事録は、すべてNotionに入っています。</p>`; return; }
  box.innerHTML = `<p class="small">Notionにまだ入っていない議事録：MTG ${c.meetings}件・定例 ${c.teirei}件</p>
    <button type="button" class="primary small" id="backfill-run">これまでの議事録をNotionに入れる</button>`;
  box.querySelector("#backfill-run").addEventListener("click", async (e) => {
    if (!await confirmDialog(`まだNotionに入っていない議事録（MTG ${c.meetings}件・定例 ${c.teirei}件）を、Notionに入れますか？\nMTGはPJのNotionページの下に、定例は部門の「議事録」に入ります。すでにNotionにあるものは二重に作りません。`, { ok: "Notionに入れる" })) return;
    const button = e.currentTarget;
    button.disabled = true;
    let total = 0;
    try {
      for (let i = 0; i < 50; i++) {
        const r = await api("/api/admin/notion-backfill", { method: "POST", body: {} });
        total += r.done;
        button.textContent = `入れています…（${total}件）`;
        if (r.failed.length) { toast(`入れられなかったもの：${r.failed.join("、")}`, "error"); break; }
        if (!r.meetings && !r.teirei) break;
      }
      toast(`${total}件をNotionに入れました`);
    } finally {
      bindNotionBackfill(box);
    }
  });
}

// Discordの投稿先：PJごとに、ウェブフックのURL（パスワードと同じ扱い。登録したら画面には出さない）と、いつもの投稿先のスレッドID
// アンケート・日程調整の「📣 Discordに投稿」で、このスレッドに1回投稿し、回答のたびに同じメッセージを書き直す（新しいスレッドは作らない）
async function loadDiscordHooks(box) {
  const d = await api("/api/admin/discord-hooks");
  box.innerHTML = `
    <p class="muted small">ウェブフックは、PJのDiscordチャンネルの「⚙ チャンネルの編集 → 連携サービス → ウェブフック」で作り、「ウェブフックURLをコピー」したものを貼ります。
      スレッドIDは、そのチャンネルの中の既存のスレッド（スレッドを右クリック →「IDをコピー」、またはスレッドのリンク）です。新しいスレッドは作りません。
      ウェブフックのURLは、登録すると画面には出しません（変えるときは貼り直します）。</p>
    <div class="row-left" style="margin:8px 0 12px">
      <input type="password" autocomplete="off" id="hook-all" placeholder="https://discord.com/api/webhooks/…" aria-label="全PJに登録するウェブフックのURL" style="flex:1;min-width:220px">
      <button type="button" class="small primary" id="hook-all-save">全PJに同じウェブフックを登録</button>
    </div>
    <p class="muted small" style="margin-top:-6px">全PJのスレッドが同じフォーラム（チャンネル）にあるときは、ウェブフックは1つで足ります。スレッドIDはPJごとのものがそのまま使われます。</p>
    <div class="table-wrap"><table class="accounts discord-hooks">
      <thead><tr><th>PJ</th><th>ウェブフック</th><th>スレッドID</th><th></th></tr></thead>
      <tbody>${d.projects.map((p) => `<tr data-pj="${p.id}">
        <td>${esc(p.name)}</td>
        <td><input type="password" autocomplete="off" data-k="webhook_url" placeholder="${p.has_webhook ? "✓ 登録済み（変えるときだけ貼る）" : "https://discord.com/api/webhooks/…"}" aria-label="${esc(p.name)}のウェブフックのURL">
          ${p.has_webhook ? `<button type="button" class="link-btn danger small" data-remove>外す</button>` : ""}</td>
        <td><input data-k="thread_id" inputmode="numeric" value="${esc(p.thread_id)}" placeholder="例：1559199970996002968" aria-label="${esc(p.name)}のスレッドID"></td>
        <td><button type="button" class="small primary" data-save>保存</button></td>
      </tr>`).join("")}</tbody>
    </table></div>`;
  box.querySelector("#hook-all-save").addEventListener("click", async (e) => {
    const url = box.querySelector("#hook-all").value.trim();
    if (!url) return toast("ウェブフックのURLを貼ってください", "error");
    if (!await confirmDialog(`このウェブフックを、${d.projects.length}つのPJすべてに登録しますか？\n（スレッドIDはPJごとのものを使います）`, { ok: "全PJに登録" })) return;
    busy(e.currentTarget, async () => {
      for (const pj of d.projects) await api(`/api/admin/discord-hooks/${pj.id}`, { method: "PUT", body: { webhook_url: url } });
    }).then(() => { toast("全PJに登録しました"); loadDiscordHooks(box); }).catch(() => {});
  });
  box.querySelectorAll("tr[data-pj]").forEach((tr) => {
    const save = (b, extra = {}) => busy(b, () => api(`/api/admin/discord-hooks/${tr.dataset.pj}`, {
      method: "PUT", body: { webhook_url: tr.querySelector("[data-k=webhook_url]").value, thread_id: tr.querySelector("[data-k=thread_id]").value, ...extra },
    })).then(() => { toast("保存しました"); loadDiscordHooks(box); }).catch(() => {});
    tr.querySelector("[data-save]").addEventListener("click", (e) => save(e.currentTarget));
    tr.querySelector("[data-remove]")?.addEventListener("click", async (e) => {
      if (!await confirmDialog("このPJのウェブフックを外しますか？\nこれまでの投稿は、書き直されなくなります。", { ok: "外す" })) return;
      save(e.currentTarget, { remove_webhook: true, webhook_url: "" });
    });
  });
}

// メンバーのアカウント：Discordのアカウントごとに、Googleアカウント（打ち込み）とNotionアカウント（Notionのメンバーから選ぶ）
// Notionアカウントを対応づけておくと、PJ決めでPJを作ったとき、NotionのPJページの参加者に自動で入る
async function loadAccounts(box, person) {
  const d = await api("/api/admin/accounts");
  const options = (sel) => `<option value="">（選ばない）</option>${d.notionUsers.map((n) => `<option value="${esc(n.id)}" ${n.id === sel ? "selected" : ""}>${esc(n.name)}</option>`).join("")}`;
  box.innerHTML = `
    <p class="muted small">Googleアカウントは打ち込み、Notionアカウントは、学生チームのNotionのメンバーと、NotionのPJページ・議事録の「人」の欄に入っている人から選びます（いない人は、NotionのPJページの参加者に一度入れると出てきます）。変えるとすぐ保存されます。見られるのは管理者だけです。</p>
    ${!d.notion ? `<p class="caution small">${ico("warning")} Notion連携（NOTION_TOKEN）がまだなので、Notionアカウントは選べません。</p>` : d.notionError ? `<p class="caution small">${ico("warning")} ${esc(d.notionError)}</p>` : ""}
    <div class="table-wrap"><table class="accounts">
      <thead><tr><th>Discord</th><th>Googleアカウント</th><th>Notionアカウント</th></tr></thead>
      <tbody>${d.users.map((u) => `<tr data-user="${esc(u.id)}">
        <td>${person(u)}</td>
        <td><input type="email" data-k="google_email" value="${esc(u.google_email)}" placeholder="name@gmail.com" aria-label="${esc(u.name)}さんのGoogleアカウント"></td>
        <td>${d.notionUsers.length
          ? `<select data-k="notion_user_id" aria-label="${esc(u.name)}さんのNotionアカウント">${options(u.notion_user_id)}</select>`
          : `<span class="muted small">${esc(u.notion_name) || "—"}</span>`}</td>
      </tr>`).join("")}</tbody>
    </table></div>`;
  const save = (tr) => {
    const sel = tr.querySelector("select");
    const body = {
      user_id: tr.dataset.user,
      google_email: tr.querySelector("[data-k=google_email]").value,
      notion_user_id: sel ? sel.value : d.users.find((u) => u.id === tr.dataset.user)?.notion_user_id || "",
      notion_name: sel ? sel.selectedOptions[0]?.textContent || "" : d.users.find((u) => u.id === tr.dataset.user)?.notion_name || "",
    };
    api("/api/admin/accounts", { method: "PUT", body }).then(() => toast("保存しました")).catch(() => {});
  };
  box.querySelectorAll("tr[data-user] input, tr[data-user] select").forEach((x) => x.addEventListener("change", () => save(x.closest("tr"))));
}

// 人事：どのPJに誰が配属されているか（進行中・完了。アーカイブは除く）と、進行中のPJに入っていない人
function staffingSection({ projects, users }, person) {
  const byId = Object.fromEntries(users.map((u) => [u.id, u]));
  const stageName = (p) => state.types[p.type]?.stages.find((s) => s.no === p.current_stage)?.name || "";
  const active = projects.filter((p) => p.status === "active");
  const assigned = new Set(active.flatMap((p) => p.members));
  const logged = users.filter((u) => u.last_login);
  const unassigned = logged.filter((u) => !assigned.has(u.id));
  const option = (v, l) => `<option value="${esc(v)}">${esc(l)}</option>`;
  return `
    <section class="section">
      <h2>${ico("puzzle")} 人事（PJの配属）</h2>
      ${active.length ? `<details class="add-box staff-move-box"><summary class="button small primary">${ico("shuffle")} 異動</summary>
      <form class="card form staff-move" id="staff-move">
        <select name="user_id" required aria-label="誰を"><option value="">誰を</option>${logged.map((u) => option(u.id, u.name)).join("")}</select>
        <select name="from_project_id" aria-label="どこから"><option value="">どこから（なし＝追加だけ）</option></select>
        <select name="to_project_id" aria-label="どこへ"><option value="">どこへ（なし＝外すだけ）</option>${active.map((p) => option(p.id, p.name)).join("")}</select>
        <button class="primary">異動する</button>
      </form></details>` : ""}
      ${projects.length ? `<div class="table-wrap"><table class="staff-table">
        <thead><tr><th>PJ</th><th>工程</th><th>メンバー</th></tr></thead>
        <tbody>${projects.map((p) => `
          <tr class="${p.status === "done" ? "is-done" : ""}">
            <td><a href="#/projects/${p.id}">${esc(p.name)}</a></td>
            <td class="small">${p.status === "done" ? "完了" : `工程${p.current_stage}・${esc(stageName(p))}`}</td>
            <td><span class="staff-members">${p.members.map((id) => `<span class="staff-chip">${person(byId[id] || { name: "（不明）" })}
                ${p.status === "active" ? `<button type="button" class="link-btn danger" data-unassign="${p.id}" data-user="${esc(id)}" aria-label="${esc(byId[id]?.name || "")}を外す">×</button>` : ""}</span>`).join("")
                || `<span class="muted small">まだいません</span>`}
              ${p.status === "active" ? `<select class="staff-add" data-assign="${p.id}" aria-label="メンバーを追加">
                <option value="">＋ 追加</option>${logged.filter((u) => !p.members.includes(u.id)).map((u) => option(u.id, u.name)).join("")}</select>` : ""}</span>
              <span class="muted small">${p.members.length}人</span></td>
          </tr>`).join("")}</tbody></table></div>`
        : `<p class="muted">まだPJはありません。</p>`}
      <p class="small" style="margin-top:12px"><strong>進行中のPJに入っていない人</strong>（ログイン済み・${unassigned.length}人）</p>
      ${unassigned.length ? `<p class="staff-members">${unassigned.map(person).join("")}</p>` : `<p class="muted small">全員がどれかのPJに入っています。</p>`}
    </section>`;
}

// 人事：異動フォーム・表の「×」（外す）・「＋ 追加」
function bindStaffing(el, data, reload) {
  const move = (body, message) => api("/api/admin/staffing", { method: "POST", body }).then(() => { toast(message); reload(); });
  const name = (id) => data.users.find((u) => u.id === id)?.name || "";
  const pj = (id) => data.projects.find((p) => p.id === Number(id))?.name || "";
  const form = el.querySelector("#staff-move");
  if (form) {
    // 「誰を」を選ぶと、「どこから」にその人がいま入っているPJが出る
    form.user_id.addEventListener("change", () => {
      const mine = data.projects.filter((p) => p.status === "active" && p.members.includes(form.user_id.value));
      form.from_project_id.innerHTML = `<option value="">どこから（なし＝追加だけ）</option>${mine.map((p) =>
        `<option value="${p.id}">${esc(p.name)}</option>`).join("")}`;
      if (mine.length === 1) form.from_project_id.value = String(mine[0].id);
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const button = e.submitter;
      const body = { user_id: form.user_id.value, from_project_id: form.from_project_id.value || null, to_project_id: form.to_project_id.value || null };
      if (!body.from_project_id && !body.to_project_id) return toast("異動元か異動先を選んでください", "error");
      const what = body.from_project_id && body.to_project_id ? `「${pj(body.from_project_id)}」から「${pj(body.to_project_id)}」へ異動`
        : body.to_project_id ? `「${pj(body.to_project_id)}」に追加` : `「${pj(body.from_project_id)}」から外す`;
      if (!await confirmDialog(`${name(body.user_id)}さんを${what}しますか？\n${name(body.user_id)}さんにお知らせが届きます。`, { ok: "異動して知らせる" })) return;
      const msg = body.from_project_id && body.to_project_id ? `${name(body.user_id)}さんを「${pj(body.to_project_id)}」に異動しました`
        : body.to_project_id ? `${name(body.user_id)}さんを「${pj(body.to_project_id)}」に追加しました` : `${name(body.user_id)}さんを「${pj(body.from_project_id)}」から外しました`;
      busy(button, () => move(body, msg)).catch(() => {});
    });
  }
  el.querySelectorAll("[data-unassign]").forEach((b) => b.addEventListener("click", async () => {
    if (!await confirmDialog(`${name(b.dataset.user)}さんを「${pj(b.dataset.unassign)}」のメンバーから外しますか？\n${name(b.dataset.user)}さんにお知らせが届きます。`)) return;
    busy(b, () => move({ user_id: b.dataset.user, from_project_id: b.dataset.unassign }, "メンバーから外しました")).catch(() => {});
  }));
  el.querySelectorAll("[data-assign]").forEach((s) => s.addEventListener("change", async () => {
    if (!s.value) return;
    if (!await confirmDialog(`${name(s.value)}さんを「${pj(s.dataset.assign)}」に追加しますか？\n${name(s.value)}さんにお知らせが届きます。`, { ok: "追加して知らせる" })) {
      s.value = "";
      return;
    }
    busy(s, () => move({ user_id: s.value, to_project_id: s.dataset.assign }, `${name(s.value)}さんを「${pj(s.dataset.assign)}」に追加しました`)).catch(() => {});
  }));
}

// ログイン状況：このツールにログインしたことがある人（最終ログイン順）と、アンケートで投票しただけの人
function loginSection({ users, heads, reps, addedReps = [], addedHeads = [] }, person, adminIds) {
  const headIds = new Set([...heads.map((u) => u.id), ...addedHeads.map((r) => r.user_id)]);
  const repIds = new Set([...reps.map((u) => u.id), ...addedReps.map((r) => r.user_id)]);
  const logged = users.filter((u) => u.last_login).sort((a, b) => b.last_login - a.last_login);
  const notYet = users.filter((u) => !u.last_login);
  // 設定ファイルで決めている部門長・代表がまだログインしていなければ、ここでも知らせる
  const missingFixed = [...heads, ...reps].filter((u) => !u.last_login);
  const tags = (u) => [
    headIds.has(u.id) && "部門長", repIds.has(u.id) && "代表", adminIds.has(u.id) && !headIds.has(u.id) && "管理者",
    u.is_dept && "部門ロール",
  ].filter(Boolean).map((t) => `<span class="tag">${t}</span>`).join("");
  return `
    <section class="section">
      <h2>${ico("users")} ログイン状況 <small class="muted">ログイン済み ${logged.length}人</small></h2>
      ${logged.length ? `<ul class="list">${logged.map((u) => `
        <li class="list-item">${person(u)}<div class="meta">${tags(u)}<span class="muted small">最終ログイン ${fmtDateTime(jstDateTime(u.last_login))}</span></div></li>`).join("")}</ul>`
        : `<p class="muted">まだ誰もログインしていません。</p>`}
      ${missingFixed.length ? `<p class="caution small">${ico("warning")} まだログインしていない：${missingFixed.map((u) => esc(u.name)).join("、")}（部門長・代表の設定）</p>` : ""}
      ${notYet.length ? `<details class="section" style="margin-top:12px"><summary class="small">希望PJアンケートで投票しただけで、まだログインしていない人（${notYet.length}人）</summary>
        <p class="staff-members" style="margin-top:8px">${notYet.map(person).join("")}</p></details>` : ""}
      <p class="muted small">「部門ロール」は、ログインした時点で政策立案部門のロールを持っていた人です（外部ヒアリングを見られる）。</p>
    </section>`;
}

// エラーの記録：サーバーと画面で起きた想定外のエラー（新しい順に30件）。SENTRY_DSN を入れると Sentry にも送られる
function errorSection(errors) {
  const day = Date.now() - 86400000;
  const recent = errors.filter((e) => e.created_at >= day).length;
  return `
    <details class="section error-logs">
      <summary><strong>${ico("warning")} エラーの記録</strong> <small class="muted">${errors.length ? `直近24時間 ${recent}件・新しい順に${errors.length}件` : "まだありません"}</small></summary>
      ${errors.length ? `<ul class="list">${errors.map((e) => `
        <li class="list-item error-log">
          <span><span class="tag">${e.source === "client" ? "画面" : "サーバー"}</span> <strong>${esc(e.message)}</strong>
            <small class="muted">${fmtDateTime(jstDateTime(e.created_at))}${e.url ? `・${esc(e.url)}` : ""}${e.user_name ? `・${esc(e.user_name)}` : ""}</small></span>
          ${e.stack ? `<details><summary class="small">詳しく</summary><pre class="small">${esc(e.stack)}</pre></details>` : ""}
        </li>`).join("")}</ul>` : `<p class="muted small">エラーは記録されていません。</p>`}
      <p class="muted small">シークレット SENTRY_DSN を入れると、Sentry（アクションボードと同じ監視サービス）にも送られます。</p>
    </details>`;
}
