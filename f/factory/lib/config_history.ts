// 設定(`factory_config`)の変更の履歴(`factory.config_history`)を扱う部品。
// 設定の値を許可リストで射影する関数、追記の呼び出し、連鎖の検証の呼び出し、証跡パックに載せる集計を持つ。
// 履歴の書き込みは、Consoleの設定の更新と全停止のscriptが、変更の成功の後に呼ぶ。
// Consoleの外の経路の変更は、定期の照合(`config_snapshot`)が、射影した値をそのまま書く(`appendConfigProjection`)。
// 履歴を書けなくても、設定の書き込みは戻さない。失敗は結果で返し、投げない。
// 連鎖のハッシュはSQL(`factory.config_history_row_hash`)が計算するので、言語をまたぐ正規化は持たない。
// 射影のハッシュ(コマンドとURLと身元に関わる値の、生の値の代わりに残す変化の検知の印)だけは、このファイルが計算する。
// ハッシュは塩を付けない。値の変化は検知できるが、値を隠すものではない。
// 候補が少ない値は、辞書や総当たりで元の値を当てられる。
//
// Console用workerのscriptがimportでたどれるので、保護パスの中のファイルだけを読む。
// 共通の部品(`lib/types.ts`、`lib/db.ts`、`lib/log.ts`)には頼らず、必要な型ガードをここに持つ。

import type { ActionSqlClient } from "./console_actions.ts";
import { holdsReference, redactText } from "./console_redact.ts";

/**
 * 設定の変更の理由コード。SQLの`factory.config_history_reason_codes()`と同じ一覧で、並びも同じにする。
 * 一致は、実DBの検査(`scripts/test-db-queries.ts`)が確かめる。
 * 理由コードは呼び出し側が明示する。
 * - console_update: Consoleの設定の更新で、真偽、数値、一覧の項目が変わり、書いた後の読み直しが期待と一致した。
 * - console_update_unverified: Consoleの設定の更新で書き込みは成功したが、読み直しが期待と一致しなかった。
 *   `after`は、読み直せたときは読み直した値の射影、読み直せなかったときは書こうとした値の射影である。
 * - stop_all_flag_off: Consoleの全停止が、`*_enabled`を`false`にした。
 * - unspecified: 呼び出し側が理由を決められなかった。
 * - out_of_band_change: 定期の照合が、Consoleの外の経路(CLI、Windmillの画面)の変更を見つけた。
 * - out_of_band_removed: 定期の照合が、履歴にある項目が設定から無くなったのを見つけた。
 * - snapshot_baseline: 定期の照合が、基準の段階(基準の印が書かれるまで)に、履歴にまだ無い項目の最初の値を残した。変更ではなく、比べる基準である。
 *   基準の印の行(項目名は`SNAPSHOT_BASELINE_MARKER_KEY`)も、この理由コードで書く。
 * - out_of_band_added: 定期の照合が、基準の印が書かれた後に、設定へ足された項目を見つけた。変更として数える。
 */
export const CONFIG_HISTORY_REASON_CODES = [
  "console_update",
  "console_update_unverified",
  "stop_all_flag_off",
  "unspecified",
  "out_of_band_change",
  "out_of_band_removed",
  "snapshot_baseline",
  "out_of_band_added",
] as const;

export type ConfigHistoryReasonCode =
  (typeof CONFIG_HISTORY_REASON_CODES)[number];

/** 変更ではなく、比べる基準として書く行の理由コード。期間の変更の件数には数えない。 */
const BASELINE_REASON_CODE: ConfigHistoryReasonCode = "snapshot_baseline";

/**
 * 基準の段階が終わったことを示す印の行の項目名。設定の項目ではない。
 * 照合が、基準の行をすべて書き終えた最後に1行だけ書く。この行がある間は、履歴にまだ無い項目は基準でなく、足された項目として扱う。
 * 証跡パックの集計には数えない。
 */
export const SNAPSHOT_BASELINE_MARKER_KEY = "config_snapshot_baseline";

/**
 * 変更を書いた経路。表の`source`の制約と同じ一覧である。
 * `out_of_band`は、Consoleの外の経路の変更を、定期の照合(`lib/config_snapshot.ts`)が見つけて書く。
 */
export const CONFIG_HISTORY_SOURCES = [
  "console",
  "stop_all",
  "out_of_band",
] as const;

