-- down migration: rename_labeler_notice_kind
-- 未解決のlabeler_deniedの通知を、すべて旧い種類名に戻す。
-- upの後に新しく記録された通知も区別できないため、同じく旧い種類名になる。
BEGIN;

UPDATE factory.notices
SET kind = 'labeler_association_denied'
WHERE kind = 'labeler_denied'
  AND resolved = false;

END;
