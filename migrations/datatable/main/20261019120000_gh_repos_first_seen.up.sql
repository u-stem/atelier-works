-- up migration: gh_repos_first_seen
--
-- gh_reposに、収集が最初にその行を作った時刻の列を足す。
-- リポジトリ単位の古さを知らせるとき、新しく一覧に載ったリポジトリに猶予を与える起点になる。
-- 更新しない列で、収集の書き込み(ON CONFLICT DO UPDATE)は触れない。
--
-- 既存の行の値は、このmigrationを当てた時刻(now())にする。
-- 最初に見た本当の時刻は記録に残っていないためである。
-- 当てた時刻にすると、既存の行は当てた時刻から閾値の間だけ猶予を持ち、その後は実際の鮮度で判定される。
-- 古さの通知が最大で閾値の分だけ遅れる代わりに、当てた直後に通知が集中しない。
-- 列に既定値があるので、旧いコードが列を書かずに行を作っても失敗しない。
--
-- lock_timeoutは、1つのロックごとの待ちの上限である。
-- 止まった書き込みがあればmigrationは失敗する(self_updateが再試行する)。
BEGIN;

SET LOCAL lock_timeout = '30s';

ALTER TABLE factory.gh_repos
    ADD COLUMN first_seen_at timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN factory.gh_repos.first_seen_at IS
    '収集が最初にこの行を作った時刻。更新しない。既存の行はmigrationを当てた時刻。リポジトリ単位の古さの猶予の起点。';

END;