export type ConfigHistorySource = (typeof CONFIG_HISTORY_SOURCES)[number];

export function isConfigHistoryReasonCode(
  value: unknown,
): value is ConfigHistoryReasonCode {
  const candidates: readonly string[] = CONFIG_HISTORY_REASON_CODES;
  return typeof value === "string" && candidates.includes(value);
}

// ---------------------------------------------------------------------------
// 射影
// ---------------------------------------------------------------------------

/**
 * 履歴の`before`と`after`に入れる値。生の値は入れず、次のどれかにする。
 * - 真偽、有限の数、短い列挙の文字列、時刻の文字列、null: そのまま。
 * - `{ count, hash }`: 一覧の件数と、要素の正規化したJSONのsha256の先頭16桁。要素の順は比べない(並べ替えてから数える)。
 *   件数だけでは、要素を別の要素に差し替えた変更が見えないので、ハッシュを添える。`hash`の無い`{ count }`は、ハッシュを足す前に書いた行の形で、読むだけである。
 * - `{ hash }`: コマンド、URL、身元に関わる値の正規化したJSONのsha256の先頭16桁。値が変わったかを検知するための印で、値を隠すものではない。
 *   塩を付けないので、候補が少ない値は、辞書や総当たりで当てられる。`changed`は、変更後の側だけに付く。
 * - `{ redacted: true, hash }`: 参照、秘密らしい語、秘密の形、形に合わない文字列の代わり。
 *   `hash`は生の値の正規化したJSONのsha256の先頭16桁で、メモリの中で計算するだけで、生の値は残さない。伏せた値の後の変更を見えなくしないために添える。
 *   参照の名前は秘密の値ではない。秘密らしい文字列は、塩を付けないハッシュなので、候補が少なければ当てられる。
 *   `hash`の無い`{ redacted: true }`は、ハッシュを足す前に書いた行の形で、読むだけである。
 * - `{ kind: "unknown" }`: 項目が表に無い(種類を知らない)。値は入れず、値の変更も追わない。
 * - `{ kind: "unknown", hash }`: 項目の種類を知っているが、値の型が合わない。`hash`は生の値の正規化したJSONのsha256の先頭16桁で、
 *   型に合わない値の差し替えを見えなくしないために添える。生の値は入れない。`hash`の無い形は、ハッシュを足す前に書いた行の形で、読むだけである。
 * - `{ kind: "marker" }`: 基準の段階が終わったことを示す印の行の値。定期の照合だけが書く。
 * - `{ kind: "object" }`: resource全体がオブジェクトに戻ったことを示す値。定期の照合だけが、予約の項目`config_snapshot_resource`に書く。
 *   resource全体がオブジェクトでない間の値は、`{ redacted: true, hash }`である(`projectNonObjectResource`)。
 * - `{ removed: true }`: 項目が設定から無くなった。定期の照合だけが、変更後の側に入れる。値が`null`の項目とは区別する。
 */
export type ConfigProjection =
  | boolean
  | number
  | string
  | null
  | { readonly count: number; readonly hash?: string }
  | { readonly hash: string; readonly changed?: boolean }
  | { readonly redacted: true; readonly hash?: string }
  | { readonly kind: "unknown"; readonly hash?: string }
  | { readonly kind: "marker" | "object" }
  | { readonly removed: true };

/** `{ hash }`だけの射影か。`{ count, hash }`、`{ redacted, hash }`、`{ kind: "unknown", hash }`は、`hash`を持っても、この形ではない。 */
export function isPlainHashProjection(
  projection: ConfigProjection,
): projection is { readonly hash: string; readonly changed?: boolean } {
  return (
    projection !== null &&
    typeof projection === "object" &&
    "hash" in projection &&
    !("count" in projection) &&
    !("redacted" in projection) &&
    !("kind" in projection)
  );
}

type KeyClass = "flag" | "number" | "timestamp" | "enum" | "count" | "hash";

/** 設定の旗(`<語幹>_enabled`)の語幹。 */
const FLAG_STEMS: readonly string[] = [
  "dependabot",
  "dependabot_group",
  "dependabot_merge",
  "design",
  "gh_collect",
  "gh_collect_detail",
  "implement",
  "investigate",
  "pr_ci_fix",
  "pr_ci_watch",
  "pr_conflict_fix",
  "pr_conflict_watch",
];

