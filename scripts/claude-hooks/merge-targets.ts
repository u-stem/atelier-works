// マージと反映の操作を、コマンド行の字面から見つける。
// 保留(hold)と凍結(freeze)が止める操作を、実行する前に見分けるための判定である。
// 読むのはコマンドの語だけで、DBにも変数にも触れない。
//
// 見つける形:
// - マージ: `gh pr merge`(`--auto`、`--admin`を含む)、`gh api`のPUTでパスが`/pulls/`と`merge`を含むもの、
//   `gh api graphql`のうち`mergePullRequest`、`enablePullRequestAutoMerge`、`enqueuePullRequest`を含むか、
//   query が実行時に決まる、ファイルから読む、`--input`で渡すもの、語に`merge`を含む`gh alias set|import`。
//   `gh pr merge --disable-auto`と`--help`は対象にしない。
// - 反映: `--dry-run`の無い`wmill sync push`、`wmill datatable migrate up|down`。
//   `--dry-run=...`の形は`--dry-run`として扱わず、対象にする。
//
// 対象のリポジトリは、`--repo`、`-R`、`GH_REPO`の前置き、PRのURL、`gh api`のパスをすべて集めて決める。
// 値が食い違う、`owner/repo`の形に合わない、実行時に決まるときは、決まらない(null)として返す。
// 決まらないマージは、呼び出し側がどのリポジトリの保留でも止める。
//
// 前置き(`env`、`timeout`、`xargs`、`mise exec --`、絶対パス)と、`sh -c`、`eval`、`$(...)`は、
// `shell-words.ts`が外す。標準入力でシェルに渡す文字列は、深さ4まで読み直す。
// 字句に分けられないコマンド行は、何も返さない。bash-guardが拒否するので、二重にしない。
// 実行する名前が実行時に決まる語(`"$GH" pr merge 1`)は、文字どおりの`merge`があればマージとして扱う。
//
// ベストエフォートの判定で、境界ではない。次は追わない。
// 別名や関数、変数や連結で組んだ語、スクリプトのファイルの中の呼び出し、`curl`や`python`、`hub`、
// GitHubのMCP、REST の`repos/<owner>/<repo>/merges`、GraphQL の`mergeBranch`、
// `bunx wmill`と`npx wmill`、`wmill script push`などの個別のpush、`wmill schedule enable`。

import { shellInputSource } from "./env-exposure.ts";
import {
  baseName,
  literalShellInputs,
  parseCommandLine,
  type SimpleCommand,
  shellArguments,
  stripWrappers,
  type Word,
} from "./shell-words.ts";

export type GuardedOperation =
  | {
      readonly kind: "merge";
      /** 小文字の`owner/repo`。決まらなければnull。 */
      readonly repo: string | null;
    }
  | { readonly kind: "deploy"; readonly via: "sync_push" | "migrate" };

const MERGE_ANY: GuardedOperation = { kind: "merge", repo: null };

/** 標準入力でシェルに渡る文字列を読み直す深さの上限。bash-guardの上限と同じにする。 */
const MAX_INPUT_DEPTH = 4;

const NAME = /^[a-z0-9._-]+$/;

/** GraphQLの、マージを要求するmutation。 */
const MERGE_MUTATIONS =
  /mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest/;

/** `gh pr merge`の、値を取るオプション。 */
const PR_MERGE_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-b",
  "--body",
  "-F",
  "--body-file",
  "-t",
  "--subject",
  "-A",
  "--author-email",
  "--match-head-commit",
]);

/** `gh api`の、値を取るオプション。 */
const API_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-X",
  "--method",
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "-H",
  "--header",
  "--input",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--hostname",
  "--cache",
  "-p",
  "--preview",
]);

/** `gh api`の、値を取る短いオプションの文字。`-XPUT`のように値が続きに付く。 */
const API_SHORT_VALUE_LETTERS = "XfFHqtp";

/** `wmill`の、サブコマンドの前後に置ける、値を取るグローバルオプション。 */
const WMILL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--workspace",
  "--token",
  "--base-url",
  "--config-dir",
]);

type Value = { readonly text: string; readonly dynamic: boolean };

