import { test } from "node:test";
import assert from "node:assert/strict";
import { leaderIds } from "../src/util.js";

// 部門長・副部門長へのお知らせ（承認待ちなど）は、管理者メニューで足した管理者（副部門長など）にも届く
test("承認待ちのお知らせは、部門長・ADMIN_IDS・管理者メニューで足した人の全員に届く", async () => {
  const rows = { heads: [{ user_id: "head" }], admins: [{ user_id: "vice" }, { user_id: "head" }] };
  const env = {
    ADMIN_IDS: "fixed",
    DB: { prepare: (sql) => ({ all: async () => ({ results: rows[sql.match(/FROM (\w+)/)[1]] || [] }) }) },
  };
  assert.deepEqual((await leaderIds(env)).sort(), ["fixed", "head", "vice"]);
});
