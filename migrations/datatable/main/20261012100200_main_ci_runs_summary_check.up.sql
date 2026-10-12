-- up migration: main_ci_runs_summary_check
--
-- main_ci_runs.summaryは、外部由来の文字列(workflowの名前)を整形して入れる列である。
-- アプリのコードは400文字までに整形するが、DBでも同じ長さで拒み、想定外の長い文字列を入れさせない。
BEGIN;

ALTER TABLE factory.main_ci_runs
    ADD CONSTRAINT main_ci_runs_summary_length_check CHECK (char_length(summary) <= 400);

END;
