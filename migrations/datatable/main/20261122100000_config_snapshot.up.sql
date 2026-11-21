-- up migration: config_snapshot
--
-- 設定(factory_config)の履歴に、Consoleの外の経路(CLI、Windmillの画面)の変更を、定期の照合が書くための理由コードを足す。
-- 足す理由コード:
--   out_of_band_change: 照合が、履歴の最後の値と今の値が違う項目を見つけた。
--   out_of_band_removed: 照合が、履歴にある項目が設定から無くなったのを見つけた。
--   snapshot_baseline: 照合が、基準の段階に、履歴にまだ無い項目の最初の値を、比べる基準として残した。基準の段階が終わった印の行にも使う。
--   out_of_band_added: 照合が、基準の印の後に、設定へ足された項目を見つけた。
-- 理由コードの一覧(config_history_reason_codes)を、並びを保って置き換える。表のCHECKは、この関数を呼ぶので、表は変えない。
-- 既存の行は、すべて元の4つの理由コードで、置き換え後も一覧に入る。
-- 項目ごとの最後の行を読む照合のために、(item_key, seq DESC)の索引を足す。
-- TypeScriptの`CONFIG_HISTORY_REASON_CODES`と同じ並びにする(実DBの検査が照合する)。

BEGIN;

SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION factory.config_history_reason_codes() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
    SELECT ARRAY[
        'console_update',
        'console_update_unverified',
        'stop_all_flag_off',
        'unspecified',
        'out_of_band_change',
        'out_of_band_removed',
        'snapshot_baseline',
        'out_of_band_added'
    ]::text[]
$fn$;

-- 照合は、5分ごとに、項目ごとの最後の行を`DISTINCT ON (item_key) ... ORDER BY item_key, seq DESC`で読む。
-- 追記専用の表は縮まないので、この並びの索引が無いと、読み取りが表全体の並べ替えになる。
-- 表のCREATE INDEXは追記を短く待たせる。表は小さく、BEGINの直後のlock_timeoutが上限になる。
CREATE INDEX IF NOT EXISTS config_history_item_key_seq_idx
    ON factory.config_history (item_key, seq DESC);

COMMENT ON COLUMN factory.config_history.source IS
    '書いた経路。console(Consoleの設定の更新)、stop_all(Consoleの全停止)、out_of_band(Consoleの外の変更。定期の照合が書く)。';

END;
