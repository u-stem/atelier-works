-- up migration: history_events
--
-- 作業項目の状態遷移を、追記専用で、ハッシュでつないで残す。
-- history_events: 遷移1つにつき1行。作業項目ごとに連番(seq)を振り、1つ前の行のハッシュ(prev_hash)を含めて自分のハッシュ(row_hash)を求める。
--   work_item_idは外部キーを持たず、値だけで参照する。作業項目とwork_item_eventsが消えても、履歴は残す。
--   連鎖は作業項目ごとなので、1つの連鎖を丸ごと消しても、ほかの連鎖は壊れない。
--   detailは、元のwork_item_eventsの行のid(event_id)と注記の文字数(note_chars)だけを持つ。注記の本文は、外から来た文字列を含みうるので、複写しない。
--   reason_codeは、注記の先頭から決める(history_reason_code)。注記が空か、どの規則にも当たらなければ`unspecified`になる。
-- 書き込みは、work_item_eventsのAFTER INSERTトリガーが行う。アプリのSQL文は変えず、すべての挿入の経路(db.ts、Consoleの中止、migration)を同じ文の中で拾う。
-- 追記専用の歯止め: UPDATE、DELETE、TRUNCATEを例外で拒む。
--   トランザクションの中で`factory.history_prune`を`on`にしたときだけ通す。掃除(history_prune_chains)がこの印を立てる。
--   歯止めは安全柵で、表の所有者はトリガーを外せる。改ざんは、ハッシュの連鎖がhistory_verifyで検出する。
-- ハッシュ: 次の項目を、この順に`<バイト長>:<値>`の形(NULLは`~`)で並べ、`|`でつないだ文字列のsha256(16進)である。
--   prev_hash、work_item_id、seq、kind、reason_code、from_status、to_status、actor、detail(jsonbの文字列表現)、
--   occurred_at(UTC、`YYYY-MM-DD"T"HH24:MI:SS.US"Z"`)。最初の行のprev_hashは、0を64個並べた文字列である。
-- 検証はSQL(history_verify)で行い、言語をまたぐ正規化を持たない。
-- 追加だけで、既存の表と列は変えない。既存のwork_item_eventsの行は、この移行の中で、(occurred_at, id)の順に1回だけ取り込む。

BEGIN;

SET LOCAL lock_timeout = '30s';

-- 取り込みとトリガーの作成の間に、新しい遷移が挟まって履歴から漏れないよう、書き込みだけを止める。読み取りは止めない。
LOCK TABLE factory.work_item_events IN SHARE ROW EXCLUSIVE MODE;

-- 理由コードの一覧。TypeScriptの`HISTORY_REASON_CODES`と同じ並びにする(実DBの検査が照合する)。
CREATE FUNCTION factory.history_reason_codes() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
    SELECT ARRAY[
        'auto_retry',
        'auto_retry_stalled',
        'auto_retry_launch_failed',
        'manual_retry',
        'operator_cancelled',
        'pr_fix_design_gap',
        'implement_design_gap',
        'implement_design_gap_exhausted',
        'pr_fix_apply',
        'reconcile',
        'isolation_gate_closed',
        'intake_refreshed',
        'approval_redispatch',
        'superseded_by_newer_cycle',
        'ci_round',
        'conflict_round',
        'unspecified'
    ]::text[]
$fn$;