/** 設定の時刻(`<語幹>_enabled_since`)の語幹。 */
const SINCE_STEMS: readonly string[] = [
  "design",
  "pr_ci_fix",
  "pr_conflict_fix",
];

/**
 * 項目の種類を持つ項目。ここに無い項目は、値を問わず`{ kind: "unknown" }`になる(名前の規則に合う項目を除く)。
 * この表の名前が、このコードが知っている項目の一覧である(`isKnownConfigKey`)。
 * 名前の規則(`*_enabled`など)に合うだけの名前は、一覧に入れない。一覧は、照合が変更を書く順(知っている項目を先)と、
 * 知らない項目の数の上限に使うので、名前の規則だけで知っている項目に数えると、設定へ足した多数の項目が先の順を占められる。
 * 設定に足す項目は、ここに足す。足し忘れは、設定の解析の出力を調べるテストが見つける。
 */
const KEY_CLASSES: ReadonlyMap<string, KeyClass> = new Map<string, KeyClass>([
  // 生の値を残さず、ハッシュだけを残す項目。コマンド、URL、リポジトリ、身元に関わる。
  ...[
    "check_commands_by_repo",
    "allowed_check_commands",
    "factory_repo",
    "factory_repo_id",
    "windmill_public_url",
    "owners",
    "allowed_labeler_associations",
    "allowed_labeler_ids",
    "allowed_labeler_logins",
  ].map((key): [string, KeyClass] => [key, "hash"]),
  // 要素の形が名前かURLの一覧。件数と、要素のハッシュだけを残す。
  ...["repo_allowlist", "dependabot_other_repos", "default_reviewers"].map(
    (key): [string, KeyClass] => [key, "count"],
  ),
  ["pr_ci_watch_human_prs", "flag"],
  // 旗は、名前が`<語幹>_enabled`の形である。語幹で並べて、旗の名前をそろえる。
  ...FLAG_STEMS.map((stem): [string, KeyClass] => [`${stem}_enabled`, "flag"]),
  ...SINCE_STEMS.map((stem): [string, KeyClass] => [
    `${stem}_enabled_since`,
    "timestamp",
  ]),
  ...[
    "backup_keep_generations",
    "claude_timeout_sec",
    "credential_warn_days",
    "daily_budget_usd",
    "dependabot_min_published_days",
    "diff_max_lines",
    "implement_check_timeout_sec",
    "implement_flow_timeout_sec",
    "implement_max_budget_usd_per_run",
    "implement_max_changed_files",
    "implement_max_diff_lines",
    "implement_max_rounds",
    "implement_max_turns",
    "implement_timeout_sec",
    "max_attempts",
    "max_budget_usd_per_run",
    "max_design_attempts",
    "max_fix_changed_files",
    "max_fix_diff_lines",
    "max_fix_rounds",
    "max_lookback_days",
    "max_turns",
    "pr_ci_fix_max_rounds",
    "pr_conflict_fix_max_rounds",
    "pr_conflict_fix_max_rounds_per_pr",
    "pr_conflict_fix_notify_grace_min",
    "pr_review_full_max_turns",
    "retention_history_days",
    "retention_logs_days",
    "retention_work_items_days",
    "tracked_pr_days",
    "worker_alert_memory_ratio",
    "worktree_ttl_days",
  ].map((key): [string, KeyClass] => [key, "number"]),
  ...[
    "factory_branch",
    "fix_label",
    "heavy_model",
    "instance_name",
    "model",
    "review_label",
    "review_post_mode",
    "trigger_label",
  ].map((key): [string, KeyClass] => [key, "enum"]),
]);

/** `allowed_labeler_`で始まる項目は、ログイン名とIDを持つので、ハッシュだけを残す。 */
const HASHED_PREFIX = "allowed_labeler_";

function classOf(key: string): KeyClass | undefined {
  if (key.startsWith(HASHED_PREFIX)) return "hash";
  const known = KEY_CLASSES.get(key);
  if (known !== undefined) return known;
  if (key.endsWith("_enabled")) return "flag";
  return key.endsWith("_enabled_since") ? "timestamp" : undefined;
}

