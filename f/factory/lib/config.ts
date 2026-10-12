// リソース`f/factory/factory_config`(リソース型`c_factory_config`)を読み込んで検証する。
// リソース型のスキーマで`default:`を持つ項目は、値が無ければ既定値で埋める。
// 項目を後から足しても、
// それより前に作った既存のリモートのリソースが検証を通るようにするため。

import { JOB_TMP_MAX_AGE_SEC } from "./job_tmp.ts";
import {
  type FactoryConfig,
  type FactoryOwner,
  type FactoryOwnerKind,
  isBoolean,
  isNumber,
  isOneOf,
  isRecord,
  isString,
  isStringArray,
  type LabelerAssociation,
  type ReviewPostMode,
} from "./types.ts";

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(`factory_config validation error: ${message}`);
    this.name = "ConfigValidationError";
  }
}

const LABELER_ASSOCIATIONS: readonly LabelerAssociation[] = [
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
];
const REVIEW_POST_MODES: readonly ReviewPostMode[] = ["comment_only", "gated"];
const OWNER_KINDS = ["user", "org"];
/**
 * `model`と`heavy_model`に許す形。`claude --model`の引数に渡すので、
 * 先頭が`-`の値(オプションとして読まれる)や空白、シェルの特殊文字を通さない。
 * `claude-opus-5-5`や`claude-opus-5-5[1m]`のような名前は通る。
 */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._[\]-]*$/;
/**
 * `check_commands_by_repo`のキーを正規化した結果が従う形。
 * スキームとホストを含まず、スラッシュが1つだけの`owner/repo`。
 */
const OWNER_SLASH_REPO = /^[^/\s]+\/[^/\s]+$/;

/**
 * `c_factory_config.resource-type.yaml`で`default:`を持つ`FactoryConfig`の項目。
 * `owners`、`factory_repo`、`instance_name`はインスタンスごとに違うため既定値を持たず、
 * 必須とする。
 */
type DefaultableField =
  | "trigger_label"
  | "allowed_labeler_associations"
  | "allowed_labeler_logins"
  | "model"
  | "heavy_model"
  | "max_attempts"
  | "max_turns"
  | "max_budget_usd_per_run"
  | "daily_budget_usd"
  | "claude_timeout_sec"
  | "worktree_ttl_days"
  | "retention_work_items_days"
  | "retention_logs_days"
  | "factory_branch"
  | "windmill_public_url"
  | "review_label"
  | "fix_label"
  | "tracked_pr_days"
  | "review_post_mode"
  | "max_fix_rounds"
  | "allowed_check_commands"
  | "default_reviewers"
  | "repo_allowlist"
  | "diff_max_lines"
  | "max_fix_changed_files"
  | "max_fix_diff_lines"
  | "max_lookback_days"
  | "implement_enabled"
  | "implement_max_rounds"
  | "implement_max_turns"
  | "implement_max_budget_usd_per_run"
  | "implement_timeout_sec"
  | "implement_check_timeout_sec"
  | "implement_flow_timeout_sec"
  | "implement_max_changed_files"
  | "implement_max_diff_lines"
  | "dependabot_enabled"
  | "dependabot_min_published_days"
  | "pr_ci_watch_enabled"
  | "check_commands_by_repo";

/**
 * `DefaultableField`の各項目の既定値。
 * 型アサーションなしで各値を検査できるよう、`FactoryConfig`そのものに対して型を付ける。
 */