-- 注記の先頭と移り先の状態から、理由コードを決める。どれにも当たらなければ`unspecified`を返す。
-- 人の中止と新しいサイクルによる取り消しは、注記の完全一致に加えて、移り先が`cancelled`であることを求める。
CREATE FUNCTION factory.history_reason_code(note text, to_status text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
    SELECT CASE
        WHEN note IS NULL THEN 'unspecified'
        WHEN starts_with(note, 'auto_retry_stalled:') THEN 'auto_retry_stalled'
        WHEN starts_with(note, 'auto_retry_launch_failed:') THEN 'auto_retry_launch_failed'
        WHEN starts_with(note, 'auto_retry:') THEN 'auto_retry'
        WHEN starts_with(note, 'retry_work_item:') THEN 'manual_retry'
        WHEN to_status = 'cancelled' AND note = 'console: operator_cancelled' THEN 'operator_cancelled'
        WHEN starts_with(note, 'pr_fix design gap:') THEN 'pr_fix_design_gap'
        WHEN starts_with(note, 'implement design gap exhausted:') THEN 'implement_design_gap_exhausted'
        WHEN starts_with(note, 'implement design gap:') THEN 'implement_design_gap'
        WHEN starts_with(note, 'pr_fix_apply:') THEN 'pr_fix_apply'
        WHEN starts_with(note, 'reconcile:') THEN 'reconcile'
        WHEN starts_with(note, 'isolation gate closed:') THEN 'isolation_gate_closed'
        WHEN starts_with(note, 'intake refreshed from the current issue') THEN 'intake_refreshed'
        WHEN starts_with(note, 'approval handler restarted for request ') THEN 'approval_redispatch'
        WHEN to_status = 'cancelled' AND starts_with(note, 'superseded by a newer cycle') THEN 'superseded_by_newer_cycle'
        WHEN starts_with(note, 'ci round:') THEN 'ci_round'
        WHEN starts_with(note, 'conflict round:') THEN 'conflict_round'
        ELSE 'unspecified'
    END
$fn$;

CREATE TABLE factory.history_events (
    id bigserial PRIMARY KEY,
    work_item_id bigint NOT NULL,
    seq integer NOT NULL,
    kind text NOT NULL,
    reason_code text NOT NULL,
    from_status text,
    to_status text NOT NULL,
    actor text NOT NULL DEFAULT 'factory',
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL,
    prev_hash text NOT NULL,
    row_hash text NOT NULL,
    CONSTRAINT history_events_work_item_seq_key UNIQUE (work_item_id, seq),
    CONSTRAINT history_events_seq_check CHECK (seq >= 1),
    CONSTRAINT history_events_kind_check CHECK (kind IN ('transition')),
    CONSTRAINT history_events_reason_code_check CHECK (reason_code = ANY (factory.history_reason_codes()))
);

CREATE INDEX history_events_occurred_at_idx ON factory.history_events (occurred_at);

COMMENT ON TABLE factory.history_events IS
    '作業項目の状態遷移の、追記専用でハッシュの連鎖を持つ履歴。work_item_eventsのAFTER INSERTトリガーが書く。作業項目が消えても残る。';
COMMENT ON COLUMN factory.history_events.work_item_id IS
    '作業項目のid。外部キーを持たず、値だけで参照する。';
COMMENT ON COLUMN factory.history_events.seq IS
    '作業項目ごとの連番(1から)。';
COMMENT ON COLUMN factory.history_events.kind IS
    '履歴の種類。今はtransition(状態遷移)だけである。';
COMMENT ON COLUMN factory.history_events.reason_code IS
    '遷移の理由コード。注記の先頭から決めるので、注記を書く側が明示した値ではない。決められなければunspecifiedである。';
COMMENT ON COLUMN factory.history_events.detail IS
    '元の遷移の記録の参照(event_id)と注記の文字数(note_chars)。移行で取り込んだ行はbackfilledがtrueである。注記の本文は持たない。';
COMMENT ON COLUMN factory.history_events.prev_hash IS
    '同じ作業項目の1つ前の行のrow_hash。最初の行は0を64個並べた文字列である。';
COMMENT ON COLUMN factory.history_events.row_hash IS
    'この行のsha256(16進)。算出の形はhistory_row_hashの定義にある。history_verifyが再計算して照合する。';

-- ハッシュの材料にする1項目。NULLは`~`、それ以外は`<バイト長>:<値>`にして、区切りの文字が値に含まれても、境界が曖昧にならないようにする。
CREATE FUNCTION factory.history_field(v text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
    SELECT CASE WHEN v IS NULL THEN '~' ELSE octet_length(v)::text || ':' || v END
$fn$;

-- 行のハッシュ。トリガーと検証が、この1つの関数を使う。
-- 時刻は、接続の時刻帯に左右されないよう、UTCのマイクロ秒までの固定の形で文字列にする。
CREATE FUNCTION factory.history_row_hash(
    p_prev_hash text,
    p_work_item_id bigint,
    p_seq integer,
    p_kind text,
    p_reason_code text,
    p_from_status text,
    p_to_status text,
    p_actor text,
    p_detail jsonb,
    p_occurred_at timestamptz
) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE
AS $fn$
    SELECT encode(
        sha256(
            convert_to(
                factory.history_field(p_prev_hash)
                || '|' || factory.history_field(p_work_item_id::text)
                || '|' || factory.history_field(p_seq::text)
                || '|' || factory.history_field(p_kind)
                || '|' || factory.history_field(p_reason_code)
                || '|' || factory.history_field(p_from_status)
                || '|' || factory.history_field(p_to_status)
                || '|' || factory.history_field(p_actor)
                || '|' || factory.history_field(p_detail::text)
                || '|' || factory.history_field(to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
                'UTF8'
            )
        ),
        'hex'
    )
$fn$;

-- 作業項目ごとのadvisory lockの鍵。同じ作業項目への追記と、連鎖の掃除を直列にする。
CREATE FUNCTION factory.history_lock_key(p_work_item_id bigint) RETURNS bigint
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
    SELECT hashtextextended('factory.history_events:' || p_work_item_id::text, 0)
$fn$;

-- 連鎖の末尾に1行を足し、行のidを返す。advisory lockは取らない。
-- 呼び出す側が、同じ作業項目への並行する追記が起きないことを保証する。
-- 起きうる経路は、lockを取る`history_append`を使い、取り込みは、書き込みを止めた上で、直接使う。
CREATE FUNCTION factory.history_append_unlocked(
    p_work_item_id bigint,
    p_kind text,
    p_reason_code text,
    p_from_status text,
    p_to_status text,
    p_actor text,
    p_detail jsonb,
    p_occurred_at timestamptz
) RETURNS bigint
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_seq integer;
    v_prev text;
    v_id bigint;
BEGIN
    SELECT h.seq, h.row_hash INTO v_seq, v_prev
    FROM factory.history_events h
    WHERE h.work_item_id = p_work_item_id
    ORDER BY h.seq DESC
    LIMIT 1;

    IF NOT FOUND THEN
        v_seq := 0;
        v_prev := repeat('0', 64);
    END IF;
    v_seq := v_seq + 1;

    INSERT INTO factory.history_events (
        work_item_id, seq, kind, reason_code, from_status, to_status, actor, detail, occurred_at, prev_hash, row_hash
    )
    VALUES (
        p_work_item_id, v_seq, p_kind, p_reason_code, p_from_status, p_to_status, p_actor, p_detail, p_occurred_at, v_prev,
        factory.history_row_hash(
            v_prev, p_work_item_id, v_seq, p_kind, p_reason_code, p_from_status, p_to_status, p_actor, p_detail, p_occurred_at
        )
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END
$fn$;

-- 連鎖の末尾に1行を足し、行のidを返す。
-- 作業項目のadvisory lockをトランザクションの終わりまで持ち、同じ作業項目への並行する追記が、同じseqを取らないようにする。
CREATE FUNCTION factory.history_append(
    p_work_item_id bigint,
    p_kind text,
    p_reason_code text,
    p_from_status text,
    p_to_status text,
    p_actor text,
    p_detail jsonb,
    p_occurred_at timestamptz
) RETURNS bigint
LANGUAGE plpgsql
AS $fn$
BEGIN
    PERFORM pg_advisory_xact_lock(factory.history_lock_key(p_work_item_id));

    RETURN factory.history_append_unlocked(
        p_work_item_id, p_kind, p_reason_code, p_from_status, p_to_status, p_actor, p_detail, p_occurred_at
    );
END
$fn$;

-- work_item_eventsの行を、履歴の遷移として足す。注記の本文は複写せず、文字数だけを残す。
CREATE FUNCTION factory.history_record_transition() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
    PERFORM factory.history_append(
        NEW.work_item_id,
        'transition',
        factory.history_reason_code(NEW.note, NEW.to_status),
        NEW.from_status,
        NEW.to_status,
        'factory',
        jsonb_build_object('event_id', NEW.id, 'note_chars', char_length(NEW.note)),
        NEW.occurred_at
    );
    RETURN NULL;
END
$fn$;

-- 追記専用の歯止め。`factory.history_prune`が`on`のトランザクションだけ、書き換えと削除を通す。
CREATE FUNCTION factory.history_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
    IF coalesce(current_setting('factory.history_prune', true), '') = 'on' THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        IF TG_OP = 'UPDATE' THEN
            RETURN NEW;
        END IF;
        RETURN NULL;
    END IF;
    RAISE EXCEPTION 'factory.history_events is append-only: % is rejected', TG_OP
        USING ERRCODE = 'insufficient_privilege';
END
$fn$;

-- 連鎖を検証する。ハッシュを再計算し、prev_hashのつながりと、seqが1から欠けずに続くことを確かめる。
-- 壊れた連鎖だけを、最初に壊れた行のseqと理由つきで返す。作業項目を指定しなければ、すべての連鎖を調べる。
-- reasonは、gap(seqの欠け。最初の行が1でない場合を含む)、prev_hash_mismatch(前の行のハッシュと合わない)、
-- row_hash_mismatch(行の内容から求めたハッシュと合わない)のどれかである。
-- 連鎖の末尾の行を消した場合と、連鎖を丸ごと消した場合は、この関数では検出できない。
CREATE FUNCTION factory.history_verify(p_work_item_id bigint DEFAULT NULL)
RETURNS TABLE (work_item_id bigint, first_bad_seq integer, reason text)
LANGUAGE sql STABLE
AS $fn$
    WITH ordered AS (
        SELECT
            h.work_item_id AS wid,
            h.seq,
            h.prev_hash,
            h.row_hash,
            lag(h.seq) OVER w AS prev_seq,
            lag(h.row_hash) OVER w AS prev_row_hash,
            factory.history_row_hash(
                h.prev_hash, h.work_item_id, h.seq, h.kind, h.reason_code, h.from_status, h.to_status, h.actor, h.detail, h.occurred_at
            ) AS expected_hash
        FROM factory.history_events h
        WHERE p_work_item_id IS NULL OR h.work_item_id = p_work_item_id
        WINDOW w AS (PARTITION BY h.work_item_id ORDER BY h.seq)
    ),
    problems AS (
        SELECT
            o.wid,
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
    SELECT p.wid, min(p.seq)::integer, (array_agg(p.problem ORDER BY p.seq))[1]
    FROM problems p
    WHERE p.problem IS NOT NULL
    GROUP BY p.wid
    ORDER BY p.wid
$fn$;

-- 作業項目がもう無く、最後の記録が`p_before`より古い連鎖を、丸ごと消す。連鎖の一部だけは消さない。
-- 作業項目が残る連鎖は、古くても消さない。消すと、次の遷移が1から始まり、前の履歴が欠けたまま検証を通ってしまうためである。
-- 掃除の印を立てるのはこの関数の中なので、呼び出す側は、1つの文で掃除を行える。
-- 消す連鎖ごとに、追記と同じadvisory lockを、待たずに取る。取れない連鎖は、使われている最中なので飛ばし、次の掃除に任せる。
-- 待たないので、複数の連鎖へ書くトランザクションと、lockを待ち合って止まることがない。
-- lockを取った後で最後の記録の時刻を確かめ直す。掃除の間に新しい遷移が足された連鎖を、先頭の欠けた連鎖にしないためである。
-- 1回に消す連鎖は1000件までにする。1つのトランザクションが持つadvisory lockの数を抑えるためで、残りは次の掃除が消す。
-- 印は、呼び出しの前の値に戻してから返る。
CREATE FUNCTION factory.history_prune_chains(p_before timestamptz)
RETURNS TABLE (chains_deleted bigint, events_deleted bigint)
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_previous text;
    v_work_item_id bigint;
    v_rows bigint;
    v_chains bigint := 0;
    v_events bigint := 0;
BEGIN
    v_previous := coalesce(current_setting('factory.history_prune', true), '');
    PERFORM set_config('factory.history_prune', 'on', true);

    FOR v_work_item_id IN
        SELECT h.work_item_id
        FROM factory.history_events h
        WHERE NOT EXISTS (SELECT 1 FROM factory.work_items w WHERE w.id = h.work_item_id)
        GROUP BY h.work_item_id
        HAVING max(h.occurred_at) < p_before
        ORDER BY h.work_item_id
        LIMIT 1000
    LOOP
        IF NOT pg_try_advisory_xact_lock(factory.history_lock_key(v_work_item_id)) THEN
            CONTINUE;
        END IF;
        DELETE FROM factory.history_events e
        WHERE e.work_item_id = v_work_item_id
          AND NOT EXISTS (
              SELECT 1 FROM factory.history_events n
              WHERE n.work_item_id = v_work_item_id AND n.occurred_at >= p_before
          );
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows > 0 THEN
            v_chains := v_chains + 1;
            v_events := v_events + v_rows;
        END IF;
    END LOOP;

    PERFORM set_config('factory.history_prune', v_previous, true);
    RETURN QUERY SELECT v_chains, v_events;
END
$fn$;

-- 既存のwork_item_eventsの行を、(occurred_at, id)の順に、履歴の連鎖へ取り込む。
-- 行の順は作業項目ごとの連鎖の順になる。トリガーは、この後で作るので、取り込んだ行を二重に書かない。
-- 履歴の表はこの移行が作ったばかりで、work_item_eventsへの書き込みは止めてあるので、連鎖ごとのadvisory lockは取らない。
-- 取ると、作業項目の数だけlockが1つのトランザクションに積み上がり、共有のロック表を使い切るおそれがある。
DO $do$
DECLARE
    e record;
BEGIN
    FOR e IN
        SELECT id, work_item_id, from_status, to_status, note, occurred_at
        FROM factory.work_item_events
        ORDER BY occurred_at, id
    LOOP
        PERFORM factory.history_append_unlocked(
            e.work_item_id,
            'transition',
            factory.history_reason_code(e.note, e.to_status),
            e.from_status,
            e.to_status,
            'factory',
            jsonb_build_object('event_id', e.id, 'note_chars', char_length(e.note), 'backfilled', true),
            e.occurred_at
        );
    END LOOP;
END
$do$;

CREATE TRIGGER history_events_record
    AFTER INSERT ON factory.work_item_events
    FOR EACH ROW EXECUTE FUNCTION factory.history_record_transition();

CREATE TRIGGER history_events_guard_row
    BEFORE UPDATE OR DELETE ON factory.history_events
    FOR EACH ROW EXECUTE FUNCTION factory.history_guard();

CREATE TRIGGER history_events_guard_truncate
    BEFORE TRUNCATE ON factory.history_events
    FOR EACH STATEMENT EXECUTE FUNCTION factory.history_guard();

END;
