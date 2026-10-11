-- up migration: deployment_pull_requests
--
-- 反映ごとに、含まれるPRを記録する列を足す。要素は{number, title, origin, url}で、
-- self_updateが反映の時点で、sha_from..sha_toのマージのコミットから取り出して書く。
-- 既存の行は、PRを記録していないので空の配列になる。
BEGIN;

ALTER TABLE factory.deployments
    ADD COLUMN pull_requests jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN factory.deployments.pull_requests IS
    'sha_fromからsha_toの間にマージされたPR。[{number, title, origin, url}]の配列。originはfactory、human、unknownのどれか。題名はコミットメッセージ由来で、信頼できない文字列。';

END;