const DEFAULTS: Pick<FactoryConfig, DefaultableField> = {
  trigger_label: "factory",
  allowed_labeler_associations: ["OWNER", "MEMBER", "COLLABORATOR"],
  allowed_labeler_logins: [],
  model: "claude-sonnet-5-5",
  heavy_model: "claude-opus-5-5",
  max_attempts: 3,
  max_turns: 40,
  max_budget_usd_per_run: 5,
  daily_budget_usd: 50,
  claude_timeout_sec: 1800,
  worktree_ttl_days: 7,
  // `cleanup_db.ts`の保持期間。前者は終了した作業項目(とそこから連鎖して消える行)、
  // 後者は独立したログ(`job_failures`、`deployments`、解決済みの`notices`)に使う。
  retention_work_items_days: 90,
  retention_logs_days: 30,
  factory_branch: "main",
  windmill_public_url: "http://127.0.0.1:8080",
  review_label: "factory:review",
  fix_label: "factory:fix",
  // PRのトリガーラベルは着手時に外し、作業中や状態を表すラベルも付けない。
  // そのためDBからPRを再発見する`listTrackedPrs`に、追跡を続ける日数が別に要る。
  tracked_pr_days: 30,
  review_post_mode: "comment_only",
  max_fix_rounds: 3,
  allowed_check_commands: [],
  default_reviewers: [],
  repo_allowlist: [],
  diff_max_lines: 3000,
  // `pr_fix_verify`が許す差分の大きさの上限。
  max_fix_changed_files: 30,
  max_fix_diff_lines: 1500,
  // 監査期間をさかのぼれる日数の上限。初回の監査と、前回のレポートの終端が
  // これより古いときに使う。
  max_lookback_days: 28,
  // implementフローの設定。`implement_enabled`は既定で無効にし、
  // リモートのリソースで有効にする。
  implement_enabled: false,
  implement_max_rounds: 5,
  implement_max_turns: 80,
  implement_max_budget_usd_per_run: 10,
  implement_timeout_sec: 3600,
  implement_check_timeout_sec: 900,
  implement_flow_timeout_sec: 14400,
  implement_max_changed_files: 60,
  implement_max_diff_lines: 3000,
  // dependabotの自動処理は既定で無効にし、リモートのリソースで有効にする。
  dependabot_enabled: false,
  dependabot_min_published_days: 7,
  // PRのCI監視は観測と通知だけで、PRにもリポジトリにも書き込まないので、既定で有効にする。
  pr_ci_watch_enabled: true,
  check_commands_by_repo: {},
};

/** `owners`の1要素の`kind`に使える値か。 */
function isOwnerKind(value: unknown): value is FactoryOwnerKind {
  return isString(value) && OWNER_KINDS.includes(value);
}

/**
 * `owners`の1要素をパースする。形が違えば`null`を返す。
 * `id`は、`null`、`undefined`、省略をどれも「id無し」として扱い、
 * 結果には`id`のキーを持たせない。値があるときは、正の整数だけを許す。
 */
function parseFactoryOwner(value: unknown): FactoryOwner | null {
  if (!isRecord(value)) {
    return null;
  }
  const { name, kind, id } = value;
  if (!isString(name) || !isOwnerKind(kind)) {
    return null;
  }
  if (id === undefined || id === null) {
    return { name, kind };
  }
  if (!isNumber(id) || !Number.isInteger(id) || id <= 0) {
    return null;
  }
  return { name, kind, id };
}

/**
 * `owners`をパースする。
 * 要素に1つでも形の違うものがあるか、名前が重複していれば`null`を返す。
 * 名前の比較は大文字と小文字を区別しない(GitHubのログイン名と同じ)。
 * `id`付きと`id`無しの同名が並ぶと、`id`の照合をすり抜けるため、重複を許さない。
 */
function parseFactoryOwners(value: unknown): FactoryOwner[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const owners: FactoryOwner[] = [];
  const names = new Set<string>();
  for (const item of value) {
    const owner = parseFactoryOwner(item);
    if (owner === null) {
      return null;
    }
    const key = owner.name.toLowerCase();
    if (names.has(key)) {
      return null;
    }
    names.add(key);
    owners.push(owner);
  }
  return owners;
}

function isLabelerAssociationArray(
  value: unknown,
): value is LabelerAssociation[] {
  return (
    Array.isArray(value) &&
    value.every((item) => isOneOf(item, LABELER_ASSOCIATIONS))
  );
}

function isReviewPostMode(value: unknown): value is ReviewPostMode {
  return isOneOf(value, REVIEW_POST_MODES);
}

/**
 * `stringField`の値が、`MODEL_NAME`の許可リストに合うことまで検証して返す。
 * 合わなければ例外を投げる。
 */
function modelField(
  raw: Record<string, unknown>,
  field: "model" | "heavy_model",
  fallback: string,
): string {
  const value = stringField(raw, field, fallback);
  if (!MODEL_NAME.test(value)) {
    throw new ConfigValidationError(
      `"${field}" must match ${String(MODEL_NAME)}`,
    );
  }
  return value;
}

