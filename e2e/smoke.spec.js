// 主な使い方を、実際の画面で通しで確かめる（テスト用の空のデータベースで動く）
// PJを作る → 臨時のMTGを始める → 議事録を書く（自動保存）→ MTGを終える → 記録タブ・議事録を探す・タイムラインに出る
import { test, expect } from "@playwright/test";

const stamp = Date.now().toString(36);

// 画面のエラー（想定外のもの）が出たら失敗にする
function watchErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return errors;
}

async function login(page, name = "部門長") {
  await page.goto(`/auth/dev?name=${encodeURIComponent(name)}`);
  await expect(page.locator("#nav")).toBeVisible();
}

// PJを作る：PJ決めに種を出して、「個人PJとして進める」から始める（メンバーは自分だけ。毎回決めるMTG）
async function makeProject(page, name) {
  await page.goto("/#/projects");
  await page.locator("[data-seed-box]").first().click();
  await page.fill(".seed-post [name=title]", name);
  await page.locator(".seed-post").getByRole("button", { name: "投稿する" }).click();
  const card = page.locator(".seed-card", { hasText: name });
  await card.locator(".card-menu summary").click();
  await card.getByRole("button", { name: /個人PJとして進める/ }).click();
  await card.getByRole("button", { name: "個人PJとして始める" }).click();
  await confirm(page, "個人PJとして始める");
  await expect(page.locator(".pj-header h1")).toHaveText(name);
}

// 確認画面のボタンを押す
async function confirm(page, label) {
  await page.locator(".dialog").getByRole("button", { name: label }).click();
}

