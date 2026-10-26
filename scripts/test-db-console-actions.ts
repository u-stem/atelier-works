// `mise run test:db`の一部。migrationを適用した使い捨てデータベースで、操作の記録の表
// `factory.console_actions`の制約と、`lib/console_actions.ts`が組み立てるSQL文を、本物のPostgreSQLで確かめる。
// 値を埋め込む検査用の`SqlClient`で流すので、`wmill.datatable()`の束縛の経路は通らない。
// 使い捨てのデータベース(`SCRATCH_DB`)だけに書く。
//
// 使い方: COMPOSE_FILE=<compose> SCRATCH_DB=<db> bun run scripts/test-db-console-actions.ts

import {
  consoleActionsCutoff,
  deleteExpiredActions,
  type RawAttempt,
  recordAttempt,
  recordOutcome,
  runRecorded,
} from "../f/factory/lib/console_actions.ts";
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
    console.log(`[test-db-console-actions] ok: ${name}`);
    return;
  }
  failures.push(name);
  console.error(
    `[test-db-console-actions] FAILED: ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`,
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

const COLUMNS = "actor, action, target";

check(
  "table: a row with only the required columns is accepted, with the defaults",
  (() => {
    try {
      execPsql(
        target,
        `INSERT INTO factory.console_actions (${COLUMNS}) VALUES ('qa-op', 'probe_default', 'qa/target')`,
      );
      return true;
    } catch {
      return false;
    }
  })(),
);

const defaults = await sql`
  SELECT outcome, changes::text AS changes, occurred_at IS NOT NULL AS has_time
  FROM factory.console_actions WHERE action = 'probe_default'
`.fetch();
check(
  "table: the defaults are attempted, an empty object and a timestamp",
  defaults.length === 1 &&
    defaults[0]?.outcome === "attempted" &&
    defaults[0]?.changes === "{}" &&
    defaults[0]?.has_time === true,
  defaults,
);

check(
  "table: an unknown outcome is rejected",
  rejects(
    `INSERT INTO factory.console_actions (${COLUMNS}, outcome) VALUES ('qa-op', 'probe_bad', 'qa/target', 'done')`,
    "console_actions_outcome_check",
  ),
);

check(
  "table: an empty actor is rejected",
  rejects(
    `INSERT INTO factory.console_actions (${COLUMNS}) VALUES ('', 'probe_bad', 'qa/target')`,
    "console_actions_actor_check",
  ),
);

check(
  "table: an action with an uppercase letter is rejected",
  rejects(
    `INSERT INTO factory.console_actions (${COLUMNS}) VALUES ('qa-op', 'Probe', 'qa/target')`,
    "console_actions_action_check",
  ),
);

check(
  "table: an empty target is rejected",
  rejects(
    `INSERT INTO factory.console_actions (${COLUMNS}) VALUES ('qa-op', 'probe_bad', '')`,
    "console_actions_target_check",
  ),
);

check(
  "table: changes that are not an object are rejected",
  rejects(
    `INSERT INTO factory.console_actions (${COLUMNS}, changes) VALUES ('qa-op', 'probe_bad', 'qa/target', '[1]'::jsonb)`,
    "console_actions_changes_check",
  ),
);

// ---------------------------------------------------------------------------
// lib/console_actions.ts のSQL文
// ---------------------------------------------------------------------------

const ATTEMPT: RawAttempt = {
  actor: "qa-op",
  action: "probe_lib",
  target: "f/factory/factory_config",
  changes: { max_fix_rounds: 3, enabled: false, since: null },
};

async function rowOf(id: number): Promise<Record<string, unknown> | undefined> {
  const rows = await sql`
    SELECT actor, action, target, changes::text AS changes, outcome
    FROM factory.console_actions WHERE id = ${id}::bigint
  `.fetch();
  return rows[0];
}

const attempt = await recordAttempt(ATTEMPT, sql);
check("recordAttempt: inserts a row and returns its id", attempt.ok, attempt);

const attemptId = attempt.ok ? attempt.value : -1;
const inserted = await rowOf(attemptId);
check(
  "recordAttempt: the row is attempted and carries the changes",
  inserted?.outcome === "attempted" &&
    inserted?.actor === "qa-op" &&
    inserted?.target === "f/factory/factory_config" &&
    JSON.parse(String(inserted?.changes)).max_fix_rounds === 3,
  inserted,
);

const partial = await recordOutcome(
  attemptId,
  "partial",
  { stage_one: "ok" },
  sql,
);
check("recordOutcome: moves attempted to partial", partial.ok, partial);

const finished = await recordOutcome(
  attemptId,
  "succeeded",
  { stage_two: "ok" },
  sql,
);
check("recordOutcome: moves partial to succeeded", finished.ok, finished);

const merged = await rowOf(attemptId);
check(
  "recordOutcome: merges the stage results into the earlier changes",
  merged?.outcome === "succeeded" &&
    JSON.parse(String(merged?.changes)).stage_one === "ok" &&
    JSON.parse(String(merged?.changes)).stage_two === "ok" &&
    JSON.parse(String(merged?.changes)).max_fix_rounds === 3,
  merged,
);

const again = await recordOutcome(attemptId, "failed", {}, sql);
check(
  "recordOutcome: does not move a row that already succeeded",
  !again.ok && again.kind === "write_failed",
  again,
);

const recorded = await runRecorded(
  { ...ATTEMPT, action: "probe_run" },
  async () => ({
    outcome: "succeeded" as const,
    changes: { applied: true },
    value: "done",
  }),
  { sql, onUnrecordable: "refuse" },
);
check(
  "runRecorded: records the attempt and the outcome",
  recorded.ok && recorded.audit === "recorded" && recorded.actionId !== null,
  recorded,
);

let thrown: unknown = null;
try {
  await runRecorded(
    { ...ATTEMPT, action: "probe_throw" },
    async () => {
      throw new Error("boom");
    },
    { sql, onUnrecordable: "refuse" },
  );
} catch (err) {
  thrown = err;
}
const thrownRows = await sql`
  SELECT outcome FROM factory.console_actions WHERE action = 'probe_throw'
`.fetch();
check(
  "runRecorded: moves the row to failed and throws again when the operation throws",
  thrown instanceof Error &&
    thrownRows.length === 1 &&
    thrownRows[0]?.outcome === "failed",
  thrownRows,
);

execPsql(
  target,
  `INSERT INTO factory.console_actions (${COLUMNS}, occurred_at) VALUES ('qa-op', 'probe_old', 'qa/target', now() - interval '100 days')`,
);
const cutoff = consoleActionsCutoff(new Date());
const deleted = await deleteExpiredActions(cutoff, sql);
const oldRows = await sql`
  SELECT count(*)::int AS n FROM factory.console_actions WHERE action = 'probe_old'
`.fetch();
const freshRows = await sql`
  SELECT count(*)::int AS n FROM factory.console_actions WHERE action = 'probe_lib'
`.fetch();
check(
  "deleteExpiredActions: deletes the rows older than 90 days and keeps the recent ones",
  deleted >= 1 && oldRows[0]?.n === 0 && freshRows[0]?.n === 1,
  { deleted, oldRows, freshRows },
);

execPsql(target, "DELETE FROM factory.console_actions WHERE actor = 'qa-op'");

if (failures.length > 0) {
  console.error(
    `[test-db-console-actions] ${String(failures.length)} check(s) failed`,
  );
  process.exit(1);
}
console.log("[test-db-console-actions] all checks passed");