/**
 * `raw[field]`を返す。値が無ければ`fallback`を返し、文字列でなければ例外を投げる。
 */
function stringField(
  raw: Record<string, unknown>,
  field: string,
  fallback: string,
): string {
  const value = raw[field];
  if (value === undefined) {
    return fallback;
  }
  if (!isString(value)) {
    throw new ConfigValidationError(`"${field}" must be a string`);
  }
  return value;
}

function numberField(
  raw: Record<string, unknown>,
  field: string,
  fallback: number,
): number {
  const value = raw[field];
  if (value === undefined) {
    return fallback;
  }
  if (!isNumber(value)) {
    throw new ConfigValidationError(`"${field}" must be a number`);
  }
  return value;
}

/**
 * ジョブごとの一時ディレクトリの掃除は、この期限を過ぎたものを消す。
 * ジョブの実行時間を決める設定がこれを超えるのは想定外なので、超える値は拒否する。
 * 動いているジョブのディレクトリを守る一次の仕組みではなく、安全側の追加の歯止めである。
 */
function withinJobTmpAge(field: string, value: number): number {
  if (value > JOB_TMP_MAX_AGE_SEC) {
    throw new ConfigValidationError(
      `"${field}" must not exceed ${String(JOB_TMP_MAX_AGE_SEC)} seconds`,
    );
  }
  return value;
}

/**
 * `raw[field]`を返す。値が無ければ`fallback`を返し、正の整数でなければ例外を投げる。
 */
function positiveIntegerField(
  raw: Record<string, unknown>,
  field: string,
  fallback: number,
): number {
  const value = raw[field];
  if (value === undefined) {
    return fallback;
  }
  if (!isNumber(value) || !Number.isInteger(value) || value <= 0) {
    throw new ConfigValidationError(`"${field}" must be a positive integer`);
  }
  return value;
}

function stringArrayField(
  raw: Record<string, unknown>,
  field: string,
  fallback: string[],
): string[] {
  const value = raw[field];
  if (value === undefined) {
    return fallback;
  }
  if (!isStringArray(value)) {
    throw new ConfigValidationError(`"${field}" must be an array of strings`);
  }
  return value;
}

/**
 * `allowed_labeler_logins`を返す。値が無ければ既定値を返す。
 * `[bot]`で終わるログイン名はGitHub Appのアカウントで、第三者の入力に応じて
 * ラベルを付ける自動化になりうる。そのアカウントが付けたラベルを許可すると、
 * 付与者の確認が素通りになるため、例外を投げる。
 */
function labelerLoginsField(raw: Record<string, unknown>): string[] {
  const logins = stringArrayField(
    raw,
    "allowed_labeler_logins",
    DEFAULTS.allowed_labeler_logins,
  );
  for (const login of logins) {
    if (login.toLowerCase().endsWith("[bot]")) {
      throw new ConfigValidationError(
        `"allowed_labeler_logins" must not contain an automation account: ${JSON.stringify(login)}`,
      );
    }
  }
  return logins;
}

/**
 * `raw[field]`を返す。値が無ければ`fallback`を返し、真偽値でなければ例外を投げる。
 */
function booleanField(
  raw: Record<string, unknown>,
  field: string,
  fallback: boolean,
): boolean {
  const value = raw[field];
  if (value === undefined) {
    return fallback;
  }
  if (!isBoolean(value)) {
    throw new ConfigValidationError(`"${field}" must be a boolean`);
  }
  return value;
}

/**
 * `raw.check_commands_by_repo`を`{ [owner/repo]: string[] }`として返す。
 * 値が無ければ`fallback`を返す。
 * オブジェクトでないとき、値に文字列の配列でないものがあるとき、
 * キーを`normalizeRepoUrl`で正規化しても`owner/repo`の形にならないときは例外を投げる。
 * キーの形を厳しく検査するのは、
 * `checkCommandsFor`がキーを`owner/repo`とだけ比べるためである。
 * URLの形のキーを通すと、どのリポジトリにも一致せず、設定の誤りに気づかないまま
 * `allowed_check_commands`が使われる。
 * 型アサーションなしで型を付けるため、エントリーを1つずつ詰め直す。
 */
