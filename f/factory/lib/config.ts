// リソース`f/factory/factory_config`(リソース型`c_factory_config`)を読み込んで検証する。
// リソース型のスキーマで`default:`を持つ項目は、値が無ければ既定値で埋める。
// 項目を後から足しても、
// それより前に作った既存のリモートのリソースが検証を通るようにするため。

import {
  type FactoryConfig,
  type FactoryOwner,
  type FactoryOwnerKind,
  type GhSource,
  isBoolean,
  isNumber,
  isOneOf,
  isRecord,
  isString,
  isStringArray,
  JOB_TMP_MAX_AGE_SEC,
  type LabelerAssociation,
  parseGitHubRepoUrl,
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
const GH_SOURCES: readonly GhSource[] = ["search", "db"];
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
  | "allowed_labeler_ids"
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
  | "dependabot_merge_enabled"
  | "dependabot_group_enabled"
  | "dependabot_other_repos"
  | "dependabot_min_published_days"
  | "pr_ci_watch_enabled"
  | "pr_ci_watch_human_prs"
  | "pr_ci_fix_enabled"
  | "pr_ci_fix_max_rounds"
  | "pr_ci_fix_enabled_since"
  | "pr_conflict_watch_enabled"
  | "pr_conflict_fix_enabled"
  | "pr_conflict_fix_max_rounds"
  | "pr_conflict_fix_max_rounds_per_pr"
  | "pr_conflict_fix_enabled_since"
  | "pr_conflict_fix_notify_grace_min"
  | "gh_collect_enabled"
  | "gh_collect_detail_enabled"
  | "gh_source_dependabot"
  | "gh_source_pr_conflict_watch"
  | "gh_source_poll_issues"
  | "gh_source_poll_prs"
  | "gh_source_pr_ci_watch"
  | "worker_alert_memory_ratio"
  | "check_commands_by_repo";

/**
 * `DefaultableField`の各項目の既定値。
 * 型アサーションなしで各値を検査できるよう、`FactoryConfig`そのものに対して型を付ける。
 */
const DEFAULTS: Pick<FactoryConfig, DefaultableField> = {
  trigger_label: "factory",
  allowed_labeler_associations: ["OWNER", "MEMBER", "COLLABORATOR"],
  allowed_labeler_logins: [],
  allowed_labeler_ids: {},
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
  // マージは、結果を人が確かめてから別に有効にする。無効の間は、マージ可の判定も人に回す。
  dependabot_merge_enabled: false,
  // 複数パッケージの同時更新は、試運転でマージ可の判定まで進むことを確かめてから、リモートのリソースで有効にする。
  dependabot_group_enabled: false,
  // Factory自身以外のリポジトリは、設定で名前を挙げたものだけを自動処理の候補にする。既定は空で、挙げない。
  dependabot_other_repos: [],
  dependabot_min_published_days: 7,
  // PRのCI監視は観測と通知だけで、PRにもリポジトリにも書き込まないので、既定で有効にする。
  pr_ci_watch_enabled: true,
  // 人のPRの失敗の通知は、通知先と対象のアカウントを確かめてから、リモートのリソースで有効にする。
  pr_ci_watch_human_prs: false,
  // CIの失敗を直す作業項目はPRにpushするので、既定で無効にし、リモートのリソースで有効にする。
  pr_ci_fix_enabled: false,
  pr_ci_fix_max_rounds: 2,
  pr_ci_fix_enabled_since: null,
  // 競合の検知はPRにもリポジトリにも書き込まないが、通知の出方を確かめてから、リモートのリソースで有効にする。
  pr_conflict_watch_enabled: false,
  // 競合を直す作業項目はPRにpushするので、既定で無効にし、リモートのリソースで有効にする。
  pr_conflict_fix_enabled: false,
  pr_conflict_fix_max_rounds: 2,
  pr_conflict_fix_max_rounds_per_pr: 5,
  pr_conflict_fix_enabled_since: null,
  pr_conflict_fix_notify_grace_min: 60,
  // 収集は読み取り専用のトークンを入れてから、リモートのリソースで有効にする。
  gh_collect_enabled: false,
  // 詳細の収集は、収集が動くことを確かめてから、リモートのリソースで有効にする。
  gh_collect_detail_enabled: false,
  // 収集の表から候補を読むのは、実機で表と検索の突き合わせを確かめてから、リモートのリソースで切り替える。
  gh_source_dependabot: "search",
  gh_source_pr_conflict_watch: "search",
  gh_source_poll_issues: "search",
  gh_source_poll_prs: "search",
  gh_source_pr_ci_watch: "search",
  // メモリは上限の8割を既定にする。根拠と見直し方は`docs/operations.md`の「閾値の通知」にある。
  worker_alert_memory_ratio: 0.8,
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

function isGhSource(value: unknown): value is GhSource {
  return isOneOf(value, GH_SOURCES);
}

/** `raw[field]`が列挙の値ならそれを返す。値が無ければ`fallback`を返し、列挙の外なら例外を投げる。 */
function ghSourceField(
  raw: Record<string, unknown>,
  field:
    | "gh_source_dependabot"
    | "gh_source_pr_conflict_watch"
    | "gh_source_poll_issues"
    | "gh_source_poll_prs"
    | "gh_source_pr_ci_watch",
  fallback: GhSource,
): GhSource {
  const value = raw[field];
  if (value === undefined) {
    return fallback;
  }
  if (!isGhSource(value)) {
    throw new ConfigValidationError(`"${field}" must be "search" | "db"`);
  }
  return value;
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
 * `raw[field]`を返す。値が無ければ`fallback`を返し、0を超え1以下の数でなければ例外を投げる。
 * 割合の閾値に使う。0は常に通知し、1を超えると通知しなくなるので、どちらも拒否する。
 */
function ratioField(
  raw: Record<string, unknown>,
  field: string,
  fallback: number,
): number {
  const value = numberField(raw, field, fallback);
  if (!(value > 0 && value <= 1)) {
    throw new ConfigValidationError(
      `"${field}" must be greater than 0 and at most 1`,
    );
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
 * 任意の正の整数の項目を読む。`null`、`undefined`、省略は「値無し」として`undefined`を返す。
 * 値があるときは正の整数だけを許す。
 */
function optionalPositiveIntegerField(
  raw: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = raw[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isNumber(value) || !Number.isInteger(value) || value <= 0) {
    throw new ConfigValidationError(`"${field}" must be a positive integer`);
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

const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * 秒まで書いたタイムゾーン付きのRFC 3339の日時か。
 * `Date.parse`は存在しない日(2月30日)や24時を黙って繰り上げるので、成分を自分で確かめる。
 */
function isIsoDateTime(value: string): boolean {
  const match = ISO_DATE_TIME.exec(value);
  if (match === null) {
    return false;
  }
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    match.slice(1).map((part) => (part === undefined ? 0 : Number(part)));
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    offsetHour === undefined ||
    offsetMinute === undefined
  ) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

/**
 * `raw[field]`を`Date`にして返す。値が無ければ`fallback`を返す。
 * `null`は値無しとして`null`を返す。文字列は、秒まで書いたタイムゾーン付きの
 * RFC 3339の日時だけを通す。それ以外は例外を投げる。
 */
function isoDateTimeOrNullField(
  raw: Record<string, unknown>,
  field: string,
  fallback: Date | null,
): Date | null {
  const value = raw[field];
  if (value === undefined) {
    return fallback;
  }
  if (value === null) {
    return null;
  }
  if (!isString(value) || !isIsoDateTime(value)) {
    throw new ConfigValidationError(
      `"${field}" must be an RFC 3339 date-time with seconds and a time zone, or null`,
    );
  }
  return new Date(value);
}

/**
 * `pr_ci_fix_max_rounds`の上限。直す作業項目はPRにpushするので、設定の書き損じで
 * 回数が際限なく増えないようにする。
 */
const PR_CI_FIX_MAX_ROUNDS_LIMIT = 10;

/** `pr_conflict_fix_max_rounds`の範囲。 */
const PR_CONFLICT_FIX_MAX_ROUNDS_RANGE = { min: 1, max: 5 } as const;

/** `pr_conflict_fix_max_rounds_per_pr`の範囲。 */
const PR_CONFLICT_FIX_MAX_ROUNDS_PER_PR_RANGE = { min: 2, max: 10 } as const;

/** `pr_conflict_fix_notify_grace_min`の範囲(分)。0は猶予なしを表す。 */
const PR_CONFLICT_FIX_NOTIFY_GRACE_RANGE = { min: 0, max: 1440 } as const;

/**
 * 競合を直す起動が有効なときの、`pr_conflict_fix_notify_grace_min`の下限(分)。
 * 巡回の間隔は5分で、10分なら巡回が2回、猶予の内側に入る。0だと最初の巡回で通知が先に出て、起動が一度も起きない。
 */
const PR_CONFLICT_FIX_NOTIFY_GRACE_MIN_WHEN_ENABLED = 10;

/**
 * `raw[field]`を、`min`以上`max`以下の整数として返す。値が無ければ`fallback`を返す。
 * 範囲を外れたときと、整数でないときは例外を投げる。
 */
function integerInRangeField(
  raw: Record<string, unknown>,
  field: string,
  fallback: number,
  range: { readonly min: number; readonly max: number },
): number {
  const value = raw[field];
  if (value === undefined) {
    return fallback;
  }
  if (
    !isNumber(value) ||
    !Number.isInteger(value) ||
    value < range.min ||
    value > range.max
  ) {
    throw new ConfigValidationError(
      `"${field}" must be an integer between ${String(range.min)} and ${String(range.max)}`,
    );
  }
  return value;
}

/** `value`が`limit`を超えるときは例外を投げる。 */
function atMost(field: string, value: number, limit: number): number {
  if (value > limit) {
    throw new ConfigValidationError(
      `"${field}" must not exceed ${String(limit)}`,
    );
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
 * `allowed_labeler_ids`を返す。値が無ければ既定値を返す。
 * キーは許可するログイン名、値はそのアカウントのGitHubの数値IDである。
 * 名前だけの照合では、改名の後に古い名前を取得した別人が許可されるため、IDでも照合させる。
 * 次のときは例外を投げる。
 * - オブジェクトでないとき、値が正の安全な整数でないとき。
 * - キーが`[bot]`で終わるとき。`allowed_labeler_logins`と同じく、自動化のアカウントは許可しない。
 * - キーが`logins`(`allowed_labeler_logins`)に含まれないとき。綴りの誤りで、
 *   IDを設定したつもりのアカウントが名前だけの照合になるのを防ぐ。大文字小文字は区別しない。
 * - 大文字小文字だけが違うキーが重なるとき。どちらのIDを使うかが決まらないため。
 * 型アサーションなしで型を付けるため、エントリーを1つずつ詰め直す。
 */
function labelerIdsField(
  raw: Record<string, unknown>,
  logins: readonly string[],
): Record<string, number> {
  const field = "allowed_labeler_ids";
  const value = raw[field];
  if (value === undefined) {
    return DEFAULTS.allowed_labeler_ids;
  }
  if (!isRecord(value)) {
    throw new ConfigValidationError(
      `"${field}" must be an object of GitHub numeric IDs`,
    );
  }
  const allowed = new Set(logins.map((login) => login.toLowerCase()));
  const seen = new Set<string>();
  const result: Record<string, number> = {};
  for (const [key, id] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (lower.endsWith("[bot]")) {
      throw new ConfigValidationError(
        `"${field}" must not contain an automation account: ${JSON.stringify(key)}`,
      );
    }
    if (!allowed.has(lower)) {
      throw new ConfigValidationError(
        `"${field}" key ${JSON.stringify(key)} must be listed in "allowed_labeler_logins"`,
      );
    }
    if (seen.has(lower)) {
      throw new ConfigValidationError(
        `"${field}" must not contain keys that differ only in case: ${JSON.stringify(key)}`,
      );
    }
    seen.add(lower);
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      throw new ConfigValidationError(
        `"${field}"[${JSON.stringify(key)}] must be a positive integer`,
      );
    }
    // `__proto__`のキーは、代入では自身のプロパティにならず値が黙って落ちる。
    // 落ちるとIDなしの設定に変わるので、定義で自身のプロパティにする。
    Object.defineProperty(result, key, {
      value: id,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
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

const STRICT_OWNER_SLASH_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * `dependabot_other_repos`を検証する。各項目は`<owner>/<repo>`の形に限る。
 * URLや余分な区切りを許さず、`.`と`..`の部分も拒否する。
 */
function dependabotOtherReposField(
  raw: Record<string, unknown>,
  fallback: string[],
): string[] {
  const field = "dependabot_other_repos";
  const value = stringArrayField(raw, field, fallback);
  for (const entry of value) {
    const parts = entry.split("/");
    if (
      !STRICT_OWNER_SLASH_REPO.test(entry) ||
      parts.some((part) => part === "." || part === "..") ||
      /\.git$/i.test(entry)
    ) {
      throw new ConfigValidationError(
        `"${field}" entries must be "<owner>/<repo>"`,
      );
    }
  }
  return value;
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

  const factoryRepoId = optionalPositiveIntegerField(raw, "factory_repo_id");
  const prCiFixEnabled = booleanField(
    raw,
    "pr_ci_fix_enabled",
    DEFAULTS.pr_ci_fix_enabled,
  );
  const prCiFixEnabledSince = isoDateTimeOrNullField(
    raw,
    "pr_ci_fix_enabled_since",
    DEFAULTS.pr_ci_fix_enabled_since,
  );
  // 起動を有効にしたのに時刻が無いと、有効にする前から残る失敗まで、一度に直しに行ってしまう。
  if (prCiFixEnabled && prCiFixEnabledSince === null) {
    throw new ConfigValidationError(
      '"pr_ci_fix_enabled_since" is required when "pr_ci_fix_enabled" is true',
    );
  }

  const prConflictWatchEnabled = booleanField(
    raw,
    "pr_conflict_watch_enabled",
    DEFAULTS.pr_conflict_watch_enabled,
  );
  const prConflictFixEnabled = booleanField(
    raw,
    "pr_conflict_fix_enabled",
    DEFAULTS.pr_conflict_fix_enabled,
  );
  const prConflictFixEnabledSince = isoDateTimeOrNullField(
    raw,
    "pr_conflict_fix_enabled_since",
    DEFAULTS.pr_conflict_fix_enabled_since,
  );
  const prConflictFixMaxRounds = integerInRangeField(
    raw,
    "pr_conflict_fix_max_rounds",
    DEFAULTS.pr_conflict_fix_max_rounds,
    PR_CONFLICT_FIX_MAX_ROUNDS_RANGE,
  );
  const prConflictFixMaxRoundsPerPr = integerInRangeField(
    raw,
    "pr_conflict_fix_max_rounds_per_pr",
    DEFAULTS.pr_conflict_fix_max_rounds_per_pr,
    PR_CONFLICT_FIX_MAX_ROUNDS_PER_PR_RANGE,
  );
  // 競合を直す起動は、競合の検知が記録した行を対象にするので、検知が止まっていれば何も起動できない。
  if (prConflictFixEnabled && !prConflictWatchEnabled) {
    throw new ConfigValidationError(
      '"pr_conflict_watch_enabled" must be true when "pr_conflict_fix_enabled" is true',
    );
  }
  // 時刻が無いと、有効にする前から残る競合まで、一度に直しに行ってしまう。
  if (prConflictFixEnabled && prConflictFixEnabledSince === null) {
    throw new ConfigValidationError(
      '"pr_conflict_fix_enabled_since" is required when "pr_conflict_fix_enabled" is true',
    );
  }
  const prConflictFixNotifyGraceMin = integerInRangeField(
    raw,
    "pr_conflict_fix_notify_grace_min",
    DEFAULTS.pr_conflict_fix_notify_grace_min,
    PR_CONFLICT_FIX_NOTIFY_GRACE_RANGE,
  );
  // 猶予が巡回の間隔(5分)に満たないと、最初の巡回で通知が先に出て、起動の判断が一度も回らない。
  // 無効の間は検査しない。使わない設定の値で読み込みが例外を投げると、Factory全体が止まるためである。
  if (
    prConflictFixEnabled &&
    prConflictFixNotifyGraceMin < PR_CONFLICT_FIX_NOTIFY_GRACE_MIN_WHEN_ENABLED
  ) {
    throw new ConfigValidationError(
      `"pr_conflict_fix_notify_grace_min" must be at least ${String(PR_CONFLICT_FIX_NOTIFY_GRACE_MIN_WHEN_ENABLED)} when "pr_conflict_fix_enabled" is true`,
    );
  }
  // PR全体の上限が競合1回の上限以下だと、競合1回の上限に達する前にPR全体が止まる。
  // 無効の間は検査しない。使わない設定の組み合わせで読み込みが例外を投げると、Factory全体が止まるためである。
  // 各値の範囲は、有効かどうかによらず上で検査する。
  if (
    prConflictFixEnabled &&
    prConflictFixMaxRoundsPerPr <= prConflictFixMaxRounds
  ) {
    throw new ConfigValidationError(
      '"pr_conflict_fix_max_rounds_per_pr" must be greater than "pr_conflict_fix_max_rounds"',
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

  const allowedLabelerLogins = labelerLoginsField(raw);

  return {
    owners,
    trigger_label: stringField(raw, "trigger_label", DEFAULTS.trigger_label),
    allowed_labeler_associations: resolvedAllowedLabelerAssociations,
    allowed_labeler_logins: allowedLabelerLogins,
    allowed_labeler_ids: labelerIdsField(raw, allowedLabelerLogins),
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
    ...(factoryRepoId === undefined ? {} : { factory_repo_id: factoryRepoId }),
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
    dependabot_merge_enabled: booleanField(
      raw,
      "dependabot_merge_enabled",
      DEFAULTS.dependabot_merge_enabled,
    ),
    dependabot_group_enabled: booleanField(
      raw,
      "dependabot_group_enabled",
      DEFAULTS.dependabot_group_enabled,
    ),
    dependabot_other_repos: dependabotOtherReposField(
      raw,
      DEFAULTS.dependabot_other_repos,
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
    pr_ci_watch_human_prs: booleanField(
      raw,
      "pr_ci_watch_human_prs",
      DEFAULTS.pr_ci_watch_human_prs,
    ),
    pr_ci_fix_enabled: prCiFixEnabled,
    pr_ci_fix_max_rounds: atMost(
      "pr_ci_fix_max_rounds",
      positiveIntegerField(
        raw,
        "pr_ci_fix_max_rounds",
        DEFAULTS.pr_ci_fix_max_rounds,
      ),
      PR_CI_FIX_MAX_ROUNDS_LIMIT,
    ),
    pr_ci_fix_enabled_since: prCiFixEnabledSince,
    pr_conflict_watch_enabled: prConflictWatchEnabled,
    pr_conflict_fix_enabled: prConflictFixEnabled,
    pr_conflict_fix_max_rounds: prConflictFixMaxRounds,
    pr_conflict_fix_max_rounds_per_pr: prConflictFixMaxRoundsPerPr,
    pr_conflict_fix_enabled_since: prConflictFixEnabledSince,
    pr_conflict_fix_notify_grace_min: prConflictFixNotifyGraceMin,
    gh_collect_enabled: booleanField(
      raw,
      "gh_collect_enabled",
      DEFAULTS.gh_collect_enabled,
    ),
    gh_collect_detail_enabled: booleanField(
      raw,
      "gh_collect_detail_enabled",
      DEFAULTS.gh_collect_detail_enabled,
    ),
    gh_source_dependabot: ghSourceField(
      raw,
      "gh_source_dependabot",
      DEFAULTS.gh_source_dependabot,
    ),
    gh_source_pr_conflict_watch: ghSourceField(
      raw,
      "gh_source_pr_conflict_watch",
      DEFAULTS.gh_source_pr_conflict_watch,
    ),
    gh_source_poll_issues: ghSourceField(
      raw,
      "gh_source_poll_issues",
      DEFAULTS.gh_source_poll_issues,
    ),
    gh_source_poll_prs: ghSourceField(
      raw,
      "gh_source_poll_prs",
      DEFAULTS.gh_source_poll_prs,
    ),
    gh_source_pr_ci_watch: ghSourceField(
      raw,
      "gh_source_pr_ci_watch",
      DEFAULTS.gh_source_pr_ci_watch,
    ),
    worker_alert_memory_ratio: ratioField(
      raw,
      "worker_alert_memory_ratio",
      DEFAULTS.worker_alert_memory_ratio,
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
 * 設定で明示されたリポジトリ。`factory_repo`と、`repo_allowlist`の各項目である。
 * `owners`はオーナーの全リポジトリを指すので展開しない。読めない項目は飛ばす。
 * 大文字小文字を区別せずに重なりを除き、最初の綴りを残す。
 */
export function configuredRepos(
  config: Pick<FactoryConfig, "factory_repo" | "repo_allowlist">,
): { owner: string; repo: string }[] {
  const seen = new Set<string>();
  const repos: { owner: string; repo: string }[] = [];
  for (const url of [config.factory_repo, ...config.repo_allowlist]) {
    let entry: { owner: string; repo: string };
    try {
      const parsed = parseGitHubRepoUrl(url);
      entry = { owner: parsed.owner, repo: parsed.repo };
    } catch {
      // 読めない項目は、許可の判定にも合わないので、列挙の対象にしない。
      continue;
    }
    const key = `${entry.owner}/${entry.repo}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    repos.push(entry);
  }
  return repos;
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
