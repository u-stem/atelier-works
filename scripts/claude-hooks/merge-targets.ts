// マージと反映の操作を、コマンド行の字面から見つける。
// 保留(hold)と凍結(freeze)が止める操作を、実行する前に見分けるための判定である。
// 読むのはコマンドの語だけで、DBにも変数にも触れない。
//
// `gh`の判定は、安全と確認できる形だけを対象外にし、それ以外はマージとして扱う。
// 綴りを列挙してマージを見つける方式は、列挙に無い綴りで破られるためである。
// マージとして扱うと、保留が有効なときか保留を読めないときだけ、通常の作業を止める。
// - `gh pr`: サブコマンドが文字どおり読み取りか編集の語(`view`、`list`、`create`など)のときだけ対象外にする。
//   `merge`のうち`--disable-auto`(`--auto`が無いとき)と`--help`だけを対象外にする。
//   これらは、値を取るオプションの値を読み飛ばした後で判定する。
// - `gh api`: メソッドが文字どおりのGETか指定が無く、本文もフィールドも`--input`も無く、
//   エンドポイントが`graphql`でも`merge`を含むものでもないときだけ対象外にする。
//   GraphQLは、queryが文字どおりで、マージを要求する3つのmutationを含まないと確かめられたときだけ対象外にする。
// - `gh alias set|import`で語に`merge`を含むもの。
// - 反映: `--dry-run`の無い`wmill sync push`、`wmill datatable migrate up|down`。
//   `--dry-run`は、値を取るオプションの値を読み飛ばした後で見る。`--dry-run=...`の形は対象にする。
// `xargs`の後ろの`gh pr|api|alias`と`wmill`は、引数を標準入力から受けるので、常に対象にする。
//
// 対象のリポジトリは、`--repo`、`-R`、`GH_REPO`の前置き、PRのURL、`gh api`のパスをすべて集めて決める。
// 値が食い違う、`owner/repo`の形に合わない、実行時に決まるときは、決まらない(null)として返す。
// 決まらないマージは、呼び出し側がどのリポジトリの保留でも止める。
//
// 短いオプションは、pflagと同じに読む。束ねた文字を1つずつ見て、値を取る文字に当たったら、
// 後ろの文字(先頭の`=`は落とす)を値にし、後ろが空なら次の語を値にする。
// 前置き(`env`、`env -S`、`timeout`、`xargs`、`mise exec --`、絶対パス)と、`sh -c`、`eval`、`$(...)`は、
// `shell-words.ts`が外す。標準入力でシェルに渡す文字列は、深さ4まで読み直す。
// 字句に分けられないコマンド行は、何も返さない。bash-guardが拒否するので、二重にしない。
// 実行する名前や、`gh`のグループとサブコマンドが実行時に決まる語は、マージとして扱う。
//
// ベストエフォートの判定で、境界ではない。次は追わない。
// 別名や関数、変数や連結で組んだ語、スクリプトのファイルの中の呼び出し、`curl`や`python`、`hub`、
// GitHubのMCP、GraphQLの`mergeBranch`、`find -exec`と`parallel`と`watch`の後ろのコマンド、
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
const SYNC_PUSH: GuardedOperation = { kind: "deploy", via: "sync_push" };
const MIGRATE: GuardedOperation = { kind: "deploy", via: "migrate" };

/** `env -S`の文字列を読めないとき、実行されるコマンドが分からないので、すべての操作として扱う。 */
const EVERY_OPERATION: readonly GuardedOperation[] = [
  MERGE_ANY,
  SYNC_PUSH,
  MIGRATE,
];

/** 標準入力でシェルに渡る文字列を読み直す深さの上限。bash-guardの上限と同じにする。 */
const MAX_INPUT_DEPTH = 4;

const NAME = /^[a-z0-9._-]+$/;

/** GraphQLの、マージを要求するmutation。 */
const MERGE_MUTATIONS =
  /mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest/;

/** GraphQLの書き込み。`mergeBranch`や`updateRef`も覆うため、mutationの語を含むものはすべて対象にする。 */
const MUTATION_KEYWORD = /mutation/i;

/** マージを要求しないと分かっている`gh pr`のサブコマンド。 */
const SAFE_PR_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "view",
  "list",
  "checks",
  "create",
  "diff",
  "comment",
  "status",
  "edit",
  "ready",
  "review",
  "checkout",
  "reopen",
  "close",
  "lock",
  "unlock",
  "co",
  "ls",
  "new",
]);

/** オプションの読み方。値を取る短い文字と、値を取る長い名前。 */
type OptionSpec = {
  readonly shortValue: string;
  readonly longValue: ReadonlySet<string>;
};