/**
 * `owner/repo`、`HOST/owner/repo`の値を、小文字の`owner/repo`にする。
 * `.git`の接尾辞は落とす。合わない値と実行時に決まる値はnullにする。
 */
function normalizeRepo(value: Value): string | null {
  if (value.dynamic) return null;
  const parts = value.text.split("/");
  if (parts.length < 2 || parts.length > 3) return null;
  const owner = (parts.at(-2) ?? "").toLowerCase();
  const repo = (parts.at(-1) ?? "").toLowerCase().replace(/\.git$/, "");
  if (!NAME.test(owner) || !NAME.test(repo)) return null;
  if (owner === "." || owner === ".." || repo === "." || repo === "..") {
    return null;
  }
  return `${owner}/${repo}`;
}

/** 集めた候補が1つに決まればその値を、候補が無いか食い違うか決まらないものがあればnullを返す。 */
function resolveRepo(candidates: readonly (string | null)[]): string | null {
  const first = candidates[0];
  if (first === undefined || first === null) return null;
  return candidates.every((candidate) => candidate === first) ? first : null;
}

function isFlag(text: string): boolean {
  return text.startsWith("-") && text !== "-";
}

/** 語がPRのURL(`https://<host>/<owner>/<repo>/pull/<n>`)全体なら、リポジトリの候補にする。 */
function repoOfPullUrl(word: Word): string | null | undefined {
  const match =
    /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/\d+(?:[/?#].*)?$/i.exec(
      word.text,
    );
  if (match === null) return undefined;
  return normalizeRepo({
    text: `${match[1] ?? ""}/${match[2] ?? ""}`,
    dynamic: word.dynamic,
  });
}

/**
 * `-R <値>`、`--repo <値>`、`--repo=<値>`、`-R<値>`、`-R=<値>`の、値の語を返す。
 * 該当しなければnull。`skip`は、値の語まで読み飛ばす数。
 */
function repoOption(
  words: readonly Word[],
  index: number,
): { readonly value: Value; readonly skip: number } | null {
  const word = words[index];
  if (word === undefined) return null;
  const text = word.text;
  if (text === "-R" || text === "--repo") {
    const next = words[index + 1];
    return {
      value: next ?? { text: "", dynamic: false },
      skip: next === undefined ? 0 : 1,
    };
  }
  if (text.startsWith("--repo=")) {
    return {
      value: { text: text.slice("--repo=".length), dynamic: word.dynamic },
      skip: 0,
    };
  }
  if (text.startsWith("-R") && !text.startsWith("--")) {
    return {
      value: {
        text: text.slice(2).replace(/^=/, ""),
        dynamic: word.dynamic,
      },
      skip: 0,
    };
  }
  return null;
}

/** `gh pr`の、`merge`より前のオプションを読む。`merge`の位置と、そこまでのリポジトリの候補を返す。 */
function readPrPrefix(args: readonly Word[]): {
  readonly mergeAt: number;
  readonly candidates: (string | null)[];
} | null {
  const candidates: (string | null)[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (word === undefined) break;
    const option = repoOption(args, index);
    if (option !== null) {
      candidates.push(normalizeRepo(option.value));
      index += option.skip;
      continue;
    }
    if (isFlag(word.text)) continue;
    return word.text === "merge" && !word.dynamic
      ? { mergeAt: index, candidates }
      : null;
  }
  return null;
}

/** `gh pr merge`の引数から、マージとして扱う対象を返す。マージの要求でなければnullを返す。 */
function ghPrMerge(
  args: readonly Word[],
  environment: string | null | undefined,
): GuardedOperation | null {
  const prefix = readPrPrefix(args);
  if (prefix === null) return null;
  const rest = args.slice(prefix.mergeAt + 1);
  const texts = rest.map((word) => word.text);
  if (texts.includes("--help") || texts.includes("-h")) return null;
  if (texts.includes("--disable-auto") && !texts.includes("--auto")) {
    return null;
  }
  const candidates = [...prefix.candidates];
  if (environment !== undefined) candidates.push(environment);
  let literalOnly = false;
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index];
    if (word === undefined) break;
    if (word.text === "--") literalOnly = true;
    const option = literalOnly ? null : repoOption(rest, index);
    if (option !== null) {
      candidates.push(normalizeRepo(option.value));
      index += option.skip;
      continue;
    }
    if (!literalOnly && isFlag(word.text)) {
      if (PR_MERGE_VALUE_FLAGS.has(word.text)) index += 1;
      continue;
    }
    if (word.text === "--") continue;
    // 位置引数は、PRの番号、ブランチ、URLのどれか。実行時に決まる語はURLかもしれない。
    if (word.dynamic) {
      candidates.push(null);
      continue;
    }
    const fromUrl = repoOfPullUrl(word);
    if (fromUrl !== undefined) candidates.push(fromUrl);
  }
  return { kind: "merge", repo: resolveRepo(candidates) };
}

