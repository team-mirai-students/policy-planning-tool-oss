-- 定例の曜日・時間決めアンケート（kind = 'teirei'）：どの月の定例か・候補の曜日と時刻を残す
-- meta：JSON。{ "month": "YYYY-MM", "slots": [{ "weekday": 0〜6（0=日）, "time": "HH:MM" }, …] }（選択肢 options と同じ順）
ALTER TABLE surveys ADD COLUMN meta TEXT NOT NULL DEFAULT '{}';
