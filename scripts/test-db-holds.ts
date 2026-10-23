// `mise run test:db`の一部。migrationを適用した使い捨てデータベースで、保留の表`factory.holds`の
// 制約と、`lib/holds.ts`が組み立てるSQL文を、本物のPostgreSQLで確かめる。
// 値を埋め込む検査用の`SqlClient`で流すので、`wmill.datatable()`の束縛の経路は通らない。
//
// 使い方: COMPOSE_FILE=<compose> SCRATCH_DB=<db> bun run scripts/test-db-holds.ts

import {
  HOLD_ALREADY_ACTIVE,
  type HoldActor,
  listActiveHolds,
  listInvalidHolds,
  type PlaceInput,
  placeHold,
  releaseHold,
} from "../f/factory/lib/holds.ts";
import { createPsqlClient, execPsql, type PsqlTarget } from "./test-db-sql.ts";

const composeFile = process.env.COMPOSE_FILE;
const database = process.env.SCRATCH_DB;
if (composeFile === undefined || database === undefined) {
  console.error("COMPOSE_FILE and SCRATCH_DB are required");
  process.exit(2);
}
const target: PsqlTarget = { composeFile, database };
const sql = createPsqlClient(target);

const failures: string[] = [];
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`[test-db-holds] ok: ${name}`);
    return;
  }
  failures.push(name);
  console.error(
    `[test-db-holds] FAILED: ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`,
  );
}

/** 文が成功したら真を返す。 */
function accepts(statement: string): boolean {
  try {
    execPsql(target, statement);
    return true;
  } catch {
    return false;
  }
}

/**
 * 文が、名前が`constraint`の制約への違反で失敗したら真を返す。
 * 構文の誤りなど別の理由の失敗を、制約が拒否したと取り違えないよう、制約の名前まで照合する。
 */
function rejects(statement: string, constraint: string): boolean {
  try {
    execPsql(target, statement);
    return false;
  } catch (err) {
    return err instanceof Error && err.message.includes(`"${constraint}"`);
  }
}

const PREFIX = "qh";
const HUMAN: HoldActor = { kind: "human", holder: "human" };
const SESSION_A: HoldActor = { kind: "session", holder: "session:a" };
const SESSION_B: HoldActor = { kind: "session", holder: "session:b" };

function input(
  scope: "merge" | "claim",
  targetName: string,
  actor: HoldActor,
  minutes = 60,
): PlaceInput {
  return {
    scope,
    target: targetName,
    reason: "probe",
    holder_kind: actor.kind,
    holder: actor.holder,
    minutes,
  };
}

/** 検査用に行を直接入れる。時刻は`now()`からの区間で渡す。 */
function insertRaw(
  scope: string,
  targetName: string,
  holder: string,
  created: string,
  expires: string,
): void {
  execPsql(
    target,
    `INSERT INTO factory.holds (scope, target, reason, holder_kind, holder, created_at, expires_at) VALUES ('${scope}', '${targetName}', 'probe', 'session', '${holder}', now() + interval '${created}', now() + interval '${expires}')`,
  );
}

async function rowsOf(targetName: string): Promise<Record<string, unknown>[]> {
  return await sql`
    SELECT id, holder, released_by, released_at IS NOT NULL AS released
    FROM factory.holds WHERE target = ${targetName} ORDER BY id
  `.fetch();
}

// ---------------------------------------------------------------------------
// merge: 別の主体は重ねられ、同じ主体は二重に置けない
// ---------------------------------------------------------------------------

const MERGE_TARGET = `${PREFIX}/merge`;
const firstMerge = await placeHold(
  input("merge", MERGE_TARGET, SESSION_A),
  sql,
);
check(
  "placeHold: a merge hold is placed on an empty target",
  firstMerge.ok,
  firstMerge,
);

const secondMerge = await placeHold(
  input("merge", MERGE_TARGET, SESSION_B),
  sql,
);
check(
  "placeHold: a merge hold of another holder is stacked on an active one",
  secondMerge.ok,
  secondMerge,
);

const doubleMerge = await placeHold(
  input("merge", MERGE_TARGET, SESSION_A),
  sql,
);
check(
  "placeHold: the same holder cannot place a merge hold twice",
  !doubleMerge.ok && doubleMerge.reason === HOLD_ALREADY_ACTIVE,
  doubleMerge,
);

