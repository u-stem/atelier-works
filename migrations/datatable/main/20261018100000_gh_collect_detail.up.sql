-- up migration: gh_collect_detail
--
-- 収集の詳細として、開いているPRと、トリガーラベル付きの開いているIssueの記録を足す。
-- あわせて、リポジトリの鮮度の列と、実行の記録の列を足す。
-- 作業項目(work_items)とは独立した記録で、作業項目の状態には影響しない。
-- 外部キーは持たない。ownerとrepoは小文字にそろえる。
--
-- gh_pull_requests / gh_issues: リポジトリの(owner, repo, number)ごとに1行。
--   repo_idは、行を書いたときのリポジトリの数値ID。
--   gh_repos.repo_idと違う行は、別のリポジトリに置き換わった後の行なので使わない。
--   stateは、PRがopen/closed、Issueがopen/unlisted。
--     Issueの一覧はトリガーラベルで絞るので、閉じたのかラベルが外れたのかは区別できない。
--   行が無いことは、閉じたことを意味しない。
--   NULLの列は不明で、値が偽や空であることを意味しない。
--   written_atは値を書いた時刻で、鮮度ではない。鮮度はgh_repos.last_collected_atで表す。
--   usableが偽の行は、許可の外、archive済み、一覧から消えた、所有者の不一致、
--   repo_idの入れ替わりのどれかで、使えない。
--   題と本文とラベル名は保存しない。
--
-- gh_repos: 足した列は、詳細を取り終えた周回と、取りに着手した周回を表す。
--   last_collected_at: 詳細を最後に取り終えた周回の、観測を始めた時刻。NULLは一度も取り終えていない。
--   last_attempted_at: 詳細の結果を最後に書いた時刻。取る順の並びのキー。NULLは一度も着手していない。
--   truncated: 前回の着手が、ページの上限か件数の照合の不一致で打ち切られた。
--   detail_failed: 前回の着手が失敗した。
--
-- gh_collect_runs: 足した列は、失敗した段と、詳細の取得の件数を表す。
--   stageは、error_codeが生じた段(list/detail)。成功の行はNULL。
--
-- 既存の行と列の値は変えない。足す列の既定値は定数なので、表の書き直しは起きない。
--
-- stageとerror_codeの整合は、CHECKにしない。
-- 旧いコードは、stageを書かずに失敗の行を書き、書き始めの行(ok=false、error_codeなし)も書く。
-- NOT ok → stage IS NOT NULLにすると、このmigrationだけを反映した時点で、旧いコードの書き込みが失敗する。
--
-- lock_timeoutは、1つのロックごとの待ちの上限で、migration全体の上限ではない。
-- gh_reposのロックを持ったままgh_collect_runsのロックを待つので、最大で約60秒かかる。
-- その間、gh_reposとgh_collect_runsへの文も待たされる。
-- 止まった書き込みがあればmigrationは失敗する(self_updateが再試行する)。
BEGIN;

SET LOCAL lock_timeout = '30s';

