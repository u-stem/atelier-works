-- up migration: drawio_viewer_observations
--
-- draw.ioのビューアの固定を上げる処理(drawio_viewer_bump)が、リリースのタグごとに、
-- 最初に見たときのcommitと時刻を記録する。公開日(published_at)は、リリースを作る側が
-- 書き換えられるので、それだけでは「公開から14日たった」ことの根拠にならない。
-- この表の時刻は、こちらがそのタグ(とcommit)を最初に見た時刻である。
-- Factoryの通常の経路からは書き換えない。DBを直接触る変更(migration、WindmillのSQL)は除く。
-- タグが別のcommitに付け替えられたら、時刻を取り直し、待ちを数え直す。
BEGIN;

CREATE TABLE factory.drawio_viewer_observations (
    tag text PRIMARY KEY,
    commit_sha text NOT NULL,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT drawio_viewer_observations_commit_check
        CHECK (commit_sha ~ '^[0-9a-f]{40}$')
);

COMMENT ON TABLE factory.drawio_viewer_observations IS
    'draw.ioのリリースのタグごとに、最初に見たcommitと時刻。タグが別のcommitに付け替えられたら取り直す。';
COMMENT ON COLUMN factory.drawio_viewer_observations.first_seen_at IS
    '今のcommitを最初に見た時刻。この時刻から14日たつまで、その版には固定を上げない。';

END;
