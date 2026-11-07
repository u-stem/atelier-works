// Consoleから、factory_configの許可した項目を1つ変更するscript。
//
// 変更できるのは、次の項目と向きだけである。
// - 真偽の項目(`BOOLEAN_STOP_ITEMS`): `true`から`false`へ。自動でGitHubに書く機能を止める向きだけで、有効にする向きは人がCLIで行う。
// - 数値の項目(`LOWERABLE_NUMBERS`): いまの値より小さい値へ。下限は項目ごとに決める。
// - 文字列の一覧の項目(`LIST_ITEMS`): `repo_allowlist`、`dependabot_other_repos`、`default_reviewers`の3つ。
//   1回の呼び出しで、1要素の追加か、1要素の削除だけをする。
//   `expected`と`next`は配列で、`next`が`expected`の末尾に1要素を足した形か、`expected`からちょうど1要素を除いた形でなければ断る。
//   並べ替え、書き換え、複数要素の増減は断る。動いた要素は、この差分から導く。
//   書く値は、書く直前に読み直した配列に、その1要素を足すか除くかしたものである。`expected`は比較にだけ使い、書かない。
// 許可表の外の項目、`owners`や`allowed_*`のような権限に関わる設定、`*_since`は、変更できない。
//
// 真偽と数値の変更は、設定の組み合わせの検査(有効にする向きの検査だけ)に触れない。
// 一覧の3項目には、他の項目との組み合わせの検査が無い。
// そのため、書く前に置き換えた全体を設定の読み込みの検証にかけず、許可した項目の検査だけで書く。
// 全体の検証を持つと、その本体(`lib/config.ts`)も保護パスになり、設定項目の追加で自動の変更が止まるためである。
// 一覧に足せる要素の形は、読み込み側と同じ規則にそろえて、このファイルに写している(`lib/config.ts`は読み込まない)。
// 許可した変更の後も設定が読めることと、写した規則が読み込み側と食い違わないことは、
// 実際の読み込みを通す契約テスト(`tests/scripts/console_config_update.test.ts`)が両方向で固定する。
// 一覧の追加は対象を広げる向きなので、形のほかに次の2つを断る。
// - `repo_allowlist`を空にする削除。空の一覧は、`owners`配下のすべてのリポジトリを対象にするためである。
// - `repo_allowlist`への追加で、URLのownerが`owners`に無いもの。足しても効かないのに、成功に見えるためである。
//
// 補間しない生の値を読み、許可した1項目だけを置き換えて、全体を書き戻す。他のキーは同じ文字列のまま残す。
// 値のどこかに`$var:`か`$res:`があれば、参照の先をこのscriptが解決しないよう、変更しない。
// 呼び出し側が「読んだ時の値」を渡し、書く直前に読み直した値と違えば変更しない(比較交換)。
// 一覧は、要素を順序つきで比べる。
// Windmillのresourceの更新は条件付きの書き込みを持たないので、書く直前の読み取りから書き込みまでの間は原子的でない。
// その間に別の経路が書いた変更は、項目を問わず、全体の書き戻しで失われ、検出できない。
// 書いた後の読み直しが検出するのは、書き込みの後に起きた変更だけである。
// この間が実際に問題になるのは、別の経路が同時に書く場合に限る。同じscriptの別の呼び出しは、
// Console用workerが1枠(`infra/docker-compose.yml`の`replicas`が1)なので、重ならない。
// その前提は`tests/scripts/console_script_tags.test.ts`が固定する。
//
// 操作の記録(`factory.console_actions`)は、読み取りの前に`attempted`の行を入れ、後で結果を更新する。
// 記録するのは項目名と前後の値(数値か真偽)だけで、設定の全体は入れない。
// 一覧では、項目名、操作(`add`か`remove`)、動かした要素、前後の件数を記録し、配列の中身は入れない。
// 要素は形を検査済みで、資格情報を含むURL(userinfo)は形の検査で断るので、記録に資格情報は入らない。
// 行を入れられなければ、変更せずに断る。更新に失敗しても変更は戻さず、`action_audit`を`failed`にする。
// 操作者は、ジョブのWindmill実行文脈から導く(`deriveApprover`)。導けなければ断る。引数に操作者は取らない。
//
// Console用workerで動くので、どのsecret変数も読まない。SDKの呼び出しは、境界テストの許可表に収める。
// 読み書きするパスはリテラルの`f/factory/factory_config`だけで、境界テストが固定する。