CREATE TABLE factory.gh_pull_requests (
    id bigserial PRIMARY KEY,
    owner text NOT NULL,
    repo text NOT NULL,
    repo_id bigint NOT NULL,
    number integer NOT NULL,
    state text NOT NULL,
    head_sha text NOT NULL,
    head_ref text,
    base_ref text,
    is_draft boolean NOT NULL,
    is_cross_repository boolean NOT NULL,
    auto_merge_enabled boolean,
    author_login text,
    author_type text,
    author_id bigint,
    mergeable text,
    has_review_label boolean,
    has_fix_label boolean,
    review_requested_user_ids bigint[],
    assignee_ids bigint[],
    team_review_requested boolean,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    written_at timestamptz NOT NULL DEFAULT now(),
    usable boolean NOT NULL DEFAULT true,
    CONSTRAINT gh_pull_requests_lowercase_check CHECK (owner = lower(owner) AND repo = lower(repo)),
    CONSTRAINT gh_pull_requests_repo_id_check CHECK (repo_id > 0),
    CONSTRAINT gh_pull_requests_number_check CHECK (number > 0),
    CONSTRAINT gh_pull_requests_state_check CHECK (state IN ('open', 'closed')),
    CONSTRAINT gh_pull_requests_head_sha_check CHECK (head_sha ~ '^[0-9a-f]{40}$'),
    CONSTRAINT gh_pull_requests_head_ref_check CHECK (head_ref IS NULL OR octet_length(head_ref) BETWEEN 1 AND 255),
    CONSTRAINT gh_pull_requests_base_ref_check CHECK (base_ref IS NULL OR octet_length(base_ref) BETWEEN 1 AND 255),
    CONSTRAINT gh_pull_requests_author_login_check CHECK (author_login IS NULL OR char_length(author_login) BETWEEN 1 AND 39),
    CONSTRAINT gh_pull_requests_author_type_check CHECK (author_type IS NULL OR author_type IN ('User', 'Bot', 'Mannequin', 'Organization', 'EnterpriseUserAccount')),
    CONSTRAINT gh_pull_requests_author_pair_check CHECK ((author_login IS NULL) = (author_type IS NULL)),
    CONSTRAINT gh_pull_requests_author_id_check CHECK (author_id IS NULL OR author_id > 0),
    CONSTRAINT gh_pull_requests_mergeable_check CHECK (mergeable IS NULL OR mergeable IN ('MERGEABLE', 'CONFLICTING')),
    CONSTRAINT gh_pull_requests_review_requested_user_ids_check CHECK (review_requested_user_ids IS NULL OR (array_position(review_requested_user_ids, NULL) IS NULL AND 0 < ALL (review_requested_user_ids))),
    CONSTRAINT gh_pull_requests_assignee_ids_check CHECK (assignee_ids IS NULL OR (array_position(assignee_ids, NULL) IS NULL AND 0 < ALL (assignee_ids))),
    UNIQUE (owner, repo, number)
);

COMMENT ON TABLE factory.gh_pull_requests IS
    'GitHubの開いているPRの記録。リポジトリの詳細を取り終えたときに書き直す。閉じた行は保持期間まで残す。';
COMMENT ON COLUMN factory.gh_pull_requests.repo_id IS
    '行を書いたときのリポジトリの数値ID。gh_repos.repo_idと違う行は使わない。';
COMMENT ON COLUMN factory.gh_pull_requests.state IS
    'open: 観測の時点で開いていた。closed: 観測の時点で一覧に無かった。行が無いことは閉じたことを意味しない。';
COMMENT ON COLUMN factory.gh_pull_requests.head_sha IS
    'headのコミットのSHA(40桁の小文字16進)。';
COMMENT ON COLUMN factory.gh_pull_requests.head_ref IS
    'headのブランチ名。信頼できない入力で、検査を通らない名前はNULL。NULLの行はFactoryのブランチとみなさない。';
COMMENT ON COLUMN factory.gh_pull_requests.base_ref IS
    'baseのブランチ名。信頼できない入力で、検査を通らない名前はNULL。';
COMMENT ON COLUMN factory.gh_pull_requests.auto_merge_enabled IS
    'auto-mergeが有効か。NULLは不明。';
COMMENT ON COLUMN factory.gh_pull_requests.author_login IS
    '作者のlogin。生の値で、dependabotはdependabot。作者が削除されたときと、項目のエラーのときはNULL。';
COMMENT ON COLUMN factory.gh_pull_requests.author_type IS
    '作者のGraphQLの種別(User、Bot、Mannequin、Organization、EnterpriseUserAccount)。author_loginと同時にNULLになる。';
COMMENT ON COLUMN factory.gh_pull_requests.author_id IS
    '作者の数値ID。取れなかったときはNULL。';
COMMENT ON COLUMN factory.gh_pull_requests.mergeable IS
    'MERGEABLEかCONFLICTINGだけを書く。UNKNOWNと不正な値はNULL。前回の値は保たない。';
