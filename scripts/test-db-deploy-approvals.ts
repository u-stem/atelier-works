// `mise run test:db`の一部。migrationを適用した使い捨てデータベースで、反映の承認の表の制約と、
// `lib/deploy_approvals.ts`が組み立てるSQL文を、本物のPostgreSQLで確かめる。
// 値を埋め込む検査用の`SqlClient`で流すので、`wmill.datatable()`の束縛の経路は通らない。
// 使い捨てのデータベース(`SCRATCH_DB`)だけに書く。
//
// 使い方: COMPOSE_FILE=<compose> SCRATCH_DB=<db> bun run scripts/test-db-deploy-approvals.ts

import {
  decideDeployApproval,
  findDeployApproval,
  isDeployHeldForApproval,
  listPendingDeployApprovals,
  requestDeployApproval,
} from "../f/factory/lib/deploy_approvals.ts";
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
    console.log(`[test-db-deploy-approvals] ok: ${name}`);
    return;
  }
  failures.push(name);
  console.error(
    `[test-db-deploy-approvals] FAILED: ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`,
  );
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

const PATHS = ["f/factory/self_update.ts", "infra/worker/Dockerfile"];
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_E = "e".repeat(40);

// ---------------------------------------------------------------------------
// 制約
// ---------------------------------------------------------------------------

check(
  "the sha check rejects a short sha",
  rejects(
    "INSERT INTO factory.deploy_approvals (sha, protected_paths) VALUES ('abc', ARRAY['x'])",
    "deploy_approvals_sha_check",
  ),
);
check(
  "the sha check rejects an uppercase sha",
  rejects(
    `INSERT INTO factory.deploy_approvals (sha, protected_paths) VALUES ('${"A".repeat(40)}', ARRAY['x'])`,
    "deploy_approvals_sha_check",
  ),
);
check(
  "the paths check rejects an empty list",
  rejects(
    `INSERT INTO factory.deploy_approvals (sha, protected_paths) VALUES ('${"d".repeat(40)}', ARRAY[]::text[])`,
    "deploy_approvals_paths_check",
  ),
);
check(
  "the decision check rejects an unknown decision",
  rejects(
    `INSERT INTO factory.deploy_approvals (sha, protected_paths, decision, decided_at, decided_by) VALUES ('${"d".repeat(40)}', ARRAY['x'], 'maybe', now(), 'human')`,
    "deploy_approvals_decision_check",
  ),
);
check(
  "the decided check rejects a decision without a decider",
  rejects(
    `INSERT INTO factory.deploy_approvals (sha, protected_paths, decision, decided_at) VALUES ('${"d".repeat(40)}', ARRAY['x'], 'approved', now())`,
    "deploy_approvals_decided_check",
  ),
);

// ---------------------------------------------------------------------------
// 依頼、判断、承認待ちの読み取り
// ---------------------------------------------------------------------------

check(
  "requestDeployApproval creates a row",
  await requestDeployApproval(SHA_A, PATHS, sql),
);
check(
  "requestDeployApproval does not create the same row twice",
  !(await requestDeployApproval(SHA_A, PATHS, sql)),
);
const found = await findDeployApproval(SHA_A, sql);
check(
  "findDeployApproval reads the paths back",
  JSON.stringify(found?.protected_paths) === JSON.stringify(PATHS),
  found,
);
check(
  "findDeployApproval reads an undecided row",
  found?.decision === null,
  found,
);
check(
  "isDeployHeldForApproval holds while the newest request is undecided",
  await isDeployHeldForApproval(sql),
);
check(
  "listPendingDeployApprovals lists the newest undecided request",
  (await listPendingDeployApprovals(sql)).map((row) => row.sha).join() ===
    SHA_A,
);
check(
  "requestDeployApproval creates a request for a newer HEAD",
  await requestDeployApproval(SHA_B, PATHS, sql),
);
check(
  "listPendingDeployApprovals lists only the newest request",
  (await listPendingDeployApprovals(sql)).map((row) => row.sha).join() ===
    SHA_B,
);
check(
  "decideDeployApproval refuses a request that a newer one replaced",
  !(await decideDeployApproval(SHA_A, "approved", "human", sql)),
);
check(
  "decideDeployApproval approves the newest request",
  await decideDeployApproval(SHA_B, "approved", "human", sql),
);
check(
  "decideDeployApproval does not decide twice",
  !(await decideDeployApproval(SHA_B, "rejected", "human", sql)),
);
check(
  "isDeployHeldForApproval releases after the approval",
  !(await isDeployHeldForApproval(sql)),
);
check(
  "listPendingDeployApprovals is empty after the approval",
  (await listPendingDeployApprovals(sql)).length === 0,
);

// 承認を待たずに反映が進んだ依頼(保護パスの変更が戻された)は、対象から外れる。
check(
  "requestDeployApproval creates a request that a deployment passes",
  await requestDeployApproval(SHA_E, PATHS, sql),
);
execPsql(
  target,
  `INSERT INTO factory.deployments (sha_to, result, occurred_at) VALUES ('${SHA_E}', 'success', now() + interval '1 minute')`,
);
check(
  "isDeployHeldForApproval releases after a later successful deployment",
  !(await isDeployHeldForApproval(sql)),
);
check(
  "listPendingDeployApprovals leaves out a request that a later deployment passed",
  (await listPendingDeployApprovals(sql)).length === 0,
);
check(
  "decideDeployApproval refuses a request that a later deployment passed",
  !(await decideDeployApproval(SHA_E, "approved", "human", sql)),
);

// 後の検査に行を残さない。
execPsql(target, `DELETE FROM factory.deployments WHERE sha_to = '${SHA_E}'`);
execPsql(target, "DELETE FROM factory.deploy_approvals");

if (failures.length > 0) {
  console.error(
    `[test-db-deploy-approvals] ${String(failures.length)} check(s) failed`,
  );
  process.exit(1);
}