/** このコードが種類を知っている項目の名前か。名前の規則に合うだけの項目は、知らない項目として扱う。 */
export function isKnownConfigKey(key: string): boolean {
  return KEY_CLASSES.has(key);
}

const UNKNOWN: ConfigProjection = { kind: "unknown" };

/** 列挙の項目に通す文字列の形。短い名前に限る。 */
const ENUM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,59}$/;

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** `lib/console_redact.ts`の秘密の語と同じ一覧。語を含む文字列は、値として残さない。 */
const SECRET_WORD =
  /TOKEN|SECRET|KEY|PASSWORD|WEBHOOK|CREDENTIAL|AUTHORIZATION/i;

/** 文字列を、秘密らしさで調べ、そのまま残してよいときだけ残す。参照は、呼び出しの前に`projectConfigValue`が伏せる。 */
function projectString(
  value: string,
  fits: (text: string) => boolean,
): ConfigProjection {
  if (SECRET_WORD.test(value)) return redacted(value);
  if (redactText(value).masked) return redacted(value);
  return fits(value) ? value : redacted(value);
}

function isTimestampText(text: string): boolean {
  return ISO_TIMESTAMP_PATTERN.test(text) && Number.isFinite(Date.parse(text));
}

const CANONICAL_DEPTH_MAX = 32;

/**
 * 値を、キーを辞書順に並べたJSONの文字列にする。同じ値は、キーの順によらず同じ文字列になる。
 * 配列の順は保つ。JSONにできない値と、深すぎる入れ子は、固定の印にする。
 */