/** `gh pr`のオプション。`merge`の本文や件名の値も、ほかのサブコマンドの値も含める。 */
const PR_OPTIONS: OptionSpec = {
  shortValue: "RbFtA",
  longValue: new Set([
    "--repo",
    "--body",
    "--body-file",
    "--subject",
    "--author-email",
    "--match-head-commit",
  ]),
};

/** `gh api`のオプション。 */
const API_OPTIONS: OptionSpec = {
  shortValue: "XfFHqtp",
  longValue: new Set([
    "--method",
    "--field",
    "--raw-field",
    "--header",
    "--input",
    "--jq",
    "--template",
    "--preview",
    "--cache",
    "--hostname",
  ]),
};

/** `wmill`のオプション。サブコマンドの前後のどこにも置ける。 */
const WMILL_OPTIONS: OptionSpec = {
  shortValue: "ie",
  longValue: new Set([
    "--workspace",
    "--token",
    "--base-url",
    "--config-dir",
    "--includes",
    "--excludes",
    "--extra-includes",
    "--message",
    "--parallel",
    "--repository",
    "--branch",
    "--env",
    "--datatable",
  ]),
};

type Value = { readonly text: string; readonly dynamic: boolean };

/** 読んだオプション。`name`は`-R`や`--repo`の形で、`value`は値(値を取らなければnull)である。 */
type ParsedOption = {
  readonly name: string;
  readonly value: Value | null;
  /** オプションが始まる語の位置。 */
  readonly at: number;
};

type ParsedArgs = {
  readonly options: readonly ParsedOption[];
  readonly positionals: readonly Word[];
};

/**
 * 引数をオプションと位置引数に分ける。
 * 長いオプションは、名前が`longValue`にあれば次の語を値にし、`--name=値`の形は値をその場で読む。
 * 短いオプションは、束ねた文字を1つずつ見て、値を取る文字に当たった位置から後ろを値にする。
 * `--`より後ろは位置引数である。値を取るオプションの値は、`-`で始まる語でも値として読む。
 */
