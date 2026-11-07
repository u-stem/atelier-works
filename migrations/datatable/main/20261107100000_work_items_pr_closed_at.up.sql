-- up migration: work_items_pr_closed_at
--
-- マージ済みのPRを、毎回GitHubとDBで読み直さないための列と索引を足す。
-- pr_closed_atは、PRがマージ済みと確かめた時刻である。行がその後に更新されていなければ(updated_at <= pr_closed_at)、
-- 巡回の対象から外す。行が書かれると印は無効になり、再開や再実装の行は自動で巡回に戻る。
-- 既存の行はNULL(印なし)で、今までどおり巡回される。
-- 索引は、種別とPRの番号から作業項目を等号で引く問い合わせ(markTrackedPrClosedなど)が使う。
-- listTrackedPrsは、並べ替えの列にupdated_atを含むので、この索引で並べ替えを省けない。
BEGIN;

SET LOCAL lock_timeout = '30s';

ALTER TABLE factory.work_items
    ADD COLUMN pr_closed_at timestamptz;

COMMENT ON COLUMN factory.work_items.pr_closed_at IS
    'PRがマージ済みと確かめた時刻。行がその後に更新されていなければ、PRの巡回の対象から外す。NULLは印なし。';

CREATE INDEX work_items_pr_lookup_idx
    ON factory.work_items (kind, owner, repo, pr_number);

END;
