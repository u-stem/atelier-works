-- down migration: deployment_error
-- 記録した失敗の理由を捨てて、列を落とす。
BEGIN;

ALTER TABLE factory.deployments
    DROP COLUMN error;

END;