function checkCommandsByRepoField(
  raw: Record<string, unknown>,
  fallback: Record<string, string[]>,
): Record<string, string[]> {
  const field = "check_commands_by_repo";
  const value = raw[field];
  if (value === undefined) {
    return fallback;
  }
  if (!isRecord(value)) {
    throw new ConfigValidationError(
      `"${field}" must be an object of string arrays`,
    );
  }
  const result: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isStringArray(entry)) {
      throw new ConfigValidationError(
        `"${field}"["${key}"] must be an array of strings`,
      );
    }
    if (!OWNER_SLASH_REPO.test(normalizeRepoUrl(key))) {
      throw new ConfigValidationError(
        `"${field}" key "${key}" must be "<owner>/<repo>"`,
      );
    }
    result[key] = entry;
  }
  return result;
}

/**
 * 既定値を持たない項目`raw[field]`を返す。
 * 値が無いとき、空の文字列のとき、文字列でないときは例外を投げる。
 */
function requiredStringField(
  raw: Record<string, unknown>,
  field: string,
): string {
  const value = raw[field];
  if (!isString(value) || value.length === 0) {
    throw new ConfigValidationError(
      `"${field}" is required and must be a non-empty string`,
    );
  }
  return value;
}

/**
 * `factory_config`リソースの生の値を検証し、
 * 既定値を持つ項目を埋めた`FactoryConfig`を返す。
 * 値があっても型が合わない項目は、既定値の有無によらず`ConfigValidationError`を投げる。
 */