import wmillDefault, * as wmill from "windmill-client@1.817.0";
import { deriveApprover } from "./lib/approver.ts";
import {
  type ActionAudit,
  type ActionSqlClient,
  actionSqlClientFrom,
  type RecordedOperation,
  runRecordedAs,
} from "./lib/console_actions.ts";
import { holdsReference, isRecord } from "./lib/console_redact.ts";

const CONFIG_TARGET = "f/factory/factory_config";

/**
 * `true`から`false`へだけ変えられる真偽の項目。どれも、自動でGitHubに書くか、実装を起動する機能の入口である。
 * `pr_conflict_watch_enabled`は、GitHubに書かず通知だけなので入れない。`*_since`には触れない。
 */
export const BOOLEAN_STOP_ITEMS: readonly string[] = [
  "implement_enabled",
  "dependabot_enabled",
  "dependabot_merge_enabled",
  "pr_ci_fix_enabled",
  "pr_conflict_fix_enabled",
];

/**
 * 数値の項目の規則。`integer`は整数に限る。下限は`minimum`で、`minimumExclusive`なら下限を含まない。
 * 新しい値は、いまの値より小さい値に限るので、上限は持たない。
 */
export type NumberRule = {
  readonly integer: boolean;
  readonly minimum: number;
  readonly minimumExclusive: boolean;
};

/**
 * いまの値より小さい値へだけ変えられる数値の項目。予算は0より大きい値、回数と行数と件数は1以上の整数に限る。
 * 0にすると、設定の検証が拒否するか、Claudeの利用が止まる。止めるのは真偽の項目の役割である。
 * 型の他の数値の項目(`retention_*`、`dependabot_min_published_days`、`worker_alert_memory_ratio`、`*_timeout_sec`)は、
 * 変更できない。
 */
export const LOWERABLE_NUMBERS: Readonly<Record<string, NumberRule>> = {
  daily_budget_usd: { integer: false, minimum: 0, minimumExclusive: true },
  max_budget_usd_per_run: {
    integer: false,
    minimum: 0,
    minimumExclusive: true,
  },
  max_fix_rounds: { integer: true, minimum: 1, minimumExclusive: false },
  implement_max_changed_files: {
    integer: true,
    minimum: 1,
    minimumExclusive: false,
  },
  max_fix_diff_lines: { integer: true, minimum: 1, minimumExclusive: false },
};

/** 断る理由。画面は日本語の固定文に直す。 */
export const CONFIG_UPDATE_REFUSAL_REASONS = [
  "item_not_allowed",
  "invalid_value",
  "not_lowering",
  "has_reference",
  "conflict",
  "actor_unknown",
  "audit_unavailable",
  // 一覧の追加と削除だけが返す理由。
  "already_present",
  "not_present",
  "invalid_element",
  "would_empty",
  "owner_not_listed",
] as const;

export type ConfigUpdateRefusalReason =
  (typeof CONFIG_UPDATE_REFUSAL_REASONS)[number];

/**
 * 一覧の項目を変えた結果。`op`で、真偽と数値の結果と見分ける。
 * `element`は書いた(除いた)要素で、追加では書いた形である。件数は、操作の前後の要素数。
 */