test("ホームとメニュー", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await expect(page.locator(".choice strong")).toHaveText(["ミーティングを始める", "確認する", "発表する", "定例"]);
  await expect(page.locator("#nav a")).toHaveText([/ホーム/, /PJ/, /タイムライン/, /カレンダー/, /マイページ/]);
  for (const hash of ["#/check", "#/me", "#/projects", "#/timeline", "#/calendar", "#/teirei", "#/minutes-search", "#/notices", "#/admin"]) {
    await page.goto(`/${hash}`);
    // 読み込みが終わり、エラーの表示が出ていないこと
    await expect(page.locator("#app > .loading")).toHaveCount(0);
    await expect(page.locator("#app > *").first()).toBeVisible();
    await expect(page.locator("#app > .empty a[href=\"#/\"]")).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test("PJを作ってMTGをし、記録に残る", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const name = `自動テストPJ ${stamp}`;
  const word = `検索語${stamp}`;

  // PJを作る（メンバーは自分だけ。毎回決めるMTG）
  await makeProject(page, name);
  await expect(page.locator(".pj-header h1")).toHaveText(name);

  // PJ画面から臨時のMTGを始める
  await page.locator(".pj-quick").getByRole("link", { name: /MTG/ }).click();
  await page.getByRole("button", { name: /臨時のMTG/ }).click();
  await page.getByRole("button", { name: "この内容で始める" }).click();
  await expect(page.locator("#minutes-form")).toBeVisible();

  // 議事録を書く（自動保存）
  // 議事録の欄は、Notionのように書ける欄（クリックして打つ）
  await page.waitForTimeout(500);
  await page.locator('.rich-editor[data-field="agenda"]').click();
  await page.keyboard.type(`${word}について話す`);
  await expect(page.locator("#live-status")).toContainText("自動で保存しました", { timeout: 10_000 });

  // MTGを終える → PJ画面に戻る
  await page.locator("#end-meeting").click();
  await confirm(page, "MTGを終える");
  // PJ画面に戻り、工程の数直線に「いまの工程 → 次」の進み具合の線が出る
  await expect(page.locator(".pj-header h1")).toHaveText(name);
  await expect(page.locator(".stepper li.is-next")).toHaveCount(1);
  await expect(page.locator(".toast")).toContainText("MTGを終えました");

  // 記録タブに出る
  await page.locator(".tabs").getByRole("tab", { name: "記録" }).click();
  await expect(page.locator(".search-hit").first()).toContainText("MTGの議事録");

  // 議事録を探すで見つかる
  await page.goto(`/#/minutes-search?q=${encodeURIComponent(word)}`);
  await expect(page.locator(".search-hit")).toHaveCount(1);
  await expect(page.locator(".search-hit mark").first()).toHaveText(word);

  // タイムラインに出る
  await page.goto("/#/timeline");
  await expect(page.locator(".timeline")).toContainText(`「${name}」が始まりました`);
  await expect(page.locator(".timeline")).toContainText(`「${name}」のMTGの議事録が書かれました`);
  expect(errors).toEqual([]);
});

// 2026-10-14：保存が一度失敗すると、その欄の自動保存がそれ以降止まり、書いた概要が消えた。二度と起きないことを確かめる
test("議事録は、通信が失敗しても書いた内容が保存される", async ({ page }) => {
  await login(page);
  const name = `保存テストPJ ${stamp}`;
  await makeProject(page, name);
  await page.locator(".pj-quick").getByRole("link", { name: /MTG/ }).click();
  await page.getByRole("button", { name: /臨時のMTG/ }).click();
  await page.getByRole("button", { name: "この内容で始める" }).click();
  await expect(page.locator("#minutes-form")).toBeVisible();
  const meetingUrl = page.url();

  // 最初の3回の保存は通信エラーにする
  let fails = 3;
  await page.route("**/api/meetings/*/minutes", (route) => {
    if (route.request().method() === "PUT" && fails > 0) { fails--; return route.abort(); }
    return route.continue();
  });
  await page.waitForTimeout(500);
  await page.locator('.rich-editor[data-field="summary"]').click();
  await page.keyboard.type("消えてはいけない一行目");
  await expect(page.locator("#live-status")).toContainText("まだ保存できていません", { timeout: 10_000 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("消えてはいけない二行目");
  // 自動でやり直して、保存できる
  await expect(page.locator("#live-status")).toContainText("自動で保存しました", { timeout: 30_000 });
  await page.unroute("**/api/meetings/*/minutes");

  // 開き直しても残っている。履歴にもある
  await page.goto("/#/");
  await page.goto(meetingUrl);
  await expect(page.locator('.rich-editor[data-field="summary"]')).toContainText("消えてはいけない二行目");
  await page.locator("[data-history=summary]").click();
  await expect(page.locator(".history-item").first()).toContainText("消えてはいけない一行目");
});

// 電源が落ちた・アプリが閉じた：送れていない書きかけは端末に残り、開き直すと戻って保存される
test("議事録は、送れないまま閉じても開き直すと戻る", async ({ page }) => {
  await login(page);
  const name = `閉じるテストPJ ${stamp}`;
  await makeProject(page, name);
  await page.locator(".pj-quick").getByRole("link", { name: /MTG/ }).click();
  await page.getByRole("button", { name: /臨時のMTG/ }).click();
  await page.getByRole("button", { name: "この内容で始める" }).click();
  await expect(page.locator("#minutes-form")).toBeVisible();
  const meetingUrl = page.url();

  // 電波がない（閉じるときの送り切りも届かない）
  await page.waitForTimeout(500);
  await page.context().setOffline(true);
  await page.locator('.rich-editor[data-field="summary"]').click();
  await page.keyboard.type("閉じる前に書いた行");
  await expect(page.locator("#live-status")).toContainText("まだ保存できていません", { timeout: 10_000 });
  await expect(page.locator("#save-alert")).toContainText("まだ保存できていません");

  // 強制終了の代わりに、確認を出さずに閉じる。電波が戻ってから開き直す
  const again = await page.context().newPage();
  await page.close({ runBeforeUnload: false });
  await again.context().setOffline(false);
  await again.goto(meetingUrl);
  await expect(again.locator("#live-status")).toContainText("自動で保存しました", { timeout: 15_000 });
  await again.goto("/#/");
  await again.goto(meetingUrl);
  await expect(again.locator('.rich-editor[data-field="summary"]')).toContainText("閉じる前に書いた行");
});

// 2つの画面（2人）が同じMTGの議事録に同時に書く：概要もやることも、どちらの分も消えない
test("議事録は、2人が同時に書いても両方残る", async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await login(a);
  await login(b);
  const name = `同時テストPJ ${stamp}`;
  await makeProject(a, name);
  await a.locator(".pj-quick").getByRole("link", { name: /MTG/ }).click();
  await a.getByRole("button", { name: /臨時のMTG/ }).click();
  await a.getByRole("button", { name: "この内容で始める" }).click();
  await expect(a.locator("#minutes-form")).toBeVisible();
  const url = a.url();
  await b.goto(url);
  await expect(b.locator("#minutes-form")).toBeVisible();
  await a.waitForTimeout(800);

  // 同時に、概要に別々の行を書く
  await a.locator('.rich-editor[data-field="summary"]').click();
  await b.locator('.rich-editor[data-field="summary"]').click();
  await Promise.all([a.keyboard.type("Aさんが書いた行"), b.keyboard.type("Bさんが書いた行")]);
  // 同時に、やることを1つずつ足す
  await Promise.all([a.locator("#add-todo").click(), b.locator("#add-todo").click()]);
  await Promise.all([a.keyboard.type("Aさんのやること"), b.keyboard.type("Bさんのやること")]);
  await expect(a.locator("#live-status")).toContainText("自動で保存しました", { timeout: 15_000 });
  await expect(b.locator("#live-status")).toContainText("自動で保存しました", { timeout: 15_000 });
  await a.waitForTimeout(1500);

  // 開き直すと、どちらの分もある
  await a.goto("/#/");
  await a.goto(url);
  const summary = a.locator('.rich-editor[data-field="summary"]');
  await expect(summary).toContainText("Aさんが書いた行");
  await expect(summary).toContainText("Bさんが書いた行");
  const titles = await a.locator("#todos [data-k=title]").evaluateAll((els) => els.map((e) => e.value));
  expect(titles).toEqual(expect.arrayContaining(["Aさんのやること", "Bさんのやること"]));
});

// Shift+Enter の改行も、保存すると行が分かれたまま残る
test("議事録の Shift+Enter の改行が残る", async ({ page }) => {
  await login(page);
  const name = `改行テストPJ ${stamp}`;
  await makeProject(page, name);
  await page.locator(".pj-quick").getByRole("link", { name: /MTG/ }).click();
  await page.getByRole("button", { name: /臨時のMTG/ }).click();
  await page.getByRole("button", { name: "この内容で始める" }).click();
  await expect(page.locator("#minutes-form")).toBeVisible();
  await page.waitForTimeout(500);
  await page.locator('.rich-editor[data-field="summary"]').click();
  await page.keyboard.type("一行目");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("二行目");
  await expect(page.locator("#live-status")).toContainText("自動で保存しました", { timeout: 10_000 });
  const value = await page.locator("textarea[name=summary]").evaluate((t) => t.value);
  expect(value).toBe("一行目\n二行目");
});

test("🔔でお知らせの枠が開く（ページは移らない）", async ({ page }) => {
  await login(page);
  await page.locator("#bell").click();
  await expect(page.locator(".bell-panel")).toBeVisible();
  await expect(page.locator(".choice").first()).toBeVisible(); // ホームのまま（ページは移らない）
  await page.keyboard.press("Escape");
  await expect(page.locator(".bell-panel")).toHaveCount(0);
});

test("一般のメンバーには管理者メニューが出ない", async ({ page }) => {
  await login(page, `メンバー${stamp}`);
  await expect(page.locator(".home-admin")).toHaveCount(0);
  await page.goto("/#/admin");
  await expect(page.locator("#app")).toContainText("管理者だけ");
});

// 画面の切り替え（ビュー遷移）で「読み込み中…」のまま止まらないこと：開いた最初の画面と、下のメニューでの切り替え
test("開いた画面・メニューの切り替えで、読み込み中のまま止まらない", async ({ page }) => {
  await login(page);
  await page.goto("about:blank");
  await page.goto("/");
  await expect(page.locator(".choice").first()).toBeVisible();
  for (const k of ["projects", "timeline", "calendar", "home", "projects"]) {
    await page.locator(`#nav a[data-nav=${k}]`).click();
    await expect(page.locator(`#nav a[data-nav=${k}]`)).toHaveClass(/is-active/);
    await page.waitForTimeout(700);
    await expect(page.locator("#app > .loading")).toHaveCount(0);
    await expect(page.locator("#app > *").first()).toBeVisible();
  }
});

test("一時中止したPJを、アーカイブ欄からPJ決めに入れ直す", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const name = `中止テストPJ ${stamp}`;
  await makeProject(page, name);
  // PJの編集で「一時中止（アーカイブ）」にする
  await page.goto(page.url().replace(/#\/projects\/(\d+).*/, "#/projects/$1/edit"));
  await page.selectOption("#pj-form [name=status]", "archived");
  await page.getByRole("button", { name: "保存する" }).click();
  await expect(page.locator(".pj-header .stage-pill")).toContainText("一時中止");
  // PJ一覧に「＋ PJを作る」はない。アーカイブ欄に出て、PJ決めに入れられる
  await page.goto("/#/projects");
  await expect(page.getByRole("link", { name: "＋ PJを作る" })).toHaveCount(0);
  await page.getByRole("tab", { name: "アーカイブ" }).click();
  const row = page.locator(".list-item", { hasText: name });
  await row.getByRole("button", { name: /PJ決めのアンケートに入れる/ }).click();
  await confirm(page, "PJ決めに入れる");
  await expect(row).toContainText("PJ決めに入っています");
  // PJ決めの種になっていて、「前のPJ」として記録ごと戻せる
  await page.locator("[data-seed-box]").first().click();
  const card = page.locator(".seed-card", { hasText: name });
  await card.locator(".card-menu summary").click();
  await card.getByRole("button", { name: /個人PJとして進める/ }).click();
  await expect(card.locator("[name=restore]")).toBeChecked();
  expect(errors).toEqual([]);
});

test("定例イベントのMTGと進捗は、どの定例に入れるか選べる", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  // 定例の予定を入れる（毎週月曜 22:00）
  await page.goto("/#/teirei/schedule");
  await expect(page.locator("#schedule-form")).toBeVisible();
  const schedulesBefore = await page.locator("[data-del]").count();
  await page.getByRole("button", { name: "予定に追加" }).click();
  await expect(page.locator(".toast")).toContainText("定例を予定しました");
  // 通知は一覧の再読み込みより先に出る。再描画が終わってから次の画面へ進む。
  await expect(page.locator("[data-del]")).toHaveCount(schedulesBefore + 1);

  // MTGを始める → 定例イベント → ニュース勉強会 → 次の定例
  const word = `勉強会メモ${stamp}`;
  await page.goto("/#/start");
  await page.getByRole("link", { name: /定例イベント/ }).click();
  await page.getByRole("button", { name: /ニュース勉強会/ }).click();
  await page.locator(".pick-list .pick").first().click();
  await expect(page.locator(".timer")).toBeVisible();
  const day = new URL(page.url().replace("#/teirei-event", "x")).searchParams.get("day");
  await page.locator("#event-form .rich-editor").first().click();
  await page.keyboard.type(word);
  await page.getByRole("button", { name: "MTGを終える" }).click();
  await confirm(page, "MTGを終える");
  await expect(page.locator(".toast")).toContainText("MTGを終えました");
  const ev = await page.evaluate((d) => fetch(`/api/dept-event?day=${d}&event=news`).then((r) => r.json()), day);
  expect(ev.text).toContain(word);

  // 進捗を書く：まず定例を選ぶ
  await page.goto("/#/report");
  await expect(page.locator("#app h1")).toContainText("どの定例の進捗");
  await page.locator(".pick-list .pick").first().click();
  await expect(page.locator("#app h1")).toContainText("どのPJの進捗");

  // 選んだ定例に保存した進捗が、その定例を始めた後にも残ることを確認する。
  // 日を指定しない旧APIは別の進行中の定例を指す場合があるため、混ぜない。
  // 旧形式の書き置きの取り込みは test/dept-report.test.js で独立して確認する。
  const saved = await page.evaluate(async (d) => {
    const j = async (u, o) => {
      const r = await fetch(u, o && { method: o.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o.body) });
      if (!r.ok) throw new Error(`${u}: ${r.status}`);
      return r.json();
    };
    const { projects } = await j(`/api/dept-reports?day=${d}`);
    const pid = projects[0].id;
    const { report } = await j(`/api/projects/${pid}/dept-report?day=${d}`);
    await j(`/api/projects/${pid}/dept-report`, { method: "PUT", body: { done: "この日に向けて書いた", next: "", issues: "", version: report.version, day: d } });
    const { id } = await j("/api/dept-meetings", { method: "POST", body: { starts_at: `${d}T22:00` } });
    const { reports, meeting } = await j(`/api/dept-meetings/${id}`);
    return { day: meeting.held_on, done: reports.find((r) => r.project_id === pid)?.done, news: meeting.news };
  }, day);
  expect(saved.day).toBe(day);
  expect(saved.done).toContain("この日に向けて書いた");
  expect(saved.news).toContain(word);
  expect(errors).toEqual([]);
});

test("その他のMTG：プロジェクトを作って議事録を書き、次からは一覧から選べる", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const name = `その他テスト ${stamp}`;
  const word = `その他メモ${stamp}`;
  await page.goto("/#/start");
  await page.getByRole("link", { name: /その他のMTG/ }).click();
  await page.fill("#new-group [name=name]", name);
  await page.getByRole("button", { name: "作ってMTGを始める" }).click();
  await expect(page.locator(".timer")).toBeVisible();
  await page.locator("#other-form .rich-editor").click();
  await page.keyboard.type(word);
  await page.getByRole("button", { name: "MTGを終える" }).click();
  await confirm(page, "MTGを終える");
  await expect(page.locator(".toast")).toContainText("MTGを終えました");
  const id = page.url().match(/other-meetings\/(\d+)/)[1];
  const { meeting } = await page.evaluate((i) => fetch(`/api/other-meetings/${i}`).then((r) => r.json()), id);
  expect(meeting.body).toContain(word);
  expect(meeting.ended_at).toBeTruthy();
  // 次からは、作ったプロジェクトが一覧に出る
  await page.goto("/#/start?kind=other");
  await expect(page.locator(".pick-list")).toContainText(name);
  await page.goto("/#/other-meetings");
  await expect(page.locator(".list")).toContainText(name);
  expect(errors).toEqual([]);
});