const activeMerge = await listActiveHolds(
  { scope: "merge", target: MERGE_TARGET },
  sql,
);
check(
  "listActiveHolds: returns both merge holds of the target",
  activeMerge.ok && activeMerge.value.length === 2,
  activeMerge,
);

// ---------------------------------------------------------------------------
// 期限: make_interval(mins => n::integer)がDBで期限を作る
// ---------------------------------------------------------------------------

const MINUTES_TARGET = `${PREFIX}/minutes`;
await placeHold(input("merge", MINUTES_TARGET, SESSION_A, 90), sql);
const minutesRows = await sql`
  SELECT (expires_at - created_at = interval '90 minutes') AS exact
  FROM factory.holds WHERE target = ${MINUTES_TARGET}
`.fetch();
check(
  "placeHold: the database computes the expiry from the minutes",
  minutesRows.length === 1 && minutesRows[0]?.exact === true,
  minutesRows,
);

// ---------------------------------------------------------------------------
// 期限切れと無効な行: 置く操作の文(1)が閉じる
// ---------------------------------------------------------------------------

const EXPIRED_TARGET = `${PREFIX}/expired`;
insertRaw("merge", EXPIRED_TARGET, SESSION_A.holder, "-2 hours", "-1 hour");
const beforeExpired = await listInvalidHolds(
  { scope: "merge", target: EXPIRED_TARGET },
  sql,
);
check(
  "listInvalidHolds: an unreleased expired row is listed",
  beforeExpired.ok && beforeExpired.value.length === 1,
  beforeExpired,
);
const afterExpiredPlace = await placeHold(
  input("merge", EXPIRED_TARGET, SESSION_A),
  sql,
);
const expiredRows = await rowsOf(EXPIRED_TARGET);
check(
  "placeHold: a hold is placed on a target whose old row has expired",
  afterExpiredPlace.ok,
  afterExpiredPlace,
);
check(
  "placeHold: the expired row is closed as expired",
  expiredRows[0]?.released === true &&
    expiredRows[0]?.released_by === "expired",
  expiredRows,
);

const FUTURE_TARGET = `${PREFIX}/future`;
insertRaw("merge", FUTURE_TARGET, SESSION_A.holder, "1 hour", "2 hours");
const futureActive = await listActiveHolds(
  { scope: "merge", target: FUTURE_TARGET },
  sql,
);
check(
  "listActiveHolds: a row created in the future is not active",
  futureActive.ok && futureActive.value.length === 0,
  futureActive,
);
const futureInvalid = await listInvalidHolds(
  { scope: "merge", target: FUTURE_TARGET },
  sql,
);
check(
  "listInvalidHolds: a row created in the future is listed",
  futureInvalid.ok && futureInvalid.value.length === 1,
  futureInvalid,
);
const afterFuturePlace = await placeHold(
  input("merge", FUTURE_TARGET, SESSION_A),
  sql,
);
const futureRows = await rowsOf(FUTURE_TARGET);
check(
  "placeHold: a row created in the future does not block placing",
  afterFuturePlace.ok,
  afterFuturePlace,
);
check(
  "placeHold: the row created in the future is closed as invalid",
  futureRows[0]?.released === true && futureRows[0]?.released_by === "invalid",
  futureRows,
);

// ---------------------------------------------------------------------------
// claim: 排他
// ---------------------------------------------------------------------------

const CLAIM_TARGET = `${PREFIX}/claim#1`;
const firstClaim = await placeHold(
  input("claim", CLAIM_TARGET, SESSION_A),
  sql,
);
const rivalClaim = await placeHold(
  input("claim", CLAIM_TARGET, SESSION_B),
  sql,
);
check("placeHold: a claim hold is placed", firstClaim.ok, firstClaim);
check(
  "placeHold: a claim hold is exclusive across holders",
  !rivalClaim.ok && rivalClaim.reason === HOLD_ALREADY_ACTIVE,
  rivalClaim,
);
if (firstClaim.ok) {
  const released = await releaseHold(firstClaim.value.id, SESSION_A, sql);
  check("releaseHold: a session releases its own hold", released.ok, released);
}
const claimAfterRelease = await placeHold(
  input("claim", CLAIM_TARGET, SESSION_B),
  sql,
);
check(
  "placeHold: a claim hold can be placed once the earlier one is released",
  claimAfterRelease.ok,
  claimAfterRelease,
);