export type ConfigListUpdate = {
  readonly refused: false;
  readonly item: string;
  readonly op: ListOperation;
  readonly element: string;
  readonly before_count: number;
  readonly after_count: number;
  /** 書いた後に読み直した値が、期待と同じか(対象の項目が新しい一覧で、他のキーが同じ)。 */
  readonly verified: boolean;
  readonly action_audit: ActionAudit;
};

export type ConfigUpdateResult =
  | { readonly refused: true; readonly reason: ConfigUpdateRefusalReason }
  | {
      readonly refused: false;
      readonly item: string;
      readonly before: number | boolean;
      readonly after: number | boolean;
      /** 書いた後に読み直した値が、期待と同じか(対象の項目が新しい値で、他のキーが同じ)。 */
      readonly verified: boolean;
      readonly action_audit: ActionAudit;
    }
  | ConfigListUpdate;

/** 一覧の項目で行える操作。 */
export type ListOperation = "add" | "remove";

/**
 * 1要素の追加と削除だけができる、文字列の一覧の項目。
 * どれも他の項目との組み合わせの検査を持たない。
 */
export const LIST_ITEMS: readonly string[] = [
  "repo_allowlist",
  "dependabot_other_repos",
  "default_reviewers",
];

/**
 * 一覧に足せる要素の長さの上限。操作の記録(`lib/console_actions.ts`)が、文字列の値を100字までに限るためである。
 * これを超える要素は、記録を入れられず、変更を断ることになる。GitHubのURLとログイン名は通常この中に収まる。
 */
export const MAX_ELEMENT_LENGTH = 100;

/** `updateConfigFromConsole`が使う外部の操作。テストでは差し替える。 */
export type ConfigUpdatePorts = {
  /** 操作者を返す。導けないときは例外を投げる。 */
  readonly deriveActor: () => string;
  /** 補間しない生の値を返す。 */
  readonly readConfig: () => Promise<unknown>;
  readonly writeConfig: (value: Record<string, unknown>) => Promise<void>;
  readonly sql: ActionSqlClient;
};

function ownRule(item: string): NumberRule | undefined {
  return Object.hasOwn(LOWERABLE_NUMBERS, item)
    ? LOWERABLE_NUMBERS[item]
    : undefined;
}

type Change =
  | {
      readonly kind: "ok";
      readonly before: number | boolean;
      readonly after: number | boolean;
    }
  | { readonly kind: "refused"; readonly reason: ConfigUpdateRefusalReason };

function refusedWith(reason: ConfigUpdateRefusalReason): Change {
  return { kind: "refused", reason };
}

function numberFits(value: unknown, rule: NumberRule): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (rule.integer && !Number.isInteger(value)) return false;
  return rule.minimumExclusive ? value > rule.minimum : value >= rule.minimum;
}

/**
 * 項目と、読んだ時の値と、新しい値が、許可表に合うか判定する。外部を読まず、記録も書かない。
 * 項目が許可表の外なら`item_not_allowed`、値の型や範囲が合わなければ`invalid_value`、
 * 止める向き(真偽は`true`から`false`)か下げる向き(数値は小さい値)でなければ`not_lowering`にする。
 */
export function checkChange(
  item: string,
  expected: unknown,
  next: unknown,
): Change {
  if (BOOLEAN_STOP_ITEMS.includes(item)) {
    if (typeof expected !== "boolean" || typeof next !== "boolean") {
      return refusedWith("invalid_value");
    }
    return expected && !next
      ? { kind: "ok", before: expected, after: next }
      : refusedWith("not_lowering");
  }
  const rule = ownRule(item);
  if (rule === undefined) return refusedWith("item_not_allowed");
  if (!numberFits(expected, rule) || !numberFits(next, rule)) {
    return refusedWith("invalid_value");
  }
  return next < expected
    ? { kind: "ok", before: expected, after: next }
    : refusedWith("not_lowering");
}

type WriteStep =
  | { readonly kind: "refused"; readonly reason: ConfigUpdateRefusalReason }
  | { readonly kind: "written"; readonly verified: boolean };