test("意見交換会：PJを選んで、話したことをメモすると、そのPJの記録に議事録として残る", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const name = `意見交換テストPJ ${stamp}`;
  await makeProject(page, name);
  const word = `出た意見${stamp}`;
  await page.goto("/#/start?kind=event");
  await page.getByRole("button", { name: /意見交換会/ }).click();
  await page.locator(".pick", { hasText: name }).click();
  await confirm(page, "始める");
  await expect(page.locator("#app h1")).toContainText("意見交換会");
  await expect(page.locator(".memo-doc")).toBeVisible();
  await expect(page.locator('.rich-editor[data-field="agenda"]')).toBeHidden();
  await page.locator('.rich-editor[data-field="summary"]').click();
  await page.keyboard.type(word);
  await page.getByRole("button", { name: "MTGを終える" }).click();
  await confirm(page, "MTGを終える");
  await expect(page).toHaveURL(/tab=records/);
  await expect(page.locator(".search-results")).toContainText("意見交換会の議事録");
  await expect(page.locator(".search-results")).toContainText(word);
  expect(errors).toEqual([]);
});

test("意見交換会：PJのメンバーでない人も、議事録を書いて終えられる", async ({ browser }) => {
  const a = await browser.newPage();
  const b = await browser.newPage();
  const errors = watchErrors(b);
  await login(a);
  const name = `交換会メンバー外PJ ${stamp}`;
  await makeProject(a, name);
  await login(b, `ほかの人${stamp}`);
  await b.goto("/#/start?kind=event");
  await b.getByRole("button", { name: /意見交換会/ }).click();
  await b.locator("details.pick-others summary").click();
  await b.locator(".pick", { hasText: name }).click();
  await confirm(b, "始める");
  await b.locator('.rich-editor[data-field="summary"]').click();
  await b.keyboard.type("メンバー外の意見");
  await b.getByRole("button", { name: "MTGを終える" }).click();
  await confirm(b, "MTGを終える");
  await expect(b).toHaveURL(/tab=records/);
  await expect(b.locator(".search-results")).toContainText("メンバー外の意見");
  expect(errors).toEqual([]);
});

