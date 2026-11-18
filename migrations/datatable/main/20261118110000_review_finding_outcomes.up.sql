-- up migration: review_finding_outcomes
--
-- レビュー指摘の採否を、指摘ごとに記録する。
-- review_findings: factory.reviews.findingsの各要素を1行にし、投稿したコメントのidと、その後の結果を持つ。
--   idxは、reviews.findingsの配列の中の位置(0始まり)である。
--   postedは、PRに出した指摘か(確信度がlowの指摘と、投稿しなかったレビューの指摘は偽)。
--   review_comment_idは、投稿した行コメントのid。行コメントにならなかった指摘と、対応づけられなかった指摘はNULLである。
--   outcomeは、postedが真の指摘の結果。偽の指摘はNULLである。
-- review_human_threads: Factoryでなく人が始めたレビュースレッド。見逃しの代理の指標に使う。
--   最初に読んだレビュー(first_seen_review_id)の削除と一緒に消える。work_item_idは外部キーを持たず、値だけで参照する。
-- reviews.agent_run_id: そのレビューを生成したagent_runsの行。スキルの版と結びつけるための参照である。
-- 追加だけで、既存の行と列は変えない。
BEGIN;

SET LOCAL lock_timeout = '30s';

ALTER TABLE factory.reviews
    ADD COLUMN agent_run_id bigint REFERENCES factory.agent_runs (id) ON DELETE SET NULL;

CREATE INDEX reviews_agent_run_id_idx ON factory.reviews (agent_run_id)
    WHERE agent_run_id IS NOT NULL;

COMMENT ON COLUMN factory.reviews.agent_run_id IS
    'このレビューを生成したagent_runsの行。記録できなかったレビューと、この列を足す前のレビューはNULLである。';

CREATE TABLE factory.review_findings (
    id bigserial PRIMARY KEY,
    review_id bigint NOT NULL REFERENCES factory.reviews (id) ON DELETE CASCADE,
    idx integer NOT NULL,
    path text NOT NULL,
    severity text NOT NULL,
    kind text NOT NULL,
    confidence text,
    posted boolean NOT NULL,
    review_comment_id bigint,
    outcome text,
    outcome_at timestamptz,
    outcome_source text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT review_findings_review_idx_key UNIQUE (review_id, idx),
    CONSTRAINT review_findings_outcome_check CHECK (
        outcome IS NULL
        OR outcome IN (
            'posted', 'skipped', 'issue_proposed', 'fixed',
            'skip_accepted', 'skip_rejected', 'answered', 'resolved_by_human'
        )
    ),
    CONSTRAINT review_findings_outcome_source_check CHECK (
        outcome_source IS NULL
        OR outcome_source IN ('pr_fix', 'rereview', 'thread_sync')
    ),
    CONSTRAINT review_findings_outcome_posted_check CHECK (posted OR outcome IS NULL)
);

CREATE INDEX review_findings_review_comment_id_idx ON factory.review_findings (review_comment_id)
    WHERE review_comment_id IS NOT NULL;

CREATE INDEX review_findings_created_at_idx ON factory.review_findings (created_at);

COMMENT ON TABLE factory.review_findings IS
    'レビュー指摘ごとの記録。reviews.findingsの各要素に、投稿したコメントのidと、その後の結果を足したもの。';
COMMENT ON COLUMN factory.review_findings.idx IS
    'factory.reviews.findingsの配列の中の位置(0始まり)。';
COMMENT ON COLUMN factory.review_findings.posted IS
    'PRに出した指摘か。確信度がlowの指摘と、投稿しなかったレビューの指摘は偽である。';
COMMENT ON COLUMN factory.review_findings.review_comment_id IS
    '投稿した行コメントのid(GitHubのREST id)。総評に載せた指摘と、対応づけられなかった指摘はNULLである。';
COMMENT ON COLUMN factory.review_findings.outcome IS
    'postedが真の指摘の結果。posted、skipped、issue_proposed、fixed、skip_accepted、skip_rejected、answered、resolved_by_humanのいずれか。postedが偽の指摘はNULLである。';
COMMENT ON COLUMN factory.review_findings.outcome_source IS
    '結果を記録した経路。pr_fix、rereview、thread_syncのいずれか。';

CREATE TABLE factory.review_human_threads (
    id bigserial PRIMARY KEY,
    work_item_id bigint NOT NULL,
    first_comment_id bigint NOT NULL,
    first_seen_review_id bigint NOT NULL REFERENCES factory.reviews (id) ON DELETE CASCADE,
    resolved boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT review_human_threads_first_comment_key UNIQUE (first_comment_id)
);

CREATE INDEX review_human_threads_created_at_idx ON factory.review_human_threads (created_at);

COMMENT ON TABLE factory.review_human_threads IS
    'Factoryでなく人が始めたレビュースレッド。レビューのたびにスレッドの一覧から同期する。最初のレビューより前に始まり、その後に読めなかったスレッドは載らない。';
COMMENT ON COLUMN factory.review_human_threads.first_comment_id IS
    'スレッドの最初のコメントのid(GitHubのREST id)。';
COMMENT ON COLUMN factory.review_human_threads.work_item_id IS
    'このスレッドを初めて読んだレビューの作業項目。外部キーを持たず、値だけで参照する。';
COMMENT ON COLUMN factory.review_human_threads.first_seen_review_id IS
    'このスレッドを初めて読んだレビュー。行は、このレビューの削除と一緒に消える。';
COMMENT ON COLUMN factory.review_human_threads.resolved IS
    '最後に読んだ時点で、許可された人が解決していたか。';

END;
