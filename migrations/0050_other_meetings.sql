-- まだ始めていない定例に向けて書いた事務連絡を保存したときに作った、Notionの定例の議事録ページ（定例を始めると、その定例に引き継ぐ）
ALTER TABLE dept_notice_days ADD COLUMN notion_url TEXT;

-- その他のMTG：PJ・定例以外のMTG。カテゴリー（いまは「その他」だけ）の中の「プロジェクト」ごとにまとめる
-- notion_url：Notionの「その他」ページの「プロジェクト」欄に作ったページ（MTGの議事録は、その中に1回ずつページとして入る）
CREATE TABLE other_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL DEFAULT 'other',
  name TEXT NOT NULL,
  notion_url TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_other_groups_name ON other_groups(category, name);

CREATE TABLE other_meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES other_groups(id) ON DELETE CASCADE,
  starts_at TEXT NOT NULL,                 -- 'YYYY-MM-DDTHH:MM'
  body TEXT NOT NULL DEFAULT '',           -- 議事録（Markdown）
  notion_url TEXT NOT NULL DEFAULT '',
  ended_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_other_meetings_group ON other_meetings(group_id, starts_at);
