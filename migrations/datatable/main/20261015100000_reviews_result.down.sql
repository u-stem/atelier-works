-- down migration: reviews_result
-- レビューの結果の記録は失われる。
BEGIN;

ALTER TABLE factory.reviews DROP CONSTRAINT reviews_result_check;
ALTER TABLE factory.reviews DROP COLUMN result;

END;