COMMENT ON COLUMN factory.gh_pull_requests.has_review_label IS
    'レビューのラベルが付いているか。ラベルが多すぎて全部を見られないとき、項目のエラーのときはNULL。ラベル名は保存しない。';
COMMENT ON COLUMN factory.gh_pull_requests.has_fix_label IS
    '修正のラベルが付いているか。NULLの条件はhas_review_labelと同じ。';
COMMENT ON COLUMN factory.gh_pull_requests.review_requested_user_ids IS
    'レビューを依頼された利用者の数値ID。チームへの依頼は含まない。多すぎて全部を見られないとき、項目のエラーのときはNULL。';
COMMENT ON COLUMN factory.gh_pull_requests.assignee_ids IS
    'assigneeの数値ID。多すぎて全部を見られないときはNULL。';
COMMENT ON COLUMN factory.gh_pull_requests.team_review_requested IS
    'チームへのレビュー依頼があるか。NULLは不明。';
COMMENT ON COLUMN factory.gh_pull_requests.created_at IS
    'GitHubでPRが作られた時刻。';
COMMENT ON COLUMN factory.gh_pull_requests.updated_at IS
    'GitHubでPRが最後に更新された時刻。';
COMMENT ON COLUMN factory.gh_pull_requests.written_at IS
    '値を書いた時刻。鮮度ではない。鮮度はgh_repos.last_collected_atで表す。';
COMMENT ON COLUMN factory.gh_pull_requests.usable IS
    '偽の行は使わない。許可の外、archive済み、一覧から消えた、所有者の不一致、repo_idの入れ替わりのどれか。';

-- 開いている行を、リポジトリごとに読む(下流の読み取り、差分の読み取り、使えない行の無効化)。
CREATE INDEX gh_pull_requests_open_idx ON factory.gh_pull_requests (owner, repo) WHERE state = 'open';
-- 閉じた行を、書いた時刻の古い順に掃除する。
CREATE INDEX gh_pull_requests_closed_idx ON factory.gh_pull_requests (written_at) WHERE state = 'closed';

CREATE TABLE factory.gh_issues (
    id bigserial PRIMARY KEY,
    owner text NOT NULL,
    repo text NOT NULL,
    repo_id bigint NOT NULL,
    number integer NOT NULL,
    state text NOT NULL,
    author_login text,
    author_type text,
    author_id bigint,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    written_at timestamptz NOT NULL DEFAULT now(),
    usable boolean NOT NULL DEFAULT true,
    CONSTRAINT gh_issues_lowercase_check CHECK (owner = lower(owner) AND repo = lower(repo)),
    CONSTRAINT gh_issues_repo_id_check CHECK (repo_id > 0),
    CONSTRAINT gh_issues_number_check CHECK (number > 0),
    CONSTRAINT gh_issues_state_check CHECK (state IN ('open', 'unlisted')),
    CONSTRAINT gh_issues_author_login_check CHECK (author_login IS NULL OR char_length(author_login) BETWEEN 1 AND 39),
    CONSTRAINT gh_issues_author_type_check CHECK (author_type IS NULL OR author_type IN ('User', 'Bot', 'Mannequin', 'Organization', 'EnterpriseUserAccount')),
    CONSTRAINT gh_issues_author_pair_check CHECK ((author_login IS NULL) = (author_type IS NULL)),
    CONSTRAINT gh_issues_author_id_check CHECK (author_id IS NULL OR author_id > 0),
    UNIQUE (owner, repo, number)
);

COMMENT ON TABLE factory.gh_issues IS
    'GitHubのトリガーラベル付きの開いているIssueの記録。リポジトリの詳細を取り終えたときに書き直す。一覧から外れた行は保持期間まで残す。';
COMMENT ON COLUMN factory.gh_issues.repo_id IS
    '行を書いたときのリポジトリの数値ID。gh_repos.repo_idと違う行は使わない。';
COMMENT ON COLUMN factory.gh_issues.state IS
    'open: 観測の時点でトリガーラベル付きの開いたIssueだった。unlisted: 観測の時点で一覧に無かった(閉じたか、ラベルが外れた)。';
