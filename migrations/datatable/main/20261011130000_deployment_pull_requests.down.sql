-- down migration: deployment_pull_requests
-- 記録したPRの一覧を捨てて、列を落とす。
BEGIN;

ALTER TABLE factory.deployments
    DROP COLUMN pull_requests;

END;