type ApiRequest = {
  readonly method: Value | null;
  readonly endpoint: Word | null;
  readonly fields: readonly Value[];
  readonly hasInput: boolean;
};

/** `gh api`の引数を、メソッド、エンドポイント、フィールド、`--input`の有無に分ける。 */
function readApiRequest(args: readonly Word[]): ApiRequest {
  let method: Value | null = null;
  let endpoint: Word | null = null;
  const fields: Value[] = [];
  let hasInput = false;
  const take = (flag: string, value: Value): void => {
    if (flag === "-X" || flag === "--method") method = value;
    else if (
      flag === "-f" ||
      flag === "--raw-field" ||
      flag === "-F" ||
      flag === "--field"
    ) {
      fields.push(value);
    } else if (flag === "--input") {
      hasInput = true;
    }
  };
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (word === undefined) break;
    const text = word.text;
    if (API_VALUE_FLAGS.has(text)) {
      const next = args[index + 1];
      if (next !== undefined) take(text, next);
      index += 1;
      continue;
    }
    const long = /^(--[a-z-]+)=([\s\S]*)$/.exec(text);
    if (long !== null && API_VALUE_FLAGS.has(long[1] ?? "")) {
      take(long[1] ?? "", { text: long[2] ?? "", dynamic: word.dynamic });
      continue;
    }
    if (
      text.length > 2 &&
      text.startsWith("-") &&
      !text.startsWith("--") &&
      API_SHORT_VALUE_LETTERS.includes(text.charAt(1))
    ) {
      take(text.slice(0, 2), { text: text.slice(2), dynamic: word.dynamic });
      continue;
    }
    if (isFlag(text)) continue;
    endpoint ??= word;
  }
  return { method, endpoint, fields, hasInput };
}

