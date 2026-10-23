-- up migration: holds
--
-- 共通の保留(hold)の表を作る。「この対象を進めないで」を、期限つきで伝える。
-- 止めるためだけに使い、保留があることが何かを許可することはない。
--
-- scope: merge(自動マージを止める。複数の主体が独立に重ねられ、有効な行が1件でもあれば止める)と、
--   claim(Issueの取り込みを止める。対象ごとに排他)。
-- target: mergeはowner/repo、claimはowner/repo#number。小文字にそろえる。
-- holder_kind / holder: 置いた主体の名乗り。認証ではない。
--   holderは、sessionが`session:<ブランチ>`、humanが`human`、factoryが`factory:<ジョブ名>`。
-- created_at: 既定はnow()。書き手は列を渡せるので、上限は読み取りの有効条件(lib/holds.ts)でも効かせる。
-- expires_at: created_atから24時間以内。延長は設けず、続けるときは解除して置き直す。
-- released_at / released_by: 同時にNULLか、同時にNULLでない。
--   released_byは、期限切れを閉じた行がexpired、未来のcreated_atや上限超えの行を閉じたときがinvalid、
--   解除したときは解除した主体のholder。
--   released_atとcreated_atの大小はCHECKにしない。
--   未来のcreated_atの行をinvalidで閉じるときに、released_atがcreated_atより前になるため。
-- 行は消さず、履歴として残す。保存期間は後の段で定める。
--
-- 部分一意インデックスは、未解除の行だけを対象にする。
--   merge: (scope, target, holder)。同じ主体の二重置きを拒否し、別の主体は重ねられる。
--   claim: (scope, target)。排他。
-- 置く操作は、先に有効でない未解除の行を閉じてから挿入するので、期限切れの行は置く操作を塞がない。
--
-- 反映はsync pushの後にmigrate upの順である。
-- 表を読むコードは、このmigrationが適用されるまで反映されない。
-- lock_timeoutは、1つのロックごとの待ちの上限である。
-- 新しい表の作成にロックの競合はほぼ無いが、止まった書き込みがあればmigrationは失敗する(self_updateが再試行する)。
BEGIN;

SET LOCAL lock_timeout = '30s';

CREATE TABLE factory.holds (
    id bigserial PRIMARY KEY,
    scope text NOT NULL,
    target text NOT NULL,
    reason text NOT NULL,
    holder_kind text NOT NULL,
    holder text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    released_at timestamptz,
    released_by text,
    CONSTRAINT holds_scope_check CHECK (scope IN ('merge', 'claim')),
    CONSTRAINT holds_target_check CHECK (target = lower(target) AND target <> ''),
    CONSTRAINT holds_reason_check CHECK (char_length(reason) BETWEEN 1 AND 200),
    CONSTRAINT holds_holder_kind_check CHECK (holder_kind IN ('session', 'human', 'factory')),
    CONSTRAINT holds_holder_check CHECK (char_length(holder) BETWEEN 1 AND 100),
    CONSTRAINT holds_expiry_check CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours'),
    CONSTRAINT holds_released_check CHECK ((released_at IS NULL) = (released_by IS NULL)),
    CONSTRAINT holds_released_by_check CHECK (released_by IS NULL OR char_length(released_by) BETWEEN 1 AND 100)
);

CREATE UNIQUE INDEX holds_active_merge_key ON factory.holds (scope, target, holder)
    WHERE released_at IS NULL AND scope = 'merge';

CREATE UNIQUE INDEX holds_active_claim_key ON factory.holds (scope, target)
    WHERE released_at IS NULL AND scope = 'claim';

CREATE INDEX holds_active_target_idx ON factory.holds (scope, target)
    WHERE released_at IS NULL;

COMMENT ON TABLE factory.holds IS
    '共通の保留。対象を進めないことを、期限つきで伝える。止めるためだけに使い、許可には使わない。有効の条件は、未解除で、created_atがnow()以前で、expires_atがnow()より後で、expires_atがcreated_atから24時間以内。';

COMMENT ON COLUMN factory.holds.scope IS
    'merge(自動マージ。主体ごとに重ねられる)かclaim(Issueの取り込み。排他)。';

COMMENT ON COLUMN factory.holds.target IS
    '小文字。mergeはowner/repo、claimはowner/repo#number。';

COMMENT ON COLUMN factory.holds.holder IS
    '置いた主体の名乗り。認証ではない。session:<ブランチ>、human、factory:<ジョブ名>。';

COMMENT ON COLUMN factory.holds.released_by IS
    '閉じた理由か主体。期限切れはexpired、未来のcreated_atや上限超えの行はinvalid、解除は解除した主体のholder。';

END;
