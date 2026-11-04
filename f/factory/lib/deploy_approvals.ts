// 反映の承認の表(`factory.deploy_approvals`)を読み書きする。
//
// 保護パスに触れた変更の反映を、HEADのshaごとに人の承認まで止めるための表である。
// 表の読み書きは、このファイルの関数を通す。他のファイルは、この表を直接読み書きしない。
// 依頼を作る`requestDeployApproval`は`self_update`だけが、判断を書く`decideDeployApproval`はConsoleの判断のscriptだけが読み込む。
// この決まりを守らせるのは、`tests/scripts/deploy_approvals_wiring.test.ts`の参照の検出だけである。
// 判断の対象は、最後に成功した反映(`factory.deployments`)より後に作られた依頼のうち、最も新しい1件だけである。
// mainが進んで新しい依頼ができた古い依頼と、承認を待たずに反映が進んだ依頼(保護パスの変更が戻された)は、行を残したまま対象から外れる。
// `sql`に既定値を持たせないのは、呼び出し側に接続を選ばせるためである。
//
// 保護の外のモジュールに判定が依存しないよう、このファイルは何もimportしない。

/** 行の値。`lib/db.ts`の`SqlRow`と同じ形で、取り込まずに持つ。 */
export type DeployApprovalSqlRow = Record<string, unknown>;

/**
 * タグ付きテンプレートのSQLの接続。`lib/db.ts`の`SqlClient`と同じ形で、取り込まずに持つ。
 * 互換は`tests/lib/deploy_approvals.test.ts`が型検査で確かめる。
 */
export type DeployApprovalSqlClient = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => {
  fetch(): Promise<DeployApprovalSqlRow[]>;
  execute(): Promise<void>;
};

export const DEPLOY_APPROVAL_DECISIONS = ["approved", "rejected"] as const;
export type DeployApprovalDecision = (typeof DEPLOY_APPROVAL_DECISIONS)[number];

export type DeployApproval = {
  readonly sha: string;
  readonly protected_paths: readonly string[];
  readonly requested_at: string;
  readonly decided_at: string | null;
  readonly decision: DeployApprovalDecision | null;
  readonly decided_by: string | null;
};

/** 保護パスの変更を含む反映が、人の承認を待っていることを示す要対応の通知の種類。 */
export const DEPLOY_APPROVAL_NOTICE_KIND = "deploy_approval_required";

/** 承認か却下を記録したことを残す情報の通知の種類。 */
export const DEPLOY_APPROVAL_DECIDED_NOTICE_KIND = "deploy_approval_decided";

/** 承認を待つ通知の本文の書き出し。版ごとの解決と、古い通知のまとめての解決に使う。 */
export const DEPLOY_APPROVAL_NOTICE_PREFIX = "反映を待つ版: ";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DECIDED_BY_MAX = 100;
const UNDEFINED_TABLE_CODE = "42P01";
const TABLE_MISSING_MESSAGE =
  'relation "factory.deploy_approvals" does not exist';

/** 40桁の小文字の16進か。表のCHECKと同じ条件。 */
export function isDeploySha(value: string): boolean {
  return SHA_PATTERN.test(value);
}

/**
 * 版`sha`の承認を待つ通知の本文の書き出し。
 * 版の後の「。」まで含め、別の版の通知に前方一致で当たらないようにする。
 */
export function deployApprovalNoticePrefix(sha: string): string {
  return `${DEPLOY_APPROVAL_NOTICE_PREFIX}${sha}。`;
}

function assertDeploySha(sha: string): void {
  if (!isDeploySha(sha)) {
    throw new Error(
      `deploy_approvals: ${JSON.stringify(sha)} is not a 40-character lowercase sha`,
    );
  }
}

function isDecision(value: unknown): value is DeployApprovalDecision {
  return DEPLOY_APPROVAL_DECISIONS.some((decision) => decision === value);
}

function parseTimestamp(value: unknown, field: string): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return new Date(Date.parse(value)).toISOString();
  }
  throw new Error(`deploy_approvals: row field "${field}" is not a timestamp`);
}

function parseNullableTimestamp(value: unknown, field: string): string | null {
  return value === null || value === undefined
    ? null
    : parseTimestamp(value, field);
}

function parseNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  throw new Error(`deploy_approvals: row field "${field}" is not a string`);
}

/** `array_to_json`の結果を読む。接続によって、配列か、JSONの文字列で返りうる。 */
function parsePaths(value: unknown): string[] {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) {
    throw new Error(
      'deploy_approvals: row field "protected_paths" is not a list',
    );
  }
  const paths = parsed.filter(
    (item): item is string => typeof item === "string",
  );
  if (paths.length === 0 || paths.length !== parsed.length) {
    throw new Error(
      'deploy_approvals: row field "protected_paths" is not a non-empty list of paths',
    );
  }
  return paths;
}

function parseDecision(value: unknown): DeployApprovalDecision | null {
  if (value === null || value === undefined) return null;
  if (isDecision(value)) return value;
  throw new Error(
    'deploy_approvals: row field "decision" is neither approved nor rejected',
  );
}

function parseRow(row: DeployApprovalSqlRow): DeployApproval {
  const sha = typeof row.sha === "string" ? row.sha.trim() : "";
  if (!isDeploySha(sha)) {
    throw new Error('deploy_approvals: row field "sha" is not a sha');
  }
  return {
    sha,
    protected_paths: parsePaths(row.protected_paths),
    requested_at: parseTimestamp(row.requested_at, "requested_at"),
    decided_at: parseNullableTimestamp(row.decided_at, "decided_at"),
    decision: parseDecision(row.decision),
    decided_by: parseNullableString(row.decided_by, "decided_by"),
  };
}