COMMENT ON COLUMN factory.gh_issues.author_login IS
    '作者のlogin。生の値。作者が削除されたときと、項目のエラーのときはNULL。';
COMMENT ON COLUMN factory.gh_issues.author_type IS
    '作者のGraphQLの種別。author_loginと同時にNULLになる。';
COMMENT ON COLUMN factory.gh_issues.author_id IS
    '作者の数値ID。取れなかったときはNULL。';
COMMENT ON COLUMN factory.gh_issues.created_at IS
    'GitHubでIssueが作られた時刻。';
COMMENT ON COLUMN factory.gh_issues.updated_at IS
    'GitHubでIssueが最後に更新された時刻。';
COMMENT ON COLUMN factory.gh_issues.written_at IS
    '値を書いた時刻。鮮度ではない。鮮度はgh_repos.last_collected_atで表す。';
COMMENT ON COLUMN factory.gh_issues.usable IS
    '偽の行は使わない。許可の外、archive済み、一覧から消えた、所有者の不一致、repo_idの入れ替わりのどれか。';

CREATE INDEX gh_issues_open_idx ON factory.gh_issues (owner, repo) WHERE state = 'open';
CREATE INDEX gh_issues_unlisted_idx ON factory.gh_issues (written_at) WHERE state = 'unlisted';

ALTER TABLE factory.gh_repos
    ADD COLUMN last_collected_at timestamptz,
    ADD COLUMN last_attempted_at timestamptz,
    ADD COLUMN truncated boolean NOT NULL DEFAULT false,
    ADD COLUMN detail_failed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN factory.gh_repos.last_collected_at IS
    '詳細を最後に取り終えた周回の、観測を始めた時刻。書いた時刻ではない。NULLは一度も取り終えていない。';
COMMENT ON COLUMN factory.gh_repos.last_attempted_at IS
    '詳細の結果を最後に書いた時刻。取る順の並びのキー。NULLは一度も着手していない。';
COMMENT ON COLUMN factory.gh_repos.truncated IS
    '前回の着手が、ページの上限か件数の照合の不一致で打ち切られたか。';
COMMENT ON COLUMN factory.gh_repos.detail_failed IS
    '前回の着手が失敗したか。真のリポジトリは、次の周回で1件ずつ取る。';

ALTER TABLE factory.gh_collect_runs
    ADD COLUMN stage text,
    ADD COLUMN detail_targets integer NOT NULL DEFAULT 0,
    ADD COLUMN detail_requests integer NOT NULL DEFAULT 0,
    ADD COLUMN detail_done integer NOT NULL DEFAULT 0,
    ADD COLUMN detail_incomplete integer NOT NULL DEFAULT 0,
    ADD CONSTRAINT gh_collect_runs_stage_check CHECK (stage IS NULL OR stage IN ('list', 'detail')),
    ADD CONSTRAINT gh_collect_runs_ok_stage_check CHECK (NOT ok OR stage IS NULL),
    ADD CONSTRAINT gh_collect_runs_detail_counts_check CHECK (detail_targets >= 0 AND detail_requests >= 0 AND detail_done >= 0 AND detail_incomplete >= 0);

COMMENT ON COLUMN factory.gh_collect_runs.stage IS
    'error_codeが生じた段。list: 一覧。detail: 詳細。成功の行はNULL。';
COMMENT ON COLUMN factory.gh_collect_runs.detail_targets IS
    '詳細を取る対象のリポジトリの数。';
COMMENT ON COLUMN factory.gh_collect_runs.detail_requests IS
    '詳細の要求の数。ページ送りと分割を含む。';
COMMENT ON COLUMN factory.gh_collect_runs.detail_done IS
    '詳細を取り終えて書いたリポジトリの数。';
COMMENT ON COLUMN factory.gh_collect_runs.detail_incomplete IS
    '詳細が打ち切りか失敗になったリポジトリの数。';

END;