function parseArgs(args: readonly Word[], spec: OptionSpec): ParsedArgs {
  const options: ParsedOption[] = [];
  const positionals: Word[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (word === undefined) break;
    const text = word.text;
    if (text === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (text.startsWith("--")) {
      const equals = text.indexOf("=");
      if (equals !== -1) {
        options.push({
          name: text.slice(0, equals),
          value: { text: text.slice(equals + 1), dynamic: word.dynamic },
          at: index,
        });
      } else if (spec.longValue.has(text)) {
        const next = args[index + 1];
        options.push({ name: text, value: next ?? null, at: index });
        index += 1;
      } else {
        options.push({ name: text, value: null, at: index });
      }
      continue;
    }
    if (text.startsWith("-") && text !== "-") {
      for (let at = 1; at < text.length; at += 1) {
        const letter = text.charAt(at);
        const name = `-${letter}`;
        const isValue = spec.shortValue.includes(letter);
        const afterLetter = text.slice(at + 1);
        if (!isValue) {
          // 真偽値のオプションにも`=値`を付けられる(`-h=false`)。値付きは値を持たない形と区別する。
          if (afterLetter.startsWith("=")) {
            options.push({
              name,
              value: { text: afterLetter.slice(1), dynamic: word.dynamic },
              at: index,
            });
            break;
          }
          options.push({ name, value: null, at: index });
          continue;
        }
        const rest = afterLetter.replace(/^=/, "");
        if (rest !== "") {
          options.push({
            name,
            value: { text: rest, dynamic: word.dynamic },
            at: index,
          });
        } else {
          const next = args[index + 1];
          options.push({ name, value: next ?? null, at: index });
          index += 1;
        }
        break;
      }
      continue;
    }
    positionals.push(word);
  }
  return { options, positionals };
}

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

/** `-R`と`--repo`の値から、リポジトリの候補を作る。値が無いときは決まらない候補にする。 */
function repoCandidates(options: readonly ParsedOption[]): (string | null)[] {
  return options
    .filter((option) => option.name === "-R" || option.name === "--repo")
    .map((option) =>
      option.value === null ? null : normalizeRepo(option.value),
    );
}

/** 値を持たない形のオプションがあれば真。`--help=false`のような値付きの形は、有効にするとは限らないので数えない。 */
function hasOption(
  options: readonly ParsedOption[],
  ...names: readonly string[]
): boolean {
  return options.some(
    (option) => names.includes(option.name) && option.value === null,
  );
}

/** `gh pr`の引数から、マージとして扱う対象を返す。安全と確かめられたらnullを返す。 */
function ghPr(
  args: readonly Word[],
  environment: string | null | undefined,
): GuardedOperation | null {
  const { options, positionals } = parseArgs(args, PR_OPTIONS);
  const [subcommand, ...selectors] = positionals;
  if (subcommand === undefined) return null;
  // サブコマンドの前に、`-R`と`--repo`と`--help`以外のオプションがあると、cobraは値を取るものとして読みうる。
  const subcommandAt = args.indexOf(subcommand);
  const allowedBefore = ["-R", "--repo", "-h", "--help"];
  if (
    options.some(
      (option) =>
        option.at < subcommandAt && !allowedBefore.includes(option.name),
    )
  ) {
    return MERGE_ANY;
  }
  if (subcommand.dynamic) return MERGE_ANY;
  if (SAFE_PR_SUBCOMMANDS.has(subcommand.text)) return null;
  if (subcommand.text !== "merge") return MERGE_ANY;
  if (hasOption(options, "--help", "-h")) return null;
  if (hasOption(options, "--disable-auto") && !hasOption(options, "--auto")) {
    return null;
  }
  const candidates = repoCandidates(options);
  if (environment !== undefined) candidates.push(environment);
  for (const selector of selectors) {
    // 位置引数は、PRの番号、ブランチ、URLのどれか。実行時に決まる語はURLかもしれない。
    if (selector.dynamic) {
      candidates.push(null);
      continue;
    }
    const fromUrl = repoOfPullUrl(selector);
    if (fromUrl !== undefined) candidates.push(fromUrl);
  }
  return { kind: "merge", repo: resolveRepo(candidates) };
}

/**
 * `gh api`のエンドポイントを、スキームとホスト、先頭と末尾の`/`、クエリ、GHESの`api/v3/`を外した形にする。
 */
function normalizeEndpoint(text: string): string {
  return text
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/[?#].*$/, "")
    .replace(/^\/+/, "")
    .replace(/^api\/v3\//i, "")
    .replace(/\/+$/, "");
}

/** GraphQLの呼び出しが、マージを要求する(または、要求でないと言い切れない)なら真。 */
function graphqlMayMerge(fields: readonly Value[], hasInput: boolean): boolean {
  if (hasInput) return true;
  let queryFound = false;
  for (const field of fields) {
    const at = field.text.indexOf("=");
    const key = at === -1 ? field.text : field.text.slice(0, at);
    const value = at === -1 ? "" : field.text.slice(at + 1);
    if (MERGE_MUTATIONS.test(field.text) || MUTATION_KEYWORD.test(field.text)) {
      return true;
    }
    if (field.dynamic && (at === -1 || key === "query" || /[$`]/.test(key))) {
      return true;
    }
    if (key === "query") {
      queryFound = true;
      if (value.startsWith("@")) return true;
    }
  }
  return !queryFound;
}

/** `gh api`の引数から、マージとして扱う対象を返す。安全と確かめられたらnullを返す。 */
function ghApi(args: readonly Word[]): GuardedOperation | null {
  const { options, positionals } = parseArgs(args, API_OPTIONS);
  const endpoint = positionals[0];
  if (endpoint === undefined) return null;
  const methods = options.filter(
    (option) => option.name === "-X" || option.name === "--method",
  );
  const method = methods.at(-1)?.value ?? null;
  const fields = options.flatMap((option) =>
    ["-f", "-F", "--field", "--raw-field"].includes(option.name) &&
    option.value !== null
      ? [option.value]
      : [],
  );
  const hasInput = options.some((option) => option.name === "--input");
  const path = normalizeEndpoint(endpoint.text);
  if (!endpoint.dynamic && path.toLowerCase() === "graphql") {
    return graphqlMayMerge(fields, hasInput) ? MERGE_ANY : null;
  }
  const explicitGet =
    method !== null && !method.dynamic && method.text.toUpperCase() === "GET";
  const reads = method === null || explicitGet;
  // 指定の無いメソッドは、フィールドを渡すとPOSTになる。明示したGETのフィールドは検索条件である。
  const hasBody = hasInput || (fields.length > 0 && !explicitGet);
  // GETではPRをマージできないので、パスに`merge`を含んでも対象外にする。
  if (reads && !hasBody) return null;
  const segments = path.split("/");
  const match = /^repos\/([^/]+)\/([^/]+)(?:\/|$)/i.exec(path);
  const repo =
    endpoint.dynamic || segments.includes("..") || match === null
      ? null
      : normalizeRepo({
          text: `${match[1] ?? ""}/${match[2] ?? ""}`,
          dynamic: false,
        });
  return { kind: "merge", repo };
}

/** `gh alias set|import`が、語に`merge`を含むなら、マージを別名に隠す形として扱う。 */
function ghAlias(args: readonly Word[]): GuardedOperation | null {
  const [subcommand, ...rest] = args.filter(
    (word) => !word.text.startsWith("-"),
  );
  if (subcommand?.text !== "set" && subcommand?.text !== "import") return null;
  return rest.some((word) => word.text.toLowerCase().includes("merge"))
    ? MERGE_ANY
    : null;
}

/**
 * `gh`の引数から、マージとして扱う対象を返す。
 * `viaXargs`が真なら、引数を標準入力から受けるので、`pr`と`api`と`alias`を常にマージとして扱う。
 */
function ghOperation(
  args: readonly Word[],
  environment: string | null | undefined,
  viaXargs: boolean,
): GuardedOperation | null {
  const groupAt = args.findIndex((word) => !word.text.startsWith("-"));
  const group = args[groupAt];
  if (group === undefined) return null;
  // グループの前に`--help`と`--version`以外のオプションがあると、cobraは値を取るものとして読みうる。
  const before = args.slice(0, groupAt);
  if (
    before.some((word) => !["--help", "--version", "-h"].includes(word.text))
  ) {
    return MERGE_ANY;
  }
  if (group.dynamic) return MERGE_ANY;
  const rest = args.slice(groupAt + 1);
  switch (group.text) {
    case "pr":
      return viaXargs ? MERGE_ANY : ghPr(rest, environment);
    case "api":
      return viaXargs ? MERGE_ANY : ghApi(rest);
    case "alias":
      return viaXargs ? MERGE_ANY : ghAlias(rest);
    default:
      return null;
  }
}

/** `wmill`の引数から、反映の操作を返す。 */
function wmillOperation(
  args: readonly Word[],
  viaXargs: boolean,
): readonly GuardedOperation[] {
  if (viaXargs) return [SYNC_PUSH, MIGRATE];
  const { options, positionals } = parseArgs(args, WMILL_OPTIONS);
  const [first, second, third] = positionals.map((word) => word.text);
  if (first === "sync" && second === "push") {
    // `--dry-run=false`のように値を付けた形は、`--dry-run`とみなさない。
    const dryRun = options.some(
      (option) => option.name === "--dry-run" && option.value === null,
    );
    return dryRun ? [] : [SYNC_PUSH];
  }
  // ワークスペースのmerge(`profile`は別名)は、ワークスペースの内容を書き換える反映である。
  if ((first === "workspace" || first === "profile") && second === "merge") {
    return [SYNC_PUSH];
  }
  if (
    first === "datatable" &&
    second === "migrate" &&
    (third === "up" || third === "down")
  ) {
    return [MIGRATE];
  }
  return [];
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

/** 前置きを外し切れなかったとき、残った語の中の`gh`と`wmill`を、マージと反映として扱う。 */
function leftoverOperations(words: readonly Word[]): GuardedOperation[] {
  const found: GuardedOperation[] = [];
  const names = words.map((word) => baseName(word.text));
  if (
    names.includes("gh") ||
    words.some((word) => word.text.startsWith("gh "))
  ) {
    found.push(MERGE_ANY);
  }
  if (
    names.includes("wmill") ||
    words.some((word) => word.text.startsWith("wmill "))
  ) {
    found.push(SYNC_PUSH, MIGRATE);
  }
  return found;
}

function commandOperations(command: SimpleCommand): GuardedOperation[] {
  const { assignments, words, wrappers, opaque } = stripWrappers(command.words);
  if (opaque) return [...EVERY_OPERATION];
  const found: GuardedOperation[] = [];
  const first = words[0];
  if (first === undefined) return found;
  if (first.dynamic) {
    const operation = dynamicProgramOperation(words.slice(1));
    return operation === null ? found : [...found, operation];
  }
  const viaXargs = wrappers.includes("xargs");
  const program = baseName(first.text);
  if (program === "gh") {
    const operation = ghOperation(
      words.slice(1),
      repoFromEnvironment(assignments),
      viaXargs,
    );
    return operation === null ? found : [...found, operation];
  }
  if (program === "wmill") {
    return [...found, ...wmillOperation(words.slice(1), viaXargs)];
  }
  // シェルの`-c`の引数は、字句に分ける段階で別のコマンドとして取り出されている。
  if (shellArguments(words) !== null) return found;
  return wrappers.length > 0 ? [...found, ...leftoverOperations(words)] : found;
}

function scan(line: string, depth: number): GuardedOperation[] {
  const parsed = parseCommandLine(line);
  if (!parsed.ok) return [];
  const found: GuardedOperation[] = [];
  for (const command of parsed.commands) {
    found.push(...commandOperations(command));
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
