-- up migration: reviews_result
--
-- reviewsに、投稿したレビューの結果(reviewResultFor)を記録する。
-- Discordの通知とConsoleのレビュー行が、同じ基準で状態を出すためである。
-- 結果は、今回の指摘の[MUST]に加えて、前のラウンドから残った未解決の[MUST]を数える。
-- 後者は指摘の一覧からは分からないので、投稿の時点の値を列に残す。
--
-- 既存の行は結果を記録していないため、NULLのままにする。
BEGIN;

ALTER TABLE factory.reviews ADD COLUMN result text;
ALTER TABLE factory.reviews ADD CONSTRAINT reviews_result_check
    CHECK (result IS NULL OR result IN ('changes_requested', 'reviewed'));

COMMENT ON COLUMN factory.reviews.result IS
    '投稿したレビューの結果。changes_requestedは修正必須の指摘が未解決、reviewedは修正必須の指摘なし。記録の無い行(移行前の行など)ではNULL。';

END;
