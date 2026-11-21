-- up migration: config_history
--
-- 設定(factory_config)の変更を、追記専用で、ハッシュでつないで残す。
-- config_history: 変更1つにつき1行。全体で1本の連鎖で、連番(seq)を1から振り、1つ前の行のハッシュ(prev_hash)を含めて自分のハッシュ(row_hash)を求める。
--   変更の量は少ないので、連鎖は1本にする。追記は固定のadvisory lockで直列にする。
--   before、afterは、許可リストで射影した値だけを持つ(真偽、数、時刻、短い列挙、リストの件数、コマンドとURLと身元に関わる値のハッシュ)。生の値は入れない。
--   書き込みは、Consoleの設定の更新と全停止のscriptが、変更の成功の後に、config_history_appendを呼んで行う。
--   sourceのout_of_bandは、Consoleの外の経路(CLI、Windmillの画面)の変更を、定期の照合が書くために予約している。今は使わない。
-- reason_codeは閉じた一覧(config_history_reason_codes)で、TypeScriptの`CONFIG_HISTORY_REASON_CODES`と同じ並びにする(実DBの検査が照合する)。
-- 追記専用の歯止め: UPDATE、DELETE、TRUNCATEを例外で拒む。掃除の例外は無く、保持は無期限である。
--   歯止めは安全柵で、表の所有者はトリガーを外せる。改ざんは、ハッシュの連鎖がconfig_history_verifyで検出する。
-- ハッシュ: 次の項目を、この順に`<バイト長>:<値>`の形(NULLは`~`)で並べ、`|`でつないだ文字列のsha256(16進)である。
--   prev_hash、seq、item_key、reason_code、before(jsonbの文字列表現)、after(jsonbの文字列表現)、actor、source、
--   occurred_at(UTC、`YYYY-MM-DD"T"HH24:MI:SS.US"Z"`)。最初の行のprev_hashは、0を64個並べた文字列である。
-- 検証はSQL(config_history_verify)で行い、言語をまたぐ正規化を持たない。
-- 追加だけで、既存の表と関数は変えない。既存の設定の値は取り込まない(履歴は、この移行の後の変更から始まる)。

BEGIN;

SET LOCAL lock_timeout = '30s';

-- 理由コードの一覧。TypeScriptの`CONFIG_HISTORY_REASON_CODES`と同じ並びにする。
CREATE FUNCTION factory.config_history_reason_codes() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
    SELECT ARRAY[
        'console_update',
        'stop_all_flag_off',
        'unspecified'
    ]::text[]
$fn$;

CREATE TABLE factory.config_history (
    id bigserial PRIMARY KEY,
    seq integer NOT NULL,
    item_key text NOT NULL,
    reason_code text NOT NULL,
    before jsonb,
    after jsonb,
    actor text NOT NULL,
    source text NOT NULL,
    occurred_at timestamptz NOT NULL,
    prev_hash text NOT NULL,
    row_hash text NOT NULL,
    CONSTRAINT config_history_seq_key UNIQUE (seq),
    CONSTRAINT config_history_seq_check CHECK (seq >= 1),
    CONSTRAINT config_history_item_key_check CHECK (item_key ~ '^[a-z][a-z0-9_]{0,79}$'),
    CONSTRAINT config_history_reason_code_check CHECK (reason_code = ANY (factory.config_history_reason_codes())),
    CONSTRAINT config_history_source_check CHECK (source IN ('console', 'stop_all', 'out_of_band')),
    CONSTRAINT config_history_actor_check CHECK (char_length(actor) BETWEEN 1 AND 100),
    CONSTRAINT config_history_before_size_check CHECK (before IS NULL OR octet_length(before::text) <= 1024),
    CONSTRAINT config_history_after_size_check CHECK (after IS NULL OR octet_length(after::text) <= 1024)
);

CREATE INDEX config_history_occurred_at_idx ON factory.config_history (occurred_at);

COMMENT ON TABLE factory.config_history IS
    '設定(factory_config)の変更の、追記専用でハッシュの連鎖を持つ履歴。全体で1本の連鎖で、保持は無期限である。許可リストで射影した値だけを持つ。';
COMMENT ON COLUMN factory.config_history.seq IS
    '連鎖の連番(1から)。欠けずに続く。';
COMMENT ON COLUMN factory.config_history.item_key IS
    '変更した設定の項目名。識別子の形に限る。';
COMMENT ON COLUMN factory.config_history.reason_code IS
    '変更の理由コード。呼び出し側が明示する。';
COMMENT ON COLUMN factory.config_history.before IS
    '変更前の値の射影。生の値は持たない。';
COMMENT ON COLUMN factory.config_history.after IS
    '変更後の値の射影。生の値は持たない。';
COMMENT ON COLUMN factory.config_history.source IS
    '書いた経路。console(Consoleの設定の更新)、stop_all(Consoleの全停止)、out_of_band(Consoleの外の変更。定期の照合が書くために予約)。';
COMMENT ON COLUMN factory.config_history.prev_hash IS
    '1つ前の行のrow_hash。最初の行は0を64個並べた文字列である。';
COMMENT ON COLUMN factory.config_history.row_hash IS
    'この行のsha256(16進)。算出の形はconfig_history_row_hashの定義にある。config_history_verifyが再計算して照合する。';

