import { test } from "node:test";
import assert from "node:assert/strict";
import { notionPageId, minutesBlocks } from "../src/notion.js";

test("NotionのURLからページIDを取り出す", () => {
  assert.equal(notionPageId("https://app.notion.com/p/3f72f6877cc180bfa782cc337e9aa440?source=copy_link"), "3f72f6877cc180bfa782cc337e9aa440");
  assert.equal(notionPageId("https://www.notion.so/team/PJ-3f72f6877cc180b2a36afd2a39f2696b"), "3f72f6877cc180b2a36afd2a39f2696b");
  assert.equal(notionPageId("https://example.com/"), null);
});

test("議事録をNotionのブロックにする", () => {
  const blocks = minutesBlocks({
    homework: [{ title: "資料を集める", assignee_name: "佐藤", status: "done" }],
    agenda: "・課題を絞る\n・次の担当",
    summary: "",
    todos: [{ title: "事例を3件", assignee_name: "山田", due_date: "2026-10-19", status: "todo" }],
  });
  const types = blocks.map((b) => b.type);
  assert.deepEqual(types, ["heading_3", "to_do", "heading_3", "bulleted_list_item", "bulleted_list_item", "heading_3", "paragraph", "heading_3", "to_do"]);
  assert.equal(blocks[1].to_do.checked, true);
  assert.equal(blocks[3].bulleted_list_item.rich_text[0].text.content, "課題を絞る");
  assert.equal(blocks[8].to_do.rich_text[0].text.content, "事例を3件（山田・10/19まで）");
});

test("長い段落も切り捨てずにNotionへ送る", async () => {
  const { minutesBlocks } = await import("../src/notion.js");
  const text = "あ".repeat(4500);
  const blocks = JSON.stringify(minutesBlocks({ summary: text }));
  assert.equal((blocks.match(/あ/g) || []).length, 4500);
});

test("100行を超える議事録も切らずにNotionへ送る", async () => {
  const { minutesBlocks } = await import("../src/notion.js");
  const summary = Array.from({ length: 150 }, (_, i) => `行${i + 1}`).join("\n");
  const blocks = minutesBlocks({ summary });
  const text = JSON.stringify(blocks);
  assert.ok(text.includes("行1\"") && text.includes("行150\""));
  assert.ok(blocks.length > 150);
});

test("長い文章を分けるとき、絵文字を途中で切らない", async () => {
  const { minutesBlocks } = await import("../src/notion.js");
  const summary = "あ".repeat(1899) + "😀" + "い".repeat(10);
  const blocks = minutesBlocks({ summary });
  const parts = blocks.flatMap((b) => b[b.type]?.rich_text || []).map((t) => t.text.content);
  for (const p of parts) assert.ok(!/[\uD800-\uDBFF]$/.test(p) && !/^[\uDC00-\uDFFF]/.test(p), "絵文字が分かれている");
  assert.ok(parts.join("").includes("😀"));
});

test("その他のページの「プロジェクト」欄（段組みの中のデータベース）を見つけて、そこにページを作る", async () => {
  const { findOtherParent, createGroupPage } = await import("../src/notion.js");
  const calls = [];
  const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opt = {}) => {
    const path = String(url).replace("https://api.notion.com/v1", "");
    calls.push([opt.method, path, opt.body && JSON.parse(opt.body)]);
    if (path === "/pages/p1") return reply({ id: "p1" });
    if (path.startsWith("/blocks/p1/children")) return reply({ results: [{ id: "h", type: "heading_2" }, { id: "cl", type: "column_list" }], has_more: false });
    if (path.startsWith("/blocks/cl/children")) return reply({ results: [{ id: "c1", type: "column" }], has_more: false });
    if (path.startsWith("/blocks/c1/children")) return reply({ results: [{ id: "db1", type: "child_database", child_database: { title: "プロジェクト" } }], has_more: false });
    if (path === "/databases/db1") return reply({ properties: { "名前": { type: "title" }, "タグ": { type: "select" } } });
    if (path === "/pages" && opt.method === "POST") return reply({ url: "https://www.notion.so/new" });
    return new Response("{}", { status: 404 });
  };
  try {
    const env = { NOTION_TOKEN: "x" };
    const parent = await findOtherParent(env, "p1");
    assert.deepEqual(parent, { database_id: "db1", title: "プロジェクト" });
    assert.equal(await createGroupPage(env, parent, "勉強会"), "https://www.notion.so/new");
    const post = calls.find(([m, p]) => m === "POST" && p === "/pages")[2];
    assert.deepEqual(post.parent, { database_id: "db1" });
    assert.equal(post.properties["名前"].title[0].text.content, "勉強会");
  } finally {
    globalThis.fetch = real;
  }
});