test("MTG中に「戻る」を押すと、一時保存して戻るか確かめる", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const name = `戻るテストPJ ${stamp}`;
  await makeProject(page, name);
  await page.locator(".pj-quick").getByRole("link", { name: /MTG/ }).click();
  await page.getByRole("button", { name: /臨時のMTG/ }).click();
  await page.getByRole("button", { name: "この内容で始める" }).click();
  await expect(page.locator("#minutes-form")).toBeVisible();
  const id = page.url().match(/meetings\/(\d+)/)[1];
  await page.locator('.rich-editor[data-field="summary"]').click();
  await page.keyboard.type("戻る前に書いた");
  // キャンセルなら、そのまま残る
  await page.locator(".breadcrumb .back-btn").click();
  await expect(page.locator(".dialog")).toContainText("このMTGを一時保存して戻りますか？");
  await page.locator(".dialog").getByRole("button", { name: "キャンセル" }).click();
  await expect(page).toHaveURL(new RegExp(`meetings/${id}`));
  // 一時保存して戻る
  await page.locator(".breadcrumb .back-btn").click();
  await confirm(page, "一時保存して戻る");
  await expect(page).not.toHaveURL(new RegExp(`meetings/${id}`));
  const saved = await page.evaluate((i) => fetch(`/api/meetings/${i}`).then((r) => r.json()), id);
  expect(saved.minute.summary).toContain("戻る前に書いた");
  expect(errors).toEqual([]);
});