-- ハッシュの材料にする1項目。NULLは`~`、それ以外は`<バイト長>:<値>`にして、区切りの文字が値に含まれても、境界が曖昧にならないようにする。
CREATE FUNCTION factory.config_history_field(v text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
    SELECT CASE WHEN v IS NULL THEN '~' ELSE octet_length(v)::text || ':' || v END
$fn$;

-- 行のハッシュ。追記と検証が、この1つの関数を使う。
-- 時刻は、接続の時刻帯に左右されないよう、UTCのマイクロ秒までの固定の形で文字列にする。
CREATE FUNCTION factory.config_history_row_hash(
    p_prev_hash text,
    p_seq integer,
    p_item_key text,
    p_reason_code text,
    p_before jsonb,
    p_after jsonb,
    p_actor text,
    p_source text,
    p_occurred_at timestamptz
) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE
AS $fn$
    SELECT encode(
        sha256(
            convert_to(
                factory.config_history_field(p_prev_hash)
                || '|' || factory.config_history_field(p_seq::text)
                || '|' || factory.config_history_field(p_item_key)
                || '|' || factory.config_history_field(p_reason_code)
                || '|' || factory.config_history_field(p_before::text)
                || '|' || factory.config_history_field(p_after::text)
                || '|' || factory.config_history_field(p_actor)
                || '|' || factory.config_history_field(p_source)
                || '|' || factory.config_history_field(to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
                'UTF8'
            )
        ),
        'hex'
    )
$fn$;

-- 連鎖の鍵。連鎖は1本なので、鍵は1つである。
CREATE FUNCTION factory.config_history_lock_key() RETURNS bigint
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
    SELECT hashtextextended('factory.config_history', 0)
$fn$;

-- 連鎖の末尾に1行を足し、行のidを返す。
-- 連鎖の鍵のadvisory lockをトランザクションの終わりまで持ち、並行する追記が、同じseqを取らないようにする。
-- lockの待ちは、接続のlock_timeoutに従う。lockを持つのはこの関数のトランザクションだけで、追記は1行の挿入なので、待ちは短い。
-- 時刻を省くと、呼び出しの時刻を使う。
CREATE FUNCTION factory.config_history_append(
    p_item_key text,
    p_reason_code text,
    p_before jsonb,
    p_after jsonb,
    p_actor text,
    p_source text,
    p_occurred_at timestamptz DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_seq integer;
    v_prev text;
    v_at timestamptz;
    v_id bigint;
BEGIN
    PERFORM pg_advisory_xact_lock(factory.config_history_lock_key());

    SELECT h.seq, h.row_hash INTO v_seq, v_prev
    FROM factory.config_history h
    ORDER BY h.seq DESC
    LIMIT 1;

    IF NOT FOUND THEN
        v_seq := 0;
        v_prev := repeat('0', 64);
    END IF;
    v_seq := v_seq + 1;
    v_at := coalesce(p_occurred_at, clock_timestamp());

    INSERT INTO factory.config_history (
        seq, item_key, reason_code, before, after, actor, source, occurred_at, prev_hash, row_hash
    )
    VALUES (
        v_seq, p_item_key, p_reason_code, p_before, p_after, p_actor, p_source, v_at, v_prev,
        factory.config_history_row_hash(
            v_prev, v_seq, p_item_key, p_reason_code, p_before, p_after, p_actor, p_source, v_at
        )
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END
$fn$;

-- 追記専用の歯止め。掃除の例外は無い。
CREATE FUNCTION factory.config_history_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
    RAISE EXCEPTION 'factory.config_history is append-only: % is rejected', TG_OP
        USING ERRCODE = 'insufficient_privilege';
END
$fn$;

-- 連鎖を検証する。ハッシュを再計算し、prev_hashのつながりと、seqが1から欠けずに続くことを確かめる。
-- 壊れた位置を、行のseqと理由つきで、seqの昇順にすべて返す。
-- reasonは、gap(seqの欠け。最初の行が1でない場合を含む)、prev_hash_mismatch(前の行のハッシュと合わない)、
-- row_hash_mismatch(行の内容から求めたハッシュと合わない)のどれかである。
-- 連鎖の末尾の行を消した場合と、連鎖を丸ごと消した場合は、この関数では検出できない。
CREATE FUNCTION factory.config_history_verify()
RETURNS TABLE (bad_seq integer, reason text)
LANGUAGE sql STABLE
AS $fn$
    WITH ordered AS (
        SELECT
            h.seq,
            h.prev_hash,
            h.row_hash,
            lag(h.seq) OVER w AS prev_seq,
            lag(h.row_hash) OVER w AS prev_row_hash,
            factory.config_history_row_hash(
                h.prev_hash, h.seq, h.item_key, h.reason_code, h.before, h.after, h.actor, h.source, h.occurred_at
            ) AS expected_hash
        FROM factory.config_history h
        WINDOW w AS (ORDER BY h.seq)
    ),
    problems AS (
        SELECT
            o.seq,
            CASE
                WHEN o.prev_seq IS NULL AND o.seq <> 1 THEN 'gap'
                WHEN o.prev_seq IS NOT NULL AND o.seq <> o.prev_seq + 1 THEN 'gap'
                WHEN o.prev_seq IS NULL AND o.prev_hash <> repeat('0', 64) THEN 'prev_hash_mismatch'
                WHEN o.prev_seq IS NOT NULL AND o.prev_hash <> o.prev_row_hash THEN 'prev_hash_mismatch'
                WHEN o.row_hash <> o.expected_hash THEN 'row_hash_mismatch'
            END AS problem
        FROM ordered o
    )
    SELECT p.seq, p.problem
    FROM problems p
    WHERE p.problem IS NOT NULL
    ORDER BY p.seq
$fn$;

CREATE TRIGGER config_history_guard_row
    BEFORE UPDATE OR DELETE ON factory.config_history
    FOR EACH ROW EXECUTE FUNCTION factory.config_history_guard();

CREATE TRIGGER config_history_guard_truncate
    BEFORE TRUNCATE ON factory.config_history
    FOR EACH STATEMENT EXECUTE FUNCTION factory.config_history_guard();

END;
