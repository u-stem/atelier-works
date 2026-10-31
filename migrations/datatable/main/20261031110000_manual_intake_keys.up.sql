-- up migration: manual_intake_keys
--
-- 手動投入の再送を止める冪等キーの表を作る。
-- 同じキーの投入が2回来たとき、2回目に最初の投入の結果を返し、Issueを増やさないために使う。
-- 表を読み書きするコードはまだ無い。
--
-- intake_key: 投入の1回を表すキー。小文字のUUIDだけを受ける。
-- content_hash: 投入の内容(owner、repo、題名、本文、受け入れ基準、進め方)を正規化した文字列のsha256。
--   同じキーで内容が違う投入を、同じ投入として扱わないために持つ。
-- owner、repo: 最初の投入が作ったIssueのリポジトリ。
-- issue_number: 最初の投入が作ったIssueの番号。作成が終わるまではNULL。
-- holder: キーを予約したジョブのID。予約を取り直したジョブだけが番号を書けるようにするために持つ。
-- reserved_at: 予約した時刻。作成中の予約の古さと、掃除の期限の判定に使う。
--
-- 新しい表の作成にロックの競合はほぼ無いが、止まった書き込みがあればmigrationは失敗する(self_updateが再試行する)。
-- 他の表、view、インデックスは触らない。
BEGIN;

SET LOCAL lock_timeout = '30s';

CREATE TABLE factory.manual_intake_keys (
    intake_key text PRIMARY KEY
        CHECK (intake_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    content_hash text NOT NULL,
    owner text NOT NULL,
    repo text NOT NULL,
    issue_number integer,
    holder text NOT NULL,
    reserved_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE factory.manual_intake_keys IS
    '手動投入の冪等キー。同じキーの再送が、最初の投入のIssueを返すために使う。保持期間を過ぎた行はcleanup_dbが消す。';

COMMENT ON COLUMN factory.manual_intake_keys.intake_key IS
    '投入の1回を表すキー。小文字のUUID。';

COMMENT ON COLUMN factory.manual_intake_keys.content_hash IS
    '投入の内容を正規化した文字列のsha256。同じキーで内容が違う投入を見分ける。';

COMMENT ON COLUMN factory.manual_intake_keys.owner IS
    '最初の投入が作ったIssueの所有者。';

COMMENT ON COLUMN factory.manual_intake_keys.repo IS
    '最初の投入が作ったIssueのリポジトリ。';

COMMENT ON COLUMN factory.manual_intake_keys.issue_number IS
    '最初の投入が作ったIssueの番号。作成が終わるまではNULL。';

COMMENT ON COLUMN factory.manual_intake_keys.holder IS
    'キーを予約したジョブのID。予約を取り直したジョブだけが番号を書く。';

COMMENT ON COLUMN factory.manual_intake_keys.reserved_at IS
    '予約した時刻。作成中の予約の古さと、掃除の期限を判定する。';

END;
