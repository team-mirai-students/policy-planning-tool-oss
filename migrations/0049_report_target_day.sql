-- 進捗共有を、どの定例に向けて書くか毎回選べるように：まだ始めていない定例の日（'YYYY-MM-DD'）。'' は「次の定例」（今までどおり）
-- 定例が始まると（定例を始める）、その日に向けて書いたものと '' のものが、その定例に移る
ALTER TABLE dept_reports ADD COLUMN held_on TEXT NOT NULL DEFAULT '';
DROP INDEX idx_dept_reports_target;
CREATE UNIQUE INDEX idx_dept_reports_target ON dept_reports(project_id, COALESCE(dept_meeting_id, 0), held_on);
