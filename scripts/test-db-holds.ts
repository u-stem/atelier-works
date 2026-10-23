// `mise run test:db`の一部。migrationを適用した使い捨てデータベースで、保留の表`factory.holds`の
// 制約と、`lib/holds.ts`が組み立てるSQL文を、本物のPostgreSQLで確かめる。
// 値を埋め込む検査用の`SqlClient`で流すので、`wmill.datatable()`の束縛の経路は通らない。
//
// 使い方: COMPOSE_FILE=<compose> SCRATCH_DB=<db> bun run scripts/test-db-holds.ts

import {
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

/** 文がエラーで失敗したら真を返す。CHECKや一意インデックスが拒否することを確かめるのに使う。 */
function rejects(statement: string): boolean {
  try {
    execPsql(target, statement);
    return false;
  } catch {
    return true;
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
  !doubleMerge.ok,
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
  !rivalClaim.ok,
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
const columns = "(scope, target, reason, holder_kind, holder, expires_at";
check(
  "CHECK: an expiry beyond 24 hours is rejected",
  rejects(
    `INSERT INTO factory.holds ${columns}) VALUES ('merge', '${CHECK_TARGET}', 'probe', 'session', 'session:c', now() + interval '25 hours')`,
  ),
);
check(
  "CHECK: an expiry of exactly 24 hours is accepted",
  !rejects(
    `INSERT INTO factory.holds ${columns}) VALUES ('merge', '${CHECK_TARGET}', 'probe', 'session', 'session:c', now() + interval '24 hours')`,
  ),
);
check(
  "CHECK: an expiry not after the creation is rejected",
  rejects(
    `INSERT INTO factory.holds ${columns}, created_at) VALUES ('merge', '${CHECK_TARGET}', 'probe', 'session', 'session:d', now(), now())`,
  ),
);
check(
  "CHECK: released_at without released_by is rejected",
  rejects(
    `INSERT INTO factory.holds ${columns}, released_at) VALUES ('merge', '${CHECK_TARGET}', 'probe', 'session', 'session:e', now() + interval '1 hour', now())`,
  ),
);
check(
  "CHECK: released_by without released_at is rejected",
  rejects(
    `INSERT INTO factory.holds ${columns}, released_by) VALUES ('merge', '${CHECK_TARGET}', 'probe', 'session', 'session:f', now() + interval '1 hour', 'human')`,
  ),
);
check(
  "CHECK: a scope outside merge and claim is rejected",
  rejects(
    `INSERT INTO factory.holds ${columns}) VALUES ('config', '${CHECK_TARGET}', 'probe', 'session', 'session:g', now() + interval '1 hour')`,
  ),
);
check(
  "CHECK: a holder kind outside the three kinds is rejected",
  rejects(
    `INSERT INTO factory.holds ${columns}) VALUES ('merge', '${CHECK_TARGET}', 'probe', 'robot', 'session:h', now() + interval '1 hour')`,
  ),
);
check(
  "CHECK: a target with an uppercase letter is rejected",
  rejects(
    `INSERT INTO factory.holds ${columns}) VALUES ('merge', 'QH/Upper', 'probe', 'session', 'session:i', now() + interval '1 hour')`,
  ),
);
check(
  "CHECK: an empty reason is rejected",
  rejects(
    `INSERT INTO factory.holds ${columns}) VALUES ('merge', '${CHECK_TARGET}', '', 'session', 'session:j', now() + interval '1 hour')`,
  ),
);
check(
  "CHECK: a reason of 201 characters is rejected",
  rejects(
    `INSERT INTO factory.holds ${columns}) VALUES ('merge', '${CHECK_TARGET}', '${"a".repeat(201)}', 'session', 'session:k', now() + interval '1 hour')`,
  ),
);
check(
  "CHECK: a holder of 101 characters is rejected",
  rejects(
    `INSERT INTO factory.holds ${columns}) VALUES ('merge', '${CHECK_TARGET}', 'probe', 'session', '${"a".repeat(101)}', now() + interval '1 hour')`,
  ),
);
check(
  "unique index: a second unreleased merge row of the same holder is rejected",
  rejects(
    `INSERT INTO factory.holds ${columns}) VALUES ('merge', '${MERGE_TARGET}', 'probe', 'session', '${SESSION_A.holder}', now() + interval '1 hour')`,
  ),
);

// 後で適用するdown migrationが表を消すので、検査の行は残してよいが、他の検査に影響しないよう消しておく。
execPsql(target, `DELETE FROM factory.holds WHERE target LIKE '${PREFIX}/%'`);

if (failures.length > 0) {
  console.error(`[test-db-holds] ${String(failures.length)} check(s) failed`);
  process.exit(1);
}
console.log("[test-db-holds] all checks passed");
