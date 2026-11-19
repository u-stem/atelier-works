-- down migration: review_finding_outcomes
-- 表と列を落とす。採否の記録は失われるが、reviewsのほかの列と行は変えない。
BEGIN;

SET LOCAL lock_timeout = '30s';

DROP TABLE factory.review_human_threads;

DROP TABLE factory.review_findings;

DROP INDEX factory.reviews_agent_run_id_idx;

ALTER TABLE factory.reviews
    DROP COLUMN agent_run_id;

END;