/** GraphQLの呼び出しが、マージを要求する(または、要求でないと言い切れない)なら真。 */
function graphqlMayMerge(request: ApiRequest): boolean {
  if (request.hasInput) return true;
  return request.fields.some((field) => {
    const at = field.text.indexOf("=");
    const key = at === -1 ? field.text : field.text.slice(0, at);
    const value = at === -1 ? "" : field.text.slice(at + 1);
    if (MERGE_MUTATIONS.test(field.text)) return true;
    if (field.dynamic) {
      return at === -1 || key === "query" || /[$`]/.test(key);
    }
    return key === "query" && value.startsWith("@");
  });
}

/** `gh api`の引数から、マージとして扱う対象を返す。マージの要求でなければnullを返す。 */
function ghApi(args: readonly Word[]): GuardedOperation | null {
  const request = readApiRequest(args);
  const endpoint = request.endpoint;
  if (endpoint === null) return null;
  if (!endpoint.dynamic && endpoint.text === "graphql") {
    return graphqlMayMerge(request) ? MERGE_ANY : null;
  }
  const method = request.method;
  const writes =
    method !== null && (method.dynamic || method.text.toUpperCase() === "PUT");
  if (!writes) return null;
  const lower = endpoint.text.toLowerCase();
  const isMergePath = lower.includes("/pulls/") && lower.includes("merge");
  if (!isMergePath && !endpoint.dynamic) return null;
  const path = endpoint.text.replace(/^https?:\/\/[^/]+\//i, "");
  const match = /(?:^|\/)repos\/([^/]+)\/([^/?#]+)/i.exec(path);
  const repo =
    match === null
      ? null
      : normalizeRepo({
          text: `${match[1] ?? ""}/${match[2] ?? ""}`,
          dynamic: false,
        });
  return { kind: "merge", repo };
}

/** `gh alias set|import`が、語に`merge`を含むなら、マージを別名に隠す形として扱う。 */
function ghAlias(args: readonly Word[]): GuardedOperation | null {
  const [subcommand, ...rest] = args.filter((word) => !isFlag(word.text));
  if (subcommand?.text !== "set" && subcommand?.text !== "import") return null;
  return rest.some((word) => word.text.toLowerCase().includes("merge"))
    ? MERGE_ANY
    : null;
}

function ghOperation(
  args: readonly Word[],
  environment: string | null | undefined,
): GuardedOperation | null {
  const groupAt = args.findIndex((word) => !isFlag(word.text));
  const group = args[groupAt];
  if (group === undefined) return null;
  const rest = args.slice(groupAt + 1);
  switch (group.text) {
    case "pr":
      return ghPrMerge(rest, environment);
    case "api":
      return ghApi(rest);
    case "alias":
      return ghAlias(rest);
    default:
      return null;
  }
}

/** `wmill`の引数から、反映の操作を返す。 */
function wmillOperation(args: readonly Word[]): GuardedOperation | null {
  const positionals: string[] = [];
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index]?.text ?? "";
    if (WMILL_VALUE_OPTIONS.has(text)) {
      index += 1;
    } else if (text === "--dry-run") {
      dryRun = true;
    } else if (!isFlag(text)) {
      positionals.push(text);
    }
  }
  const [first, second, third] = positionals;
  if (first === "sync" && second === "push") {
    return dryRun ? null : { kind: "deploy", via: "sync_push" };
  }
  if (
    first === "datatable" &&
    second === "migrate" &&
    (third === "up" || third === "down")
  ) {
    return { kind: "deploy", via: "migrate" };
  }
  return null;
}

/** 実行する名前が実行時に決まるコマンドの、文字どおりの語から、マージとして扱うか決める。 */
function dynamicProgramOperation(
  args: readonly Word[],
): GuardedOperation | null {
  const literal = args.filter((word) => !word.dynamic);
  return literal.some(
    (word) => word.text === "merge" || MERGE_MUTATIONS.test(word.text),
  )
    ? MERGE_ANY
    : null;
}

/** 前置きの`GH_REPO=...`の代入から、リポジトリの候補を返す。代入が無ければundefinedを返す。 */
function repoFromEnvironment(
  assignments: readonly Word[],
): string | null | undefined {
  let found: string | null | undefined;
  for (const word of assignments) {
    if (!word.text.startsWith("GH_REPO=")) continue;
    found = normalizeRepo({
      text: word.text.slice("GH_REPO=".length),
      dynamic: word.dynamic,
    });
  }
  return found;
}

function commandOperation(command: SimpleCommand): GuardedOperation | null {
  const { assignments, words } = stripWrappers(command.words);
  const first = words[0];
  if (first === undefined) return null;
  if (first.dynamic) return dynamicProgramOperation(words.slice(1));
  switch (baseName(first.text)) {
    case "gh":
      return ghOperation(words.slice(1), repoFromEnvironment(assignments));
    case "wmill":
      return wmillOperation(words.slice(1));
    default:
      return null;
  }
}

function scan(line: string, depth: number): GuardedOperation[] {
  const parsed = parseCommandLine(line);
  if (!parsed.ok) return [];
  const found: GuardedOperation[] = [];
  for (const command of parsed.commands) {
    const operation = commandOperation(command);
    if (operation !== null) found.push(operation);
    if (depth >= MAX_INPUT_DEPTH) continue;
    const { words } = stripWrappers(command.words);
    const shellArgs = shellArguments(words);
    if (shellArgs === null || shellInputSource(shellArgs) !== "stdin") continue;
    for (const source of literalShellInputs(command) ?? []) {
      found.push(...scan(source, depth + 1));
    }
  }
  return found;
}

/**
 * コマンド行に含まれる、マージと反映の操作を、現れる順に返す。
 * 字句に分けられない行は、何も返さない。
 */
export function findGuardedOperations(
  command: string,
): readonly GuardedOperation[] {
  return scan(command, 0);
}