export function parseFactoryConfig(raw: unknown): FactoryConfig {
  if (!isRecord(raw)) {
    throw new ConfigValidationError("resource value must be an object");
  }

  const owners = parseFactoryOwners(raw.owners);
  if (owners === null) {
    throw new ConfigValidationError(
      '"owners" is required and must be an array of { name: string, kind: "user" | "org", id?: positive integer } with unique names (case-insensitive)',
    );
  }

  const allowedLabelerAssociations = raw.allowed_labeler_associations;
  const resolvedAllowedLabelerAssociations =
    allowedLabelerAssociations === undefined
      ? DEFAULTS.allowed_labeler_associations
      : isLabelerAssociationArray(allowedLabelerAssociations)
        ? allowedLabelerAssociations
        : (() => {
            throw new ConfigValidationError(
              '"allowed_labeler_associations" must be an array of "OWNER" | "MEMBER" | "COLLABORATOR"',
            );
          })();

  const reviewPostMode = raw.review_post_mode;
  const resolvedReviewPostMode =
    reviewPostMode === undefined
      ? DEFAULTS.review_post_mode
      : isReviewPostMode(reviewPostMode)
        ? reviewPostMode
        : (() => {
            throw new ConfigValidationError(
              '"review_post_mode" must be "comment_only" | "gated"',
            );
          })();

  return {
    owners,
    trigger_label: stringField(raw, "trigger_label", DEFAULTS.trigger_label),
    allowed_labeler_associations: resolvedAllowedLabelerAssociations,
    allowed_labeler_logins: labelerLoginsField(raw),
    model: modelField(raw, "model", DEFAULTS.model),
    heavy_model: modelField(raw, "heavy_model", DEFAULTS.heavy_model),
    max_attempts: numberField(raw, "max_attempts", DEFAULTS.max_attempts),
    max_turns: numberField(raw, "max_turns", DEFAULTS.max_turns),
    max_budget_usd_per_run: numberField(
      raw,
      "max_budget_usd_per_run",
      DEFAULTS.max_budget_usd_per_run,
    ),
    daily_budget_usd: numberField(
      raw,
      "daily_budget_usd",
      DEFAULTS.daily_budget_usd,
    ),
    claude_timeout_sec: withinJobTmpAge(
      "claude_timeout_sec",
      numberField(raw, "claude_timeout_sec", DEFAULTS.claude_timeout_sec),
    ),
    worktree_ttl_days: numberField(
      raw,
      "worktree_ttl_days",
      DEFAULTS.worktree_ttl_days,
    ),
    retention_work_items_days: positiveIntegerField(
      raw,
      "retention_work_items_days",
      DEFAULTS.retention_work_items_days,
    ),
    retention_logs_days: positiveIntegerField(
      raw,
      "retention_logs_days",
      DEFAULTS.retention_logs_days,
    ),
    factory_repo: requiredStringField(raw, "factory_repo"),
    factory_branch: stringField(raw, "factory_branch", DEFAULTS.factory_branch),
    instance_name: requiredStringField(raw, "instance_name"),
    windmill_public_url: stringField(
      raw,
      "windmill_public_url",
      DEFAULTS.windmill_public_url,
    ),
    review_label: stringField(raw, "review_label", DEFAULTS.review_label),
    fix_label: stringField(raw, "fix_label", DEFAULTS.fix_label),
    tracked_pr_days: positiveIntegerField(
      raw,
      "tracked_pr_days",
      DEFAULTS.tracked_pr_days,
    ),
    review_post_mode: resolvedReviewPostMode,
    max_fix_rounds: numberField(raw, "max_fix_rounds", DEFAULTS.max_fix_rounds),
    allowed_check_commands: stringArrayField(
      raw,
      "allowed_check_commands",
      DEFAULTS.allowed_check_commands,
    ),
    default_reviewers: stringArrayField(
      raw,
      "default_reviewers",
      DEFAULTS.default_reviewers,
    ),
    repo_allowlist: stringArrayField(
      raw,
      "repo_allowlist",
      DEFAULTS.repo_allowlist,
    ),
    diff_max_lines: numberField(raw, "diff_max_lines", DEFAULTS.diff_max_lines),
    max_fix_changed_files: positiveIntegerField(
      raw,
      "max_fix_changed_files",
      DEFAULTS.max_fix_changed_files,
    ),
    max_fix_diff_lines: positiveIntegerField(
      raw,
      "max_fix_diff_lines",
      DEFAULTS.max_fix_diff_lines,
    ),
    max_lookback_days: positiveIntegerField(
      raw,
      "max_lookback_days",
      DEFAULTS.max_lookback_days,
    ),
    implement_enabled: booleanField(
      raw,
      "implement_enabled",
      DEFAULTS.implement_enabled,
    ),
    implement_max_rounds: positiveIntegerField(
      raw,
      "implement_max_rounds",
      DEFAULTS.implement_max_rounds,
    ),
    implement_max_turns: positiveIntegerField(
      raw,
      "implement_max_turns",
      DEFAULTS.implement_max_turns,
    ),
    implement_max_budget_usd_per_run: numberField(
      raw,
      "implement_max_budget_usd_per_run",
      DEFAULTS.implement_max_budget_usd_per_run,
    ),
    implement_timeout_sec: withinJobTmpAge(
      "implement_timeout_sec",
      positiveIntegerField(
        raw,
        "implement_timeout_sec",
        DEFAULTS.implement_timeout_sec,
      ),
    ),
    implement_check_timeout_sec: positiveIntegerField(
      raw,
      "implement_check_timeout_sec",
      DEFAULTS.implement_check_timeout_sec,
    ),
    implement_flow_timeout_sec: positiveIntegerField(
      raw,
      "implement_flow_timeout_sec",
      DEFAULTS.implement_flow_timeout_sec,
    ),
    implement_max_changed_files: positiveIntegerField(
      raw,
      "implement_max_changed_files",
      DEFAULTS.implement_max_changed_files,
    ),
    implement_max_diff_lines: positiveIntegerField(
      raw,
      "implement_max_diff_lines",
      DEFAULTS.implement_max_diff_lines,
    ),
    dependabot_enabled: booleanField(
      raw,
      "dependabot_enabled",
      DEFAULTS.dependabot_enabled,
    ),
    dependabot_min_published_days: positiveIntegerField(
      raw,
      "dependabot_min_published_days",
      DEFAULTS.dependabot_min_published_days,
    ),
    pr_ci_watch_enabled: booleanField(
      raw,
      "pr_ci_watch_enabled",
      DEFAULTS.pr_ci_watch_enabled,
    ),
    check_commands_by_repo: checkCommandsByRepoField(
      raw,
      DEFAULTS.check_commands_by_repo,
    ),
  };
}

/**
 * `factory_config`リソースを取得して検証する。
 * @param getResource リソースを取得する関数。
 *   テストで`wmill.getResource`を呼ばないよう注入する。Windmillのスクリプトからは
 *   `() => wmill.getResource("f/factory/factory_config")`を渡す。
 */
