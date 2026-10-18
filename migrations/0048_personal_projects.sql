-- 個人PJ：PJ決めの種から、管理者以外の人も「個人PJとして進める」で始めたPJ（PJの一覧・画面に「個人PJ」と出す）
ALTER TABLE projects ADD COLUMN personal INTEGER NOT NULL DEFAULT 0;