/** 項目以外のキーを同じ順に並べた文字列。書き戻しの前後で、他のキーが変わらないことの確認に使う。 */
function withoutItem(config: Record<string, unknown>, item: string): string {
  return JSON.stringify(Object.entries(config).filter(([key]) => key !== item));
}

/**
 * 書いた後の読み直し。読めない、対象の項目が期待と違う、他のキーが違うときは、`false`。
 * `matches`は、読み直した対象の項目の値が、書いた値と同じかを判定する。
 */
async function verifyWritten(
  ports: ConfigUpdatePorts,
  item: string,
  written: Record<string, unknown>,
  matches: (value: unknown) => boolean,
): Promise<boolean> {
  try {
    const read = await ports.readConfig();
    return (
      isRecord(read) &&
      matches(read[item]) &&
      withoutItem(read, item) === withoutItem(written, item)
    );
  } catch {
    return false;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** 2つの文字列の配列が、要素も順序も同じか。 */
function sameList(value: unknown, list: readonly string[]): boolean {
  return (
    isStringArray(value) &&
    value.length === list.length &&
    value.every((entry, index) => entry === list[index])
  );
}

/** 読み込み側の`isGitHubName`と同じ、GitHubのログイン名かリポジトリ名の形。 */
const GITHUB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isGitHubName(value: string): boolean {
  return value !== "." && value !== ".." && GITHUB_NAME_PATTERN.test(value);
}

/** 読み込み側の`parseGitHubRepoUrl`と同じ、`https://github.com/<owner>/<repo>`の形(`.git`と末尾のスラッシュは省略可)。 */
const GITHUB_REPO_URL_PATTERN =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/*$/i;

type RepoRef = { readonly owner: string; readonly repo: string };

/**
 * `repo_allowlist`に足せるURLを、ownerとrepoに分ける。形に合わなければ`undefined`。
 * userinfo、クエリ、フラグメント、`github.com`以外のホスト(`www.`を含む)、`http://`、sshは、形に合わない。
 * 前後の空白も受けない。
 */
function parseRepoUrl(value: string): RepoRef | undefined {
  const match = GITHUB_REPO_URL_PATTERN.exec(value);
  const owner = match?.[1];
  const repo = match?.[2];
  if (owner === undefined || repo === undefined) return undefined;
  return isGitHubName(owner) && isGitHubName(repo)
    ? { owner, repo }
    : undefined;
}

/** 読み込み側の`normalizeRepoUrl`と同じ正規化。末尾の`.git`とスラッシュを除き、小文字にする。 */
function normalizeRepoUrl(url: string): string {
  return url
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** 読み込み側の`dependabotOtherReposField`と同じ、`owner/repo`の形。 */
const STRICT_OWNER_SLASH_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function isOtherRepo(value: string): boolean {
  return (
    STRICT_OWNER_SLASH_REPO.test(value) &&
    !value.split("/").some((part) => part === "." || part === "..") &&
    !/\.git$/i.test(value)
  );
}

type CheckedElement =
  | {
      /** 書く値。`repo_allowlist`は`.git`と末尾のスラッシュを除いた形で、ほかは入力のまま。 */
      readonly kind: "valid";
      readonly value: string;
      /** `repo_allowlist`のとき、URLのowner。 */
      readonly owner: string | undefined;
    }
  | { readonly kind: "invalid" };

/**
 * 一覧`item`に足す要素の形を検査し、書く値を決める。
 * `repo_allowlist`は、読み込み側の照合(`normalizeRepoUrl`)と`parseGitHubRepoUrl`のどちらも通る
 * `https://github.com/<owner>/<repo>`の形で書く。ownerとrepoの大文字小文字は、入力のまま残す。
 * `default_reviewers`は、`[bot]`で終わる名前を、ログイン名の形に合わないものとして断る(`[`は形に含まれない)。
 */
function checkElement(item: string, element: string): CheckedElement {
  if (element.length === 0 || element.length > MAX_ELEMENT_LENGTH) {
    return { kind: "invalid" };
  }
  if (item === "repo_allowlist") {
    const ref = parseRepoUrl(element);
    return ref === undefined
      ? { kind: "invalid" }
      : {
          kind: "valid",
          value: `https://github.com/${ref.owner}/${ref.repo}`,
          owner: ref.owner,
        };
  }
  const valid =
    item === "dependabot_other_repos"
      ? isOtherRepo(element)
      : isGitHubName(element);
  return valid
    ? { kind: "valid", value: element, owner: undefined }
    : { kind: "invalid" };
}

/** 重複の照合に使う鍵。`repo_allowlist`は`normalizeRepoUrl`、ほかは小文字。 */
function duplicateKey(item: string, entry: string): string {
  return item === "repo_allowlist"
    ? normalizeRepoUrl(entry)
    : entry.toLowerCase();
}

type ListChange =
  | {
      readonly kind: "ok";
      readonly op: ListOperation;
      /** 追加では書く値、削除では除く要素。 */
      readonly element: string;
      /** 追加のとき、`repo_allowlist`のURLのowner。 */
      readonly owner: string | undefined;
      /** 削除のとき、`expected`の中で除く要素の位置。追加では`undefined`。 */
      readonly removedIndex: number | undefined;
      readonly beforeCount: number;
      readonly afterCount: number;
    }
  | { readonly kind: "refused"; readonly reason: ConfigUpdateRefusalReason };

/**
 * `next`が`expected`の末尾に1要素を足した形か、ちょうど1要素を除いた形かを調べ、動いた要素を返す。
 * どちらでもなければ`undefined`。
 */
function singleStep(
  expected: readonly string[],
  next: readonly string[],
):
  | { readonly op: "add"; readonly element: string }
  | {
      readonly op: "remove";
      readonly element: string;
      readonly index: number;
    }
  | undefined {
  if (next.length === expected.length + 1) {
    const element = next[expected.length];
    return element !== undefined &&
      expected.every((entry, index) => entry === next[index])
      ? { op: "add", element }
      : undefined;
  }
  if (next.length === expected.length - 1) {
    // 最初に食い違う位置が、除かれた要素の位置である。食い違いが無ければ末尾。
    let index = expected.findIndex((entry, i) => entry !== next[i]);
    if (index === -1) index = expected.length - 1;
    const element = expected[index];
    return element !== undefined &&
      expected.slice(index + 1).every((entry, i) => entry === next[index + i])
      ? { op: "remove", element, index }
      : undefined;
  }
  return undefined;
}

/**
 * 一覧の項目の変更を、`expected`と`next`の差分から判定する。外部を読まず、記録も書かない。
 * 配列でない、要素が文字列でない、差分が1要素の追加か削除でないときは`invalid_value`。
 * 追加する要素の形が合わなければ`invalid_element`、正規化した重複があれば`already_present`。
 * `repo_allowlist`の最後の1件を除く削除は`would_empty`。
 * `owners`との照合(`owner_not_listed`)は、読み直した生の値が要るので、ここではしない。
 */
export function checkListChange(
  item: string,
  expected: unknown,
  next: unknown,
): ListChange {
  if (!isStringArray(expected) || !isStringArray(next)) {
    return { kind: "refused", reason: "invalid_value" };
  }
  const step = singleStep(expected, next);
  if (step === undefined) return { kind: "refused", reason: "invalid_value" };
  if (step.op === "remove") {
    if (item === "repo_allowlist" && expected.length === 1) {
      return { kind: "refused", reason: "would_empty" };
    }
    return {
      kind: "ok",
      op: "remove",
      element: step.element,
      owner: undefined,
      removedIndex: step.index,
      beforeCount: expected.length,
      afterCount: next.length,
    };
  }
  const element = checkElement(item, step.element);
  if (element.kind === "invalid") {
    return { kind: "refused", reason: "invalid_element" };
  }
  const key = duplicateKey(item, element.value);
  if (expected.some((entry) => duplicateKey(item, entry) === key)) {
    return { kind: "refused", reason: "already_present" };
  }
  return {
    kind: "ok",
    op: "add",
    element: element.value,
    owner: element.owner,
    removedIndex: undefined,
    beforeCount: expected.length,
    afterCount: next.length,
  };
}

/** 生の`owners`の`name`のどれかが、`owner`と大文字小文字を除いて一致するか。読めない`owners`は一致しない。 */
function ownerIsListed(
  current: Record<string, unknown>,
  owner: string,
): boolean {
  const owners = current.owners;
  if (!Array.isArray(owners)) return false;
  return owners.some(
    (entry) =>
      isRecord(entry) &&
      typeof entry.name === "string" &&
      entry.name.toLowerCase() === owner.toLowerCase(),
  );
}

/**
 * 書く直前に読み直した設定に対する、1つの変更の計画。
 * 真偽・数値と一覧で、記録に残す内容、読み直しの比較、書く値だけが違う。
 */
type Plan = {
  /** 操作の記録の`attempted`の行に入れる内容。 */
  readonly changes: Record<string, unknown>;
  /** 読み直した設定から、書く項目の値か、断る理由を返す。比較交換と、項目ごとの追加の検査を含む。 */
  readonly prepare: (
    current: Record<string, unknown>,
  ) =>
    | { readonly kind: "write"; readonly value: unknown }
    | { readonly kind: "refused"; readonly reason: ConfigUpdateRefusalReason };
  /** 書いた後に読み直した、対象の項目の値が、書いた値と同じか。 */
  readonly matches: (value: unknown) => boolean;
  readonly succeeded: (
    verified: boolean,
    audit: ActionAudit,
  ) => ConfigUpdateResult;
};

function scalarPlan(
  item: string,
  before: number | boolean,
  after: number | boolean,
): Plan {
  return {
    changes: { item, before, after },
    prepare: (current) => {
      if (current[item] !== before) return refusedStep("conflict");
      if (holdsReference(current)) return refusedStep("has_reference");
      return { kind: "write", value: after };
    },
    matches: (value) => value === after,
    succeeded: (verified, audit) => ({
      refused: false,
      item,
      before,
      after,
      verified,
      action_audit: audit,
    }),
  };
}

function refusedStep(reason: ConfigUpdateRefusalReason) {
  return { kind: "refused", reason } as const;
}

/** 読み取りの後に断ったときの記録。結果は`failed`で、理由を残す。 */
function failedWith(
  reason: ConfigUpdateRefusalReason,
): RecordedOperation<WriteStep> {
  return {
    outcome: "failed",
    changes: { refusal: reason },
    value: { kind: "refused", reason },
  };
}

function listPlan(
  item: string,
  expected: readonly string[],
  change: Extract<ListChange, { kind: "ok" }>,
): Plan {
  const { op, element, owner, removedIndex, beforeCount, afterCount } = change;
  let written: readonly string[] = [];
  return {
    changes: {
      item,
      op,
      element,
      before_count: beforeCount,
      after_count: afterCount,
    },
    prepare: (current) => {
      const list = current[item];
      if (!isStringArray(list) || !sameList(list, expected)) {
        return refusedStep("conflict");
      }
      if (holdsReference(current)) return refusedStep("has_reference");
      if (owner !== undefined && !ownerIsListed(current, owner)) {
        return refusedStep("owner_not_listed");
      }
      written =
        op === "add"
          ? [...list, element]
          : list.filter((_entry, index) => index !== removedIndex);
      return { kind: "write", value: written };
    },
    matches: (value) => sameList(value, written),
    succeeded: (verified, audit) => ({
      refused: false,
      item,
      op,
      element,
      before_count: beforeCount,
      after_count: afterCount,
      verified,
      action_audit: audit,
    }),
  };
}

/**
 * 項目`item`を、読んだ時の値`expected`から`next`へ変更する。
 * 呼び出しの順序は、許可表の判定、操作者の導出、記録(`attempted`)、読み取り、書き込み、読み直し、記録(結果)に固定する。
 * 項目が文字列でないときは、許可表の外として断る。文字列でない値を、プロパティ名に使わないためである。
 * 読み取りの後の判定(読んだ時の値と違う、参照を含む、一覧の追加の検査)で断ったときも、記録は`failed`で残す。
 * 読み取りと書き込みの失敗は、記録を`failed`にしてから投げる。
 */
export async function updateConfigFromConsole(
  item: unknown,
  expected: unknown,
  next: unknown,
  ports: ConfigUpdatePorts,
): Promise<ConfigUpdateResult> {
  if (typeof item !== "string") {
    return { refused: true, reason: "item_not_allowed" };
  }
  let plan: Plan;
  if (LIST_ITEMS.includes(item)) {
    const change = checkListChange(item, expected, next);
    if (change.kind === "refused") {
      return { refused: true, reason: change.reason };
    }
    // `checkListChange`が通ったので、`expected`は文字列の配列である。
    plan = listPlan(item, isStringArray(expected) ? expected : [], change);
  } else {
    const change = checkChange(item, expected, next);
    if (change.kind === "refused") {
      return { refused: true, reason: change.reason };
    }
    plan = scalarPlan(item, change.before, change.after);
  }
  let actor: string;
  try {
    actor = ports.deriveActor();
  } catch {
    return { refused: true, reason: "actor_unknown" };
  }

  const recorded = await runRecordedAs(
    () => actor,
    { action: "config_update", target: CONFIG_TARGET, changes: plan.changes },
    async (): Promise<RecordedOperation<WriteStep>> => {
      const current = await ports.readConfig();
      if (!isRecord(current)) return failedWith("conflict");
      const prepared = plan.prepare(current);
      if (prepared.kind === "refused") return failedWith(prepared.reason);
      const written = { ...current, [item]: prepared.value };
      await ports.writeConfig(written);
      const verified = await verifyWritten(ports, item, written, plan.matches);
      return {
        outcome: verified ? "succeeded" : "partial",
        changes: { verified },
        value: { kind: "written", verified },
      };
    },
    { sql: ports.sql, onUnrecordable: "refuse" },
  );
  if (!recorded.ok) {
    return { refused: true, reason: "audit_unavailable" };
  }
  if (recorded.value.kind === "refused") {
    return { refused: true, reason: recorded.value.reason };
  }
  return plan.succeeded(recorded.value.verified, recorded.audit);
}

function sdkPorts(): ConfigUpdatePorts {
  const workspace = wmillDefault.getWorkspace();
  return {
    deriveActor: () =>
      deriveApprover({
        WM_USERNAME: process.env.WM_USERNAME,
        WM_EMAIL: process.env.WM_EMAIL,
      }),
    readConfig: () =>
      wmill.ResourceService.getResourceValue({
        workspace,
        path: "f/factory/factory_config",
      }),
    writeConfig: async (value) => {
      await wmill.ResourceService.updateResourceValue({
        workspace,
        path: "f/factory/factory_config",
        requestBody: { value },
      });
    },
    sql: actionSqlClientFrom(() => wmill.datatable()),
  };
}

/**
 * Consoleから、factory_configの項目を1つ変更する。
 * 真偽は止める向き、数値は下げる向き、一覧の3項目は1要素の追加か削除だけである。
 * 操作者はジョブの実行文脈から導く。
 */
export async function main(
  item: string,
  expected: unknown,
  next: unknown,
): Promise<ConfigUpdateResult> {
  return await updateConfigFromConsole(item, expected, next, sdkPorts());
}
