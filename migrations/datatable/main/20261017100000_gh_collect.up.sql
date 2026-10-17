-- up migration: gh_collect
--
-- GitHubの所有者ごとのリポジトリの状態を集めた記録と、集めた実行の記録。
-- 作業項目(work_items)とは独立した記録で、作業項目の状態には影響しない。
-- 外部キーは持たない。掃除は実行の記録だけを対象にする。
--
-- gh_repos: 所有者のリポジトリごとに1行。ownerとrepoは小文字にそろえる。
--   一覧にあるリポジトリは、一覧を取り終えたときだけ書き直す。
--   goneは、一覧から消えた、またはarchiveされたリポジトリを表し、行は消さない。
--   gone_reason:
--     archived    一覧にあるが、archiveされている。
--     not_listed  前回あったのに、一覧に無い。
--     not_visible repo_allowlistにあるのに、一覧に無い。一度も見えていない行はrepo_idがNULLになる。
--   allowedが偽の行は、PRとIssueの件数を持たない(NULL)。
--
-- gh_collect_runs: 1回の実行につき、所有者ごとに1行。
--   実行の始めにfinished_atが空の行を全員分書き、終わりに更新する。
--   終わりの更新が失敗した行は、finished_atが空のまま残る。
--   最新の実行は、所有者ごとにfinished_atのある最新の行である。
--   ledは、その周回で最初に要求を送った所有者の行だけが真になる。結果は問わない。
--   所有者を回す順は、ledが真で終えた最新の行のstarted_atが古い順にする。
--   verifiedは「照合の失敗が無い」こと。id_checkedは「設定のIDと一致した」ことで、
--   設定にIDが無いときはfalse、照合に至らなかったときはNULLになる。
--
-- 既存の表は書き換えない。ロックの待ちは最大30秒で、
-- 止まった書き込みがあればmigrationは失敗する(self_updateが再試行する)。
BEGIN;

SET LOCAL lock_timeout = '30s';

CREATE TABLE factory.gh_repos (
    id bigserial PRIMARY KEY,
    owner text NOT NULL,
    owner_id bigint NOT NULL,
    repo text NOT NULL,
    repo_id bigint,
    allowed boolean NOT NULL,
    default_branch text,
    archived boolean NOT NULL DEFAULT false,
    open_pr_count integer,
    labeled_issue_count integer,
    gone boolean NOT NULL DEFAULT false,
    gone_reason text,
    listed_at timestamptz,
    CONSTRAINT gh_repos_lowercase_check CHECK (owner = lower(owner) AND repo = lower(repo)),
    CONSTRAINT gh_repos_gone_reason_check CHECK (gone = (gone_reason IS NOT NULL) AND (gone_reason IS NULL OR gone_reason IN ('archived', 'not_listed', 'not_visible'))),
    CONSTRAINT gh_repos_repo_id_check CHECK (repo_id IS NOT NULL OR gone_reason IN ('not_listed', 'not_visible')),
    CONSTRAINT gh_repos_counts_check CHECK (allowed OR (open_pr_count IS NULL AND labeled_issue_count IS NULL)),
    CONSTRAINT gh_repos_open_pr_count_check CHECK (open_pr_count IS NULL OR open_pr_count >= 0),
    CONSTRAINT gh_repos_labeled_issue_count_check CHECK (labeled_issue_count IS NULL OR labeled_issue_count >= 0),
    UNIQUE (owner, repo)
);

COMMENT ON TABLE factory.gh_repos IS
    'GitHubの所有者のリポジトリの状態。所有者の一覧を取り終えたときだけ書き直す。goneの行は消さない。';
COMMENT ON COLUMN factory.gh_repos.owner_id IS
    '一覧を取ったときのGitHubの所有者の数値ID。';
COMMENT ON COLUMN factory.gh_repos.repo_id IS
    'GitHubのリポジトリの数値ID。一度も見えていないnot_visibleの行だけNULL。';
COMMENT ON COLUMN factory.gh_repos.allowed IS
    '設定(owners、repo_allowlist)が対象にしてよいリポジトリか。偽の行は件数を持たない。';
COMMENT ON COLUMN factory.gh_repos.open_pr_count IS
    '開いているPRの件数。allowedが偽の行と、件数を取れていない行はNULL。';
COMMENT ON COLUMN factory.gh_repos.labeled_issue_count IS
    'トリガーラベルが付いた開いているIssueの件数。allowedが偽の行と、件数を取れていない行はNULL。';
COMMENT ON COLUMN factory.gh_repos.gone_reason IS
    'archived: archive済み。not_listed: 前回あったのに一覧に無い。not_visible: repo_allowlistにあるのに一覧に無い。goneが偽ならNULL。';
COMMENT ON COLUMN factory.gh_repos.listed_at IS
    '最後に一覧に載った時刻。一度も載っていない行はNULL。';

CREATE TABLE factory.gh_collect_runs (
    id bigserial PRIMARY KEY,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    ok boolean NOT NULL DEFAULT false,
    owner text NOT NULL,
    owner_id bigint,
    verified boolean NOT NULL DEFAULT false,
    id_checked boolean,
    cost integer,
    requests integer NOT NULL DEFAULT 0,
    remaining integer,
    error_code text,
    next_allowed_at timestamptz,
    led boolean NOT NULL DEFAULT false,
    CONSTRAINT gh_collect_runs_lowercase_check CHECK (owner = lower(owner)),
    CONSTRAINT gh_collect_runs_ok_check CHECK (NOT ok OR error_code IS NULL),
    CONSTRAINT gh_collect_runs_error_code_check
        CHECK (error_code IS NULL OR error_code IN ('no_token', 'token_config_invalid', 'db_error', 'owner_mismatch', 'deadline', 'unauthorized', 'forbidden', 'rate_limited', 'secondary_limit', 'http_5xx', 'timeout', 'graphql_error', 'parse_error')),
    CONSTRAINT gh_collect_runs_requests_check CHECK (requests >= 0),
    CONSTRAINT gh_collect_runs_led_check CHECK (NOT led OR requests >= 1)
);

COMMENT ON TABLE factory.gh_collect_runs IS
    'GitHubの収集の実行の記録。所有者ごとに1行で、始めにfinished_atが空の行を書き、終わりに更新する。';
COMMENT ON COLUMN factory.gh_collect_runs.owner_id IS
    '一覧の応答で見えたGitHubの所有者の数値ID。照合に至らなかった行はNULL。';
COMMENT ON COLUMN factory.gh_collect_runs.verified IS
    '照合の失敗が無かったか。IDが一致したことではない。';
COMMENT ON COLUMN factory.gh_collect_runs.id_checked IS
    '設定のIDと一致したか。設定にIDが無いときはfalse、照合に至らなかったときはNULL。';
COMMENT ON COLUMN factory.gh_collect_runs.cost IS
    'GraphQLのrateLimitのcostの合計。';
COMMENT ON COLUMN factory.gh_collect_runs.remaining IS
    '最後の応答のrateLimitのremaining。';
COMMENT ON COLUMN factory.gh_collect_runs.next_allowed_at IS
    'レート制限などで、この時刻まで通信しない。1時間以内に切り詰めて書く。';
COMMENT ON COLUMN factory.gh_collect_runs.led IS
    'その周回で最初に要求を送った所有者の行だけが真。結果は問わない。所有者を回す順に使う。';

-- 所有者ごとの最新の実行と、直近の成功を引く。掃除が残す行の判定にも使う。
CREATE INDEX gh_collect_runs_owner_finished_idx ON factory.gh_collect_runs (owner, finished_at DESC) WHERE finished_at IS NOT NULL;

END;
