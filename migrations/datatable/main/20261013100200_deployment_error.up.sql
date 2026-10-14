-- up migration: deployment_error
--
-- 失敗した反映ごとに、失敗の理由を記録する列を足す。
-- self_updateが、ログに出す失敗の文と同じ伏せ字処理を通し、2000字までに切り詰めて書く。
-- 成功の行と、この列より前に記録した失敗の行はNULLになる。
-- 保持期間は行と同じで、cleanup_dbが行ごと消す。
BEGIN;

ALTER TABLE factory.deployments
    ADD COLUMN error text;

COMMENT ON COLUMN factory.deployments.error IS
    '失敗の理由。秘密情報を伏せ字にした後の文で、2000字まで。成功の行と、記録を始める前の失敗の行はNULL。外部のコマンドの出力を含みうる、信頼できない文字列。';

END;
