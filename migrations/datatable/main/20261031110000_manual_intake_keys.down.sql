-- down migration: manual_intake_keys
--
-- 手動投入の冪等キーの表を落とす。
-- 表の中身は再作成できる使い捨てのキーなので、失っても、重複を止める力が一時的に無くなるだけである。
-- 表を読み書きするコードが反映された後に戻すと、その読み書きが表の無いエラーで失敗する。
-- 戻す前に、表を読み書きしないコードを反映しておくこと。
BEGIN;

SET LOCAL lock_timeout = '30s';

DROP TABLE factory.manual_intake_keys;

END;