function canonicalJson(value: unknown, depth = 0): string {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (depth >= CANONICAL_DEPTH_MAX) return '"[deep]"';
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries
      .map(
        ([key, child]) =>
          `${JSON.stringify(key)}:${canonicalJson(child, depth + 1)}`,
      )
      .join(",")}}`;
  }
  return "null";
}

/** 正規化したJSONのsha256(16進)の先頭16桁。 */
function shortHash(value: unknown): string {
  return new Bun.CryptoHasher("sha256")
    .update(canonicalJson(value))
    .digest("hex")
    .slice(0, 16);
}

/**
 * 値を伏せた射影にする。生の値は残さず、生の値のハッシュだけを持つ。
 * ハッシュは、伏せた値が後で別の値に変わったことを見えなくしないために添える。メモリの中で計算するだけで、ログにも返り値にも出さない。
 */
function redacted(value: unknown): ConfigProjection {
  return { redacted: true, hash: shortHash(value) };
}

/**
 * 項目の種類を知っているが、値の型が合わないときの射影。生の値は残さず、生の値のハッシュだけを持つ。
 * 型に合わない値を、別の型に合わない値へ差し替えた変更を見えなくしないために、ハッシュを添える。
 * 種類を知らない項目(表に無い項目)の値は、意図して追わないので、ハッシュを添えない。
 */
function mismatched(value: unknown): ConfigProjection {
  return { kind: "unknown", hash: shortHash(value) };
}

/**
 * resource全体がオブジェクトでないときの、値の射影。`{ redacted: true, hash }`で、生の値は残さない。
 * 参照だけの値(`"$res:<path>"`)は、補間する読み取りが参照先のオブジェクトに解決するので、ほかの読み取りは動き続ける。
 * 補間しない読み取りだけが、文字列を見る。
 */
export function projectNonObjectResource(raw: unknown): ConfigProjection {
  return redacted(raw);
}

/** 一覧の要素のハッシュ。要素の順は意味を持たないので、要素を正規化してから並べ替えて、ハッシュにする。 */
function listHash(items: readonly unknown[]): string {
  return shortHash(items.map((item) => canonicalJson(item)).sort());
}

/**
 * 設定の1項目の値を、履歴に入れる形にする。生の値は、項目の種類が真偽、数、時刻、短い列挙のときだけ残す。
 * 項目の種類は、このファイルの表と、`*_enabled`と`allowed_labeler_`の名前で決める。表に無い項目は、値を入れず、ハッシュも添えない。
 * 値の型が項目の種類に合わないときは、値を入れず、生の値のハッシュだけを添える(`{ kind: "unknown", hash }`)。
 * 値が参照(`$var:`、`$res:`、`$jsonvar:`)を含むときは、項目の種類によらず、参照の先を調べずに伏せる(`{ redacted: true, hash }`)。
 */
export function projectConfigValue(
  key: string,
  value: unknown,
): ConfigProjection {
  if (holdsReference(value)) return redacted(value);
  const kind = classOf(key);
  if (kind === undefined) return UNKNOWN;
  if (kind === "hash") return { hash: shortHash(value) };
  if (value === null) return null;
  switch (kind) {
    case "flag":
      return typeof value === "boolean" ? value : mismatched(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? value
        : mismatched(value);
    case "count":
      return Array.isArray(value)
        ? { count: value.length, hash: listHash(value) }
        : mismatched(value);
    case "timestamp":
      return typeof value === "string"
        ? projectString(value, isTimestampText)
        : mismatched(value);
    case "enum":
      return typeof value === "string"
        ? projectString(value, (text) => ENUM_PATTERN.test(text))
        : mismatched(value);
  }
}

/** 履歴の1行の`before`と`after`。値が無かった側は`null`である。 */
export type ConfigChangeProjection = {
  readonly before: ConfigProjection;
  readonly after: ConfigProjection;
};

function projectSide(key: string, value: unknown): ConfigProjection {
  return value === undefined ? null : projectConfigValue(key, value);
}

/**
 * 変更の前後の値を射影する。値が無かった側(`undefined`)は`null`にする。
 * ハッシュの項目は、変更後の側に、前後のハッシュが違うかを示す`changed`を付ける。
 */
export function projectConfigChange(
  key: string,
  before: unknown,
  after: unknown,
): ConfigChangeProjection {
  const projectedBefore = projectSide(key, before);
  const projectedAfter = projectSide(key, after);
  if (
    classOf(key) === "hash" &&
    isPlainHashProjection(projectedBefore) &&
    isPlainHashProjection(projectedAfter)
  ) {
    return {
      before: projectedBefore,
      after: {
        hash: projectedAfter.hash,
        changed: projectedBefore.hash !== projectedAfter.hash,
      },
    };
  }
  return { before: projectedBefore, after: projectedAfter };
}

// ---------------------------------------------------------------------------
// 追記
// ---------------------------------------------------------------------------

/** 履歴に残す変更1つ。`before`と`after`は設定の生の値で、書く前にこのファイルが射影する。 */
export type ConfigChangeInput = {
  readonly key: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly actor: string;
  readonly source: ConfigHistorySource;
  readonly reason: ConfigHistoryReasonCode;
  /** 変更の時刻。省くと、DBの呼び出しの時刻を使う。 */
  readonly occurredAt?: Date;
};

/**
 * 追記の失敗の種類。
 * - invalid: 入力が表の形に合わなかった。文は流していない。
 * - missing_table: 表か関数が無い(migrationが未反映)。
 * - write_failed: DBに届かない、返ったidが読めないなど、書けなかった。
 */
export type ConfigHistoryFailureKind =
  | "invalid"
  | "missing_table"
  | "write_failed";

export type ConfigHistoryAppendResult =
  | { readonly recorded: true; readonly id: number }
  | {
      readonly recorded: false;
      readonly kind: ConfigHistoryFailureKind;
      readonly reason: string;
    };

const ITEM_KEY_PATTERN = /^[a-z][a-z0-9_]{0,79}$/;
const ACTOR_MAX = 100;

/** 履歴の表の項目名の形(識別子)に合うか。合わない名前の項目は、履歴に書けない。 */
export function isConfigItemKey(key: string): boolean {
  return ITEM_KEY_PATTERN.test(key);
}
const FAILURE_REASON_MAX = 200;

const MISSING_OBJECT_PATTERN =
  /(?:relation "(?:factory\.)?config_history"|function (?:factory\.)?config_history_(?:append|verify)\([^)]*\)) does not exist/;
const ANY_MISSING_OBJECT_PATTERN =
  /(?:relation "[^"]+"|function [^\n]*\)) does not exist/;

/**
 * 例外が、設定の履歴の表か関数が無いことによるものかを返す。
 * migrationより先にコードが反映された間は、表と関数が無い。
 * エラーコード42P01(表が無い)と42883(関数が無い)でも、文が別の名前を挙げているときはfalseにする。
 * 文が名前を挙げていないときは、コードだけで判定する。
 */
export function isMissingConfigHistoryObjectError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const body: unknown = Reflect.get(err, "body");
  const messages = [err.message, typeof body === "string" ? body : ""];
  if (messages.some((m) => MISSING_OBJECT_PATTERN.test(m))) return true;
  if (messages.some((m) => ANY_MISSING_OBJECT_PATTERN.test(m))) return false;
  const code: unknown = Reflect.get(err, "code");
  return code === "42P01" || code === "42883";
}

/** 数か、数字の文字列を整数にする。読めなければnull。bigintとcountは、ドライバにより文字列でも返る。 */
function toInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

function failure(
  kind: ConfigHistoryFailureKind,
  reason: string,
): ConfigHistoryAppendResult {
  console.warn(`config history: not recorded (${kind})`);
  return { recorded: false, kind, reason };
}

function inputProblem(input: {
  readonly key: string;
  readonly actor: string;
}): string | null {
  if (!ITEM_KEY_PATTERN.test(input.key)) {
    return "key must be lowercase letters, digits and underscores";
  }
  if (input.actor.length < 1 || input.actor.length > ACTOR_MAX) {
    return "actor must be 1 to 100 characters";
  }
  return null;
}

function jsonOrNull(value: ConfigProjection): string | null {
  return value === null ? null : JSON.stringify(value);
}

/** 射影済みの変更1つ。`before`と`after`は、`projectConfigValue`などで射影した値で、そのまま履歴に書く。 */
export type ConfigProjectionInput = {
  readonly key: string;
  readonly before: ConfigProjection;
  readonly after: ConfigProjection;
  readonly actor: string;
  readonly source: ConfigHistorySource;
  readonly reason: ConfigHistoryReasonCode;
  /** 変更の時刻。省くと、DBの呼び出しの時刻を使う。 */
  readonly occurredAt?: Date;
};

/**
 * 設定の変更1つを、射影済みの値のまま、履歴に1行足す。値は再び射影せず、パラメータとして渡す。
 * 生の値を持たない呼び出し側(定期の照合は、前の値の射影しか持たない)のために、`appendConfigChange`とは別に持つ。
 * 失敗しても投げず、結果で返す。失敗の理由の文は、秘密をマスクして200字までにする。
 */
export async function appendConfigProjection(
  sql: ActionSqlClient,
  input: ConfigProjectionInput,
): Promise<ConfigHistoryAppendResult> {
  try {
    const problem = inputProblem(input);
    if (problem !== null) return failure("invalid", problem);
    const rows = await sql`
      SELECT factory.config_history_append(
        ${input.key}::text,
        ${input.reason}::text,
        ${jsonOrNull(input.before)}::jsonb,
        ${jsonOrNull(input.after)}::jsonb,
        ${input.actor}::text,
        ${input.source}::text,
        ${input.occurredAt === undefined ? null : input.occurredAt.toISOString()}::timestamptz
      ) AS id
    `.fetch();
    const row = rows[0];
    if (row === undefined) {
      return failure("write_failed", "the append returned no row");
    }
    const id = toInt(row.id);
    if (id === null) {
      return failure(
        "write_failed",
        "the append returned an id that cannot be read",
      );
    }
    return { recorded: true, id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason =
      `could not write the config history: ${redactText(message).text}`.slice(
        0,
        FAILURE_REASON_MAX,
      );
    return failure(
      isMissingConfigHistoryObjectError(err) ? "missing_table" : "write_failed",
      reason,
    );
  }
}

/**
 * 設定の変更1つを、履歴に1行足す。値は射影してから、パラメータとして渡す。
 * 失敗しても投げず、結果で返す。履歴を書けなくても、設定の書き込みは戻さないためである。
 * 失敗の理由の文は、秘密をマスクして200字までにする。
 */
export async function appendConfigChange(
  sql: ActionSqlClient,
  input: ConfigChangeInput,
): Promise<ConfigHistoryAppendResult> {
  const problem = inputProblem(input);
  if (problem !== null) return failure("invalid", problem);
  let projected: ConfigChangeProjection;
  try {
    projected = projectConfigChange(input.key, input.before, input.after);
  } catch {
    return failure("invalid", "the value could not be projected");
  }
  return await appendConfigProjection(sql, {
    key: input.key,
    before: projected.before,
    after: projected.after,
    actor: input.actor,
    source: input.source,
    reason: input.reason,
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
  });
}

// ---------------------------------------------------------------------------
// 検証と証跡パックの集計
// ---------------------------------------------------------------------------

/** 検証を通らなかった行の位置。`reason`は`gap`、`prev_hash_mismatch`、`row_hash_mismatch`のどれかである。 */
export type ConfigBrokenPosition = {
  readonly seq: number;
  readonly reason: string;
};

/** 期間内の変更の件数を、項目ごとに数えたもの。 */
export type ConfigItemCount = {
  readonly item_key: string;
  readonly count: number;
};

/** 期間内の変更の件数を、理由コードごとに数えたもの。 */
export type ConfigReasonCount = {
  readonly reason_code: string;
  readonly count: number;
};

/**
 * 証跡パックに載せる設定の履歴の集計。
 * `chain_rows`、`last_seq`、`broken`は、期間にかかわらず全体の連鎖の結果である。改ざんは、期間の外の行にも及びうるためである。
 * 期間の集計は、`start`を含み`end`を含まない。
 * 履歴を書けなかった操作は、履歴の表には残らないので、操作の記録の印から数える。
 */
export type ConfigHistoryEvidence = {
  /** 履歴の表と関数がある。migrationが当たる前は偽で、ほかの値は空である。 */
  readonly available: boolean;
  /** 連鎖の行の数。 */
  readonly chain_rows: number;
  /** 連鎖の最後の連番。行が無いときは0。 */
  readonly last_seq: number;
  readonly broken: readonly ConfigBrokenPosition[];
  /** 期間内の変更の数。基準(`snapshot_baseline`)の行は、変更ではないので数えない。 */
  readonly period_changes: number;
  /** 期間内の基準(`snapshot_baseline`)の行の数。照合が、履歴にまだ無い項目の最初の値として書く。 */
  readonly period_baseline: number;
  /** 基準の行を除いた件数の降順、同数なら項目名の昇順。 */
  readonly period_by_item: readonly ConfigItemCount[];
  /** 基準の行を含む件数の降順、同数なら理由コードの昇順。 */
  readonly period_by_reason: readonly ConfigReasonCount[];
  /**
   * 期間内の操作の記録(`factory.console_actions`)のうち、履歴を書けなかった印(`history_recorded`が`false`)を持つ行の数。
   * 操作の記録は90日で消えるので、数えられるのはその範囲に限る。
   */
  readonly unrecorded_operations: number;
};

/** 履歴の表が無い間の値。 */
export const EMPTY_CONFIG_HISTORY_EVIDENCE: ConfigHistoryEvidence = {
  available: false,
  chain_rows: 0,
  last_seq: 0,
  broken: [],
  period_changes: 0,
  period_baseline: 0,
  period_by_item: [],
  period_by_reason: [],
  unrecorded_operations: 0,
};

function toBrokenPosition(row: Record<string, unknown>): ConfigBrokenPosition {
  const seq = toInt(row.bad_seq);
  if (seq === null || typeof row.reason !== "string") {
    throw new Error("config_history_verify: a row has a shape it cannot read");
  }
  return { seq, reason: row.reason };
}

/**
 * 連鎖を検証し、壊れた位置をseqの昇順で返す。
 * 検証はSQLの`factory.config_history_verify`が行う。連鎖の末尾の行を消した改ざんは、検出できない。
 */
export async function verifyConfigHistory(
  sql: ActionSqlClient,
): Promise<ConfigBrokenPosition[]> {
  const rows = await sql`
    SELECT bad_seq, reason
    FROM factory.config_history_verify()
    ORDER BY bad_seq
  `.fetch();
  return rows.map(toBrokenPosition);
}

function compareByCountThen(
  a: { readonly count: number; readonly name: string },
  b: { readonly count: number; readonly name: string },
): number {
  if (a.count !== b.count) return b.count - a.count;
  if (a.name < b.name) return -1;
  return a.name > b.name ? 1 : 0;
}

/** 名前ごとの件数を足し、件数の降順、同数なら名前の昇順に並べる。 */
function tally(
  entries: readonly { readonly name: string; readonly count: number }[],
): { readonly name: string; readonly count: number }[] {
  const totals = new Map<string, number>();
  for (const entry of entries) {
    totals.set(entry.name, (totals.get(entry.name) ?? 0) + entry.count);
  }
  return [...totals.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort(compareByCountThen);
}

const MISSING_ACTIONS_PATTERN =
  /relation "(?:factory\.)?console_actions" does not exist/;

/** 例外が、操作の記録の表が無いことによるものか。文が別の名前を挙げているときはfalseにする。 */
function isMissingConsoleActionsError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const body: unknown = Reflect.get(err, "body");
  const messages = [err.message, typeof body === "string" ? body : ""];
  if (messages.some((m) => MISSING_ACTIONS_PATTERN.test(m))) return true;
  if (messages.some((m) => ANY_MISSING_OBJECT_PATTERN.test(m))) return false;
  return Reflect.get(err, "code") === "42P01";
}

/**
 * 期間内の操作の記録のうち、履歴を書けなかった印を持つ行の数。
 * 操作の記録の表が無いときは0を返す。ほかのエラーは投げる。
 */
async function countUnrecordedOperations(
  sql: ActionSqlClient,
  start: string,
  end: string,
): Promise<number> {
  try {
    const rows = await sql`
      SELECT count(*) AS unrecorded
      FROM factory.console_actions a
      WHERE a.occurred_at >= ${start}::timestamptz AND a.occurred_at < ${end}::timestamptz
        AND a.changes ->> 'history_recorded' = 'false'
    `.fetch();
    return toInt(rows[0]?.unrecorded) ?? 0;
  } catch (err) {
    if (!isMissingConsoleActionsError(err)) throw err;
    return 0;
  }
}

/**
 * 証跡パックに載せる設定の履歴の集計を集める。`start`と`end`は期間のISO文字列で、`start`を含み`end`を含まない。
 * 表か関数が無いとき(migrationより先にコードが反映された間)は、`EMPTY_CONFIG_HISTORY_EVIDENCE`を返す。
 * ほかのエラーは投げる。
 */
export async function collectConfigHistoryEvidence(
  sql: ActionSqlClient,
  start: string,
  end: string,
): Promise<ConfigHistoryEvidence> {
  try {
    const broken = await verifyConfigHistory(sql);
    const chainRows = await sql`
      SELECT count(*) AS chain_rows, coalesce(max(c.seq), 0) AS last_seq
      FROM factory.config_history c
    `.fetch();
    const periodRows = await sql`
      SELECT c.item_key, c.reason_code, count(*) AS changes
      FROM factory.config_history c
      WHERE c.occurred_at >= ${start}::timestamptz AND c.occurred_at < ${end}::timestamptz
      GROUP BY c.item_key, c.reason_code
    `.fetch();
    const unrecordedOperations = await countUnrecordedOperations(
      sql,
      start,
      end,
    );
    // 基準の段階が終わった印の行は、設定の項目の行ではないので、どの件数にも数えない(連鎖の行の数には入る)。
    const counted = periodRows.flatMap((row) => {
      const count = toInt(row.changes);
      return typeof row.item_key === "string" &&
        row.item_key !== SNAPSHOT_BASELINE_MARKER_KEY &&
        typeof row.reason_code === "string" &&
        count !== null
        ? [{ item_key: row.item_key, reason_code: row.reason_code, count }]
        : [];
    });
    const changes = counted.filter(
      (row) => row.reason_code !== BASELINE_REASON_CODE,
    );
    return {
      available: true,
      chain_rows: toInt(chainRows[0]?.chain_rows) ?? 0,
      last_seq: toInt(chainRows[0]?.last_seq) ?? 0,
      broken,
      period_changes: changes.reduce((sum, row) => sum + row.count, 0),
      period_baseline: counted
        .filter((row) => row.reason_code === BASELINE_REASON_CODE)
        .reduce((sum, row) => sum + row.count, 0),
      period_by_item: tally(
        changes.map((row) => ({ name: row.item_key, count: row.count })),
      ).map(({ name, count }) => ({ item_key: name, count })),
      period_by_reason: tally(
        counted.map((row) => ({ name: row.reason_code, count: row.count })),
      ).map(({ name, count }) => ({ reason_code: name, count })),
      unrecorded_operations: unrecordedOperations,
    };
  } catch (err) {
    if (!isMissingConfigHistoryObjectError(err)) throw err;
    return EMPTY_CONFIG_HISTORY_EVIDENCE;
  }
}