// claimは排他なので、別のholderの期限切れの行や未来の作成時刻の行も、置く操作の文(1)が閉じる。
const CLAIM_EXPIRED_TARGET = `${PREFIX}/claim-expired#2`;
insertRaw(
  "claim",
  CLAIM_EXPIRED_TARGET,
  SESSION_A.holder,
  "-2 hours",
  "-1 hour",
);
const claimOverExpired = await placeHold(
  input("claim", CLAIM_EXPIRED_TARGET, SESSION_B),
  sql,
);
const claimExpiredRows = await rowsOf(CLAIM_EXPIRED_TARGET);
check(
  "placeHold: a claim hold is placed over an expired row of another holder",
  claimOverExpired.ok,
  claimOverExpired,
);
check(
  "placeHold: the expired claim row of another holder is closed as expired",
  claimExpiredRows[0]?.released === true &&
    claimExpiredRows[0]?.released_by === "expired",
  claimExpiredRows,
);

const CLAIM_FUTURE_TARGET = `${PREFIX}/claim-future#3`;
insertRaw("claim", CLAIM_FUTURE_TARGET, SESSION_A.holder, "1 hour", "2 hours");
const claimOverFuture = await placeHold(
  input("claim", CLAIM_FUTURE_TARGET, SESSION_B),
  sql,
);
const claimFutureRows = await rowsOf(CLAIM_FUTURE_TARGET);
check(
  "placeHold: a claim hold is placed over a row of another holder created in the future",
  claimOverFuture.ok,
  claimOverFuture,
);
check(
  "placeHold: the claim row created in the future is closed as invalid",
  claimFutureRows[0]?.released === true &&
    claimFutureRows[0]?.released_by === "invalid",
  claimFutureRows,
);

// 別の主体が置いたばかりの行は、READ COMMITTEDと`now()`の開始時刻のずれで、作成時刻が自分の文より少し後になりうる。
// 1分以内の差は余裕として閉じず、置く操作は「既に有効な保留がある」で断られる。
const CLAIM_SOON_TARGET = `${PREFIX}/claim-soon#4`;
insertRaw("claim", CLAIM_SOON_TARGET, SESSION_A.holder, "30 seconds", "1 hour");
const claimOverSoon = await placeHold(
  input("claim", CLAIM_SOON_TARGET, SESSION_B),
  sql,
);
const claimSoonRows = await rowsOf(CLAIM_SOON_TARGET);
check(
  "placeHold: a claim row created within the margin after the statement is refused",
  !claimOverSoon.ok && claimOverSoon.reason === HOLD_ALREADY_ACTIVE,
  claimOverSoon,
);
check(
  "placeHold: a claim row created within the margin is not closed",
  claimSoonRows.length === 1 && claimSoonRows[0]?.released === false,
  claimSoonRows,
);
const CLAIM_LATE_TARGET = `${PREFIX}/claim-late#5`;
insertRaw("claim", CLAIM_LATE_TARGET, SESSION_A.holder, "2 minutes", "1 hour");
const claimOverLate = await placeHold(
  input("claim", CLAIM_LATE_TARGET, SESSION_B),
  sql,
);
const claimLateRows = await rowsOf(CLAIM_LATE_TARGET);
check(
  "placeHold: a claim row created beyond the margin is closed as invalid",
  claimOverLate.ok &&
    claimLateRows[0]?.released === true &&
    claimLateRows[0]?.released_by === "invalid",
  { claimOverLate, claimLateRows },
);

// ---------------------------------------------------------------------------
// 解除
// ---------------------------------------------------------------------------