test("カレンダーの予定（MTG）を、詳細から削除できる", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const name = `カレンダー削除PJ ${stamp}`;
  await makeProject(page, name);
  await page.locator(".pj-quick").getByRole("link", { name: /MTG/ }).click();
  await page.getByRole("button", { name: /臨時のMTG/ }).click();
  await page.getByRole("button", { name: "この内容で始める" }).click();
  await expect(page.locator("#minutes-form")).toBeVisible();
  const id = page.url().match(/meetings\/(\d+)/)[1];
  await page.goto("/#/calendar");
  // 今日の1日表示（月の表示では、予定が多いと隠れる）
  await page.locator(".cal-cell.is-today").click({ position: { x: 4, y: 4 } });
  await page.locator(`[data-ev]`, { hasText: name }).first().click();
  await page.locator(".ev-detail [data-del]").click();
  await confirm(page, "削除する");
  await expect(page.locator(".toast")).toContainText("削除しました");
  const res = await page.evaluate((i) => fetch(`/api/meetings/${i}`).then((r) => r.status), id);
  expect(res).toBe(404);
  expect(errors).toEqual([]);
});

test("「戻る」で、保存したフォームや終えたMTGに戻らない・戻るボタンはどの画面でも同じ場所", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const name = `戻る先テストPJ ${stamp}`;
  await makeProject(page, name);
  const pjUrl = page.url();
  // PJの編集を保存 → PJ画面。「戻る」で編集画面には戻らない
  await page.goto(pjUrl.replace(/#\/projects\/(\d+).*/, "#/projects/$1/edit"));
  await page.getByRole("button", { name: "保存する" }).click();
  await expect(page.locator(".pj-header h1")).toHaveText(name);
  await page.locator(".breadcrumb .back-btn").first().click();
  await expect(page).not.toHaveURL(/\/edit/);
  // MTGを始めて終える → PJ画面。「戻る」で終えたMTGには戻らない
  await page.goto(pjUrl);
  await page.locator(".pj-quick").getByRole("link", { name: /MTG/ }).click();
  await page.getByRole("button", { name: /臨時のMTG/ }).click();
  await page.getByRole("button", { name: "この内容で始める" }).click();
  await expect(page.locator("#minutes-form")).toBeVisible();
  await page.getByRole("button", { name: "MTGを終える" }).click();
  await confirm(page, "MTGを終える");
  await expect(page).toHaveURL(/#\/projects\/\d+/);
  await page.locator(".breadcrumb .back-btn").first().click();
  await expect(page).not.toHaveURL(/start=1/);
  // 戻るボタンの高さは、パンくずのある画面とない画面で同じ
  const top = async (hash) => {
    await page.goto(`/${hash}`);
    await expect(page.locator("#app > .loading")).toHaveCount(0);
    const button = page.locator("#app .breadcrumb .back-btn").first();
    await expect(button).toBeVisible();
    await expect(page.locator("#app")).not.toHaveClass(/entering/);
    // ページの上からの位置（画面のスクロールの位置に左右されないように）
    return button.evaluate((b) => Math.round(b.getBoundingClientRect().top + window.scrollY));
  };
  const a = await top("#/check");
  expect(await top("#/notices")).toBe(a);
  expect(await top("#/projects")).toBe(a);
  expect(errors).toEqual([]);
});

test("定例の曜日・時間決めアンケート：ホームから作って答え、結果から定例を予定に入れる", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.goto("/#/");
  await page.locator("#add-survey").click();
  await page.locator("[data-kind=teirei]").click();
  await expect(page.locator("#app h1")).toContainText("定例の曜日・時間決め");
  // 候補：月〜金 × 21:00・22:00 = 10個。月は来月（初めから選ばれている）
  await expect(page.locator("#slot-count")).toContainText("10 個");
  await page.getByRole("button", { name: "ホームに出す" }).click();
  await expect(page.locator(".survey-opt")).toHaveCount(10);
  await expect(page.locator(".survey-opt").first()).toContainText("月曜 21:00");
  // 答える（出られるもの：月曜 21:00 と 水曜 22:00）
  await page.locator(".survey-opt", { hasText: "月曜 21:00" }).click();
  await page.locator(".survey-opt", { hasText: "水曜 22:00" }).click();
  await page.getByRole("button", { name: "回答する" }).click();
  await expect(page.locator(".toast")).toContainText("回答しました");
  // 結果から、月曜 21:00 で予定に入れる
  const row = page.locator(".bar-row", { hasText: "月曜 21:00" });
  await row.getByRole("button", { name: "この時間で予定する" }).click();
  await confirm(page, "予定に入れる");
  // （前の回のテストで同じ月に入れてあれば「もう予定されています」になる）
  await expect(page.locator(".toast")).toContainText(/毎週月曜 21:00の定例を予定しました|もう予定されています/);
  await page.goto("/#/teirei/schedule");
  await expect(page.locator("#app")).toContainText("毎週月曜 21:00");
  // ホームのアンケートにも出る
  await page.goto("/#/");
  await expect(page.locator(".survey-btn", { hasText: "定例の曜日・時間決め" }).first()).toBeVisible();
  expect(errors).toEqual([]);
});