function isMissingTable(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "code" in err) {
    if (err.code === UNDEFINED_TABLE_CODE) return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(TABLE_MISSING_MESSAGE);
}

/** 文を実行して行を返す。表が無いときは、migrationの未反映と分かる文にして投げる。 */
async function fetchRows(statement: {
  fetch(): Promise<DeployApprovalSqlRow[]>;
}): Promise<DeployApprovalSqlRow[]> {
  try {
    return await statement.fetch();
  } catch (err) {
    if (isMissingTable(err)) {
      throw new Error(
        "deploy_approvals: the table does not exist; the migration is not applied (run mise run migrate)",
        { cause: err },
      );
    }
    throw err;
  }
}

/** 版`sha`の依頼を返す。無ければ`null`。 */
export async function findDeployApproval(
  sha: string,
  sql: DeployApprovalSqlClient,
): Promise<DeployApproval | null> {
  assertDeploySha(sha);
  const rows = await fetchRows(sql`
    SELECT sha, array_to_json(protected_paths) AS protected_paths,
      requested_at, decided_at, decision, decided_by
    FROM factory.deploy_approvals
    WHERE sha = ${sha}
  `);
  const row = rows[0];
  return row === undefined ? null : parseRow(row);
}

/**
 * 版`sha`の依頼を、判断の無い行として作る。作ったら`true`、既にあれば何も変えずに`false`を返す。
 * 保護パスが1件も無い依頼は作らない(例外を投げる)。
 */
export async function requestDeployApproval(
  sha: string,
  paths: readonly string[],
  sql: DeployApprovalSqlClient,
): Promise<boolean> {
  assertDeploySha(sha);
  if (paths.length === 0) {
    throw new Error(
      "deploy_approvals: a request needs at least one protected path",
    );
  }
  const rows = await fetchRows(sql`
    INSERT INTO factory.deploy_approvals (sha, protected_paths)
    VALUES (${sha}, ${[...paths]}::text[])
    ON CONFLICT (sha) DO NOTHING
    RETURNING sha
  `);
  return rows.length > 0;
}

/**
 * 版`sha`の依頼に判断を記録する。記録したら`true`を返す。
 * 記録するのは、判断の無い、最後に成功した反映より後の、最も新しい依頼だけである。
 * それ以外(判断済み、新しい依頼に置き換わった、反映が先に進んだ、行が無い)は何も変えずに`false`を返す。
 * 比較と更新を1つの文で行うので、同時の判断は片方だけが`true`を得る。
 * `decidedBy`は1〜100文字(表のCHECKと同じ)。外れれば例外を投げる。
 */
export async function decideDeployApproval(
  sha: string,
  decision: DeployApprovalDecision,
  decidedBy: string,
  sql: DeployApprovalSqlClient,
): Promise<boolean> {
  assertDeploySha(sha);
  if (!isDecision(decision)) {
    throw new Error(
      "deploy_approvals: the decision must be approved or rejected",
    );
  }
  if (decidedBy.length < 1 || decidedBy.length > DECIDED_BY_MAX) {
    throw new Error("deploy_approvals: decided_by must be 1 to 100 characters");
  }
  const rows = await fetchRows(sql`
    UPDATE factory.deploy_approvals
    SET decision = ${decision}, decided_by = ${decidedBy}, decided_at = now()
    WHERE sha = ${sha}
      AND decision IS NULL
      AND requested_at = (SELECT max(requested_at) FROM factory.deploy_approvals)
      AND requested_at > coalesce(
        (SELECT max(occurred_at) FROM factory.deployments WHERE result = 'success'),
        '-infinity'::timestamptz
      )
    RETURNING sha
  `);
  return rows.length > 0;
}

/** 判断を待つ依頼を返す。最後に成功した反映より後の、最も新しい依頼が判断の無いときだけ、その1件を返す。 */
export async function listPendingDeployApprovals(
  sql: DeployApprovalSqlClient,
): Promise<DeployApproval[]> {
  const rows = await fetchRows(sql`
    SELECT sha, array_to_json(protected_paths) AS protected_paths,
      requested_at, decided_at, decision, decided_by
    FROM factory.deploy_approvals
    WHERE decision IS NULL
      AND requested_at = (SELECT max(requested_at) FROM factory.deploy_approvals)
      AND requested_at > coalesce(
        (SELECT max(occurred_at) FROM factory.deployments WHERE result = 'success'),
        '-infinity'::timestamptz
      )
  `);
  return rows.map(parseRow);
}

/**
 * 承認を待って反映が止まっているかを返す。
 * 最後に成功した反映より後の、最も新しい依頼が、承認されていない(判断が無いか却下)ときに`true`。
 */
export async function isDeployHeldForApproval(
  sql: DeployApprovalSqlClient,
): Promise<boolean> {
  const rows = await fetchRows(sql`
    SELECT EXISTS (
      SELECT 1 FROM factory.deploy_approvals
      WHERE decision IS DISTINCT FROM 'approved'
        AND requested_at = (SELECT max(requested_at) FROM factory.deploy_approvals)
        AND requested_at > coalesce(
          (SELECT max(occurred_at) FROM factory.deployments WHERE result = 'success'),
          '-infinity'::timestamptz
        )
    ) AS held
  `);
  const held = rows[0]?.held;
  if (typeof held !== "boolean") {
    throw new Error('deploy_approvals: "held" is not a boolean');
  }
  return held;
}