if (claimAfterRelease.ok) {
  const refused = await releaseHold(claimAfterRelease.value.id, SESSION_A, sql);
  check(
    "releaseHold: a session cannot release a hold of another holder",
    !refused.ok,
    refused,
  );
  const byHuman = await releaseHold(claimAfterRelease.value.id, HUMAN, sql);
  check(
    "releaseHold: a human releases a hold of another holder",
    byHuman.ok,
    byHuman,
  );
  const again = await releaseHold(claimAfterRelease.value.id, HUMAN, sql);
  check(
    "releaseHold: a released hold cannot be released twice",
    !again.ok,
    again,
  );
}
const releasedRows = await rowsOf(CLAIM_TARGET);
check(
  "releaseHold: records who released the hold",
  releasedRows.map((row) => row.released_by).join(",") === "session:a,human",
  releasedRows,
);

// ---------------------------------------------------------------------------
// CHECK制約と一意インデックスの直接の検査
// ---------------------------------------------------------------------------

const CHECK_TARGET = `${PREFIX}/check`;
const HOUR = "now() + interval '1 hour'";

/** 検査用の1行のINSERT。`extra`に、既定と違う列とその値を足す。 */
function insertStatement(
  values: {
    scope?: string;
    target?: string;
    reason?: string;
    holderKind?: string;
    holder?: string;
    expires?: string;
  },
  extra: { columns: string; values: string } = { columns: "", values: "" },
): string {
  const scope = values.scope ?? "merge";
  const targetName = values.target ?? CHECK_TARGET;
  const reason = values.reason ?? "probe";
  const holderKind = values.holderKind ?? "session";
  const holder = values.holder ?? "session:c";
  const expires = values.expires ?? HOUR;
  return `INSERT INTO factory.holds (scope, target, reason, holder_kind, holder, expires_at${extra.columns}) VALUES ('${scope}', '${targetName}', '${reason}', '${holderKind}', '${holder}', ${expires}${extra.values})`;
}

const longReason = "a".repeat(201);
const longHolder = "a".repeat(101);
const rejections: readonly (readonly [string, string, string])[] = [
  [
    "an expiry beyond 24 hours",
    insertStatement({ expires: "now() + interval '25 hours'" }),
    "holds_expiry_check",
  ],
  [
    "an expiry not after the creation",
    insertStatement(
      { expires: "now()" },
      { columns: ", created_at", values: ", now()" },
    ),
    "holds_expiry_check",
  ],
  [
    "released_at without released_by",
    insertStatement({}, { columns: ", released_at", values: ", now()" }),
    "holds_released_check",
  ],
  [
    "released_by without released_at",
    insertStatement({}, { columns: ", released_by", values: ", 'human'" }),
    "holds_released_check",
  ],
  [
    "a scope outside merge and claim",
    insertStatement({ scope: "config" }),
    "holds_scope_check",
  ],
  [
    "a holder kind outside the three kinds",
    insertStatement({ holderKind: "robot" }),
    "holds_holder_kind_check",
  ],
  [
    "a target with an uppercase letter",
    insertStatement({ target: "QH/Upper" }),
    "holds_target_check",
  ],
  ["an empty target", insertStatement({ target: "" }), "holds_target_check"],
  ["an empty reason", insertStatement({ reason: "" }), "holds_reason_check"],
  [
    "a reason of 201 characters",
    insertStatement({ reason: longReason }),
    "holds_reason_check",
  ],
  [
    "a holder of 101 characters",
    insertStatement({ holder: longHolder }),
    "holds_holder_check",
  ],
  [
    "a second unreleased merge row of the same holder",
    insertStatement({ target: MERGE_TARGET, holder: SESSION_A.holder }),
    "holds_active_merge_key",
  ],
];
for (const [label, statement, constraint] of rejections) {
  check(
    `constraint ${constraint}: ${label} is rejected`,
    rejects(statement, constraint),
  );
}

check(
  "CHECK: an expiry of exactly 24 hours is accepted",
  accepts(insertStatement({ expires: "now() + interval '24 hours'" })),
);

// 後で適用するdown migrationが表を消すので、検査の行は残してよいが、他の検査に影響しないよう消しておく。
execPsql(target, `DELETE FROM factory.holds WHERE target LIKE '${PREFIX}/%'`);

if (failures.length > 0) {
  console.error(`[test-db-holds] ${String(failures.length)} check(s) failed`);
  process.exit(1);
}
console.log("[test-db-holds] all checks passed");