export async function loadConfig(
  getResource: () => Promise<unknown>,
): Promise<FactoryConfig> {
  const raw = await getResource();
  return parseFactoryConfig(raw);
}

/**
 * GitHubのHTTPSのclone URLを、比較用に正規化して返す。
 * 前後の空白、末尾の`.git`、末尾のスラッシュを除き、小文字にする。
 * GitHubのownerとrepoは大文字と小文字を区別しないため。
 */
export function normalizeRepoUrl(url: string): string {
  return url
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * このFactoryのインスタンスが`owner`/`repo`を対象にしてよいかを返す。
 *
 * `config.factory_repo`は`owners`と`repo_allowlist`によらず常に許す。
 * Factory自身をデプロイし、監査から起票するリポジトリであり、
 * 監査からIssue、要件定義へとつながる自己改善の流れを、
 * `owners`や`repo_allowlist`への記載に左右させないため
 * (記載が漏れると、起票したIssueに`factory`ラベルが付かなくなる)。
 *
 * それ以外は、`owner`が`config.owners`のいずれかに一致する必要がある
 * (GitHubのログイン名と同じく大文字と小文字を区別しない)。
 * `config.repo_allowlist`が空でなければ、さらにリポジトリのHTTPSのclone URL
 * (末尾の`.git`の有無は問わない)がそこに含まれる必要がある。
 * 空のときは`owners`のリポジトリをすべて許す。
 */
export function isRepoAllowed(
  config: Pick<FactoryConfig, "owners" | "repo_allowlist" | "factory_repo">,
  owner: string,
  repo: string,
): boolean {
  const target = normalizeRepoUrl(`https://github.com/${owner}/${repo}`);
  if (normalizeRepoUrl(config.factory_repo) === target) {
    return true;
  }
  const ownerAllowed = config.owners.some(
    (candidate) => candidate.name.toLowerCase() === owner.toLowerCase(),
  );
  if (!ownerAllowed) {
    return false;
  }
  if (config.repo_allowlist.length === 0) {
    return true;
  }
  return config.repo_allowlist.some(
    (entry) => normalizeRepoUrl(entry) === target,
  );
}

/**
 * implementフローが`owner`/`repo`に対して実行する検査コマンドを返す。
 * そのリポジトリを明示した`check_commands_by_repo`のエントリーだけを使い
 * (キーの照合は`checkCommandsFor`と同じ)、無ければ`[]`を返す。
 * `allowed_check_commands`は決して使わない。
 * 検査コマンドはClaudeが書いたコード(テストやソース)を、workerのコンテナの中で非特権のuidとして、コンテナの分離なしに実行するため、
 * リポジトリごとに名前を挙げて有効にさせる(docs/security.md)。
 */
export function implementCheckCommandsFor(
  config: Pick<FactoryConfig, "check_commands_by_repo">,
  owner: string,
  repo: string,
): string[] {
  const target = normalizeRepoUrl(`${owner}/${repo}`);
  for (const [key, commands] of Object.entries(config.check_commands_by_repo)) {
    if (normalizeRepoUrl(key) === target) {
      return commands;
    }
  }
  return [];
}

/**
 * `owner`/`repo`に対して実行する検査コマンドを返す。
 * `check_commands_by_repo`のうち、キーを`normalizeRepoUrl`で正規化すると
 * `owner/repo`に一致するエントリーを使い、無ければ`allowed_check_commands`を返す。
 * 明示した`[]`のエントリーは「このリポジトリでは検査しない」として扱い、
 * `allowed_check_commands`には進まない。
 * リポジトリごとに全体の検査コマンドを外せるようにするため。
 *
 * キーは`owner/repo`の形だけを受け付け、`isRepoAllowed`と違って
 * URL(`https://github.com/owner/repo`)は受け付けない。
 * URLの形のキーは`checkCommandsByRepoField`が読み込み時に拒否する。
 */
export function checkCommandsFor(
  config: Pick<
    FactoryConfig,
    "allowed_check_commands" | "check_commands_by_repo"
  >,
  owner: string,
  repo: string,
): string[] {
  const target = normalizeRepoUrl(`${owner}/${repo}`);
  for (const [key, commands] of Object.entries(config.check_commands_by_repo)) {
    if (normalizeRepoUrl(key) === target) {
      return commands;
    }
  }
  return config.allowed_check_commands;
}
