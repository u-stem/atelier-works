import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Glob } from "bun";

// secret変数の読み取りを境界で数えるテスト(Console用workerと定期ジョブ用worker)が共有する走査。
// 走査の方法と限界は、`console_worker_boundary.test.ts`の先頭に書いてある。

export const GITHUB_TOKEN = "f/factory/github_token";
export const DISCORD_WEBHOOK_URL = "f/factory/discord_webhook_url";
export const GITHUB_READ_TOKENS = "f/factory/github_read_tokens";

export const transpiler = new Bun.Transpiler({ loader: "ts" });

/** コメントと型を落としたJavaScript。コメントの中の文字列で誤検知せず、行頭のブロックコメントの後ろのコードも残す。 */
export function codeOf(source: string): string {
  return transpiler.transformSync(source);
}

/** `source`が相対パスで読み込む先。副作用だけのimport、再エクスポート、リテラルの動的importを含む。 */
export function relativeImports(source: string): string[] {
  return transpiler
    .scanImports(source)
    .map((entry) => entry.path)
    .filter((path) => path.startsWith("."));
}

const SIMPLE_DYNAMIC_IMPORT = /^import\s*\(\s*(?:"[^"\\]*"|'[^'\\]*')\s*\)/;

/** 走査がたどれないimportの形。たどれない理由を返す。 */
export function unfollowableImports(source: string): string[] {
  const found: string[] = [];
  for (const entry of transpiler.scanImports(source)) {
    if (entry.path.startsWith("/") || /^[fu]\//.test(entry.path)) {
      found.push(`non-relative import of ${entry.path}`);
    }
  }
  const code = codeOf(source);
  if (/\brequire\s*\(/.test(code)) found.push("require");
  for (const match of code.matchAll(/\bimport\s*\(/g)) {
    if (!SIMPLE_DYNAMIC_IMPORT.test(code.slice(match.index))) {
      found.push("dynamic import with a non-literal argument");
    }
  }
  return found;
}

// `getVariableValue`や`getResourceValueInterpolated`のように、名前が続くSDKの関数も数える。
const VARIABLE_NAME = /\b(?:getVariable|getResource)\w*/g;
const LITERAL_CALL =
  /\.\s*(?:getVariable|getResource)\s*\(\s*(?:""|``)\s*[,)]/g;
const NAME_ONLY_STRING = /^["'](?:getVariable|getResource)\w*["']$/;
const REGEX_PRECEDER =
  /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|in|of))\s*$/;

/**
 * 変換後のコードから、文字列、テンプレートの文字部分、正規表現リテラルの中身を落とした骨組み。
 * 文字列は`""`に、テンプレートは`` ` ` ``に置き換える。テンプレートの`${}`の中のコードは残す。
 * 名前だけの文字列(`"getVariable"`)は、添字アクセスに使えるので残す。
 * 文字列の中のgetVariableの言及(ログの文など)を、読み取りと数えないための前処理である。
 */
export function codeSkeleton(code: string): string {
  let out = "";
  let i = 0;
  let braces = 0;
  const resume: number[] = [];

  const readTemplate = (): void => {
    while (i < code.length) {
      const ch = code[i];
      if (ch === "\\") {
        i += 2;
      } else if (ch === "`") {
        i += 1;
        out += "``";
        return;
      } else if (ch === "$" && code[i + 1] === "{") {
        i += 2;
        resume.push(braces);
        braces += 1;
        out += " ";
        return;
      } else {
        i += 1;
      }
    }
  };

  const skipQuoted = (quote: string): string => {
    const start = i;
    i += 1;
    while (i < code.length && code[i] !== quote) {
      i += code[i] === "\\" ? 2 : 1;
    }
    i += 1;
    return code.slice(start, i);
  };

  const skipRegex = (): void => {
    i += 1;
    let inClass = false;
    while (i < code.length) {
      const ch = code[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "[") inClass = true;
      else if (ch === "]") inClass = false;
      else if (ch === "/" && !inClass) break;
      i += 1;
    }
    i += 1;
    out += "//";
  };

  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'") {
      const literal = skipQuoted(ch);
      out += NAME_ONLY_STRING.test(literal) ? literal : '""';
    } else if (ch === "`") {
      i += 1;
      readTemplate();
    } else if (ch === "{") {
      braces += 1;
      out += ch;
      i += 1;
    } else if (ch === "}") {
      braces -= 1;
      i += 1;
      if (resume.length > 0 && resume[resume.length - 1] === braces) {
        resume.pop();
        readTemplate();
      } else {
        out += ch;
      }
    } else if (ch === "/" && REGEX_PRECEDER.test(out)) {
      skipRegex();
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/**
 * getVariable()かgetResource()の名前の出現のうち、`.name("literal")`の形の呼び出しで説明できないもの。
 * コード中の出現をすべて数え、説明できるものを引く。残りは、読み取りの対象を静的に決められない。
 * 添字アクセス(`w["getVariable"](p)`)、分割代入、名前付きimport、別名への代入、
 * 引数が変数や組み立てた文字列の呼び出し、注入された関数の呼び出しが残る。
 */
export function nonLiteralVariableReads(source: string): string[] {
  const skeleton = codeSkeleton(codeOf(source));
  const unexplained =
    [...skeleton.matchAll(VARIABLE_NAME)].length -
    [...skeleton.matchAll(LITERAL_CALL)].length;
  return unexplained > 0 ? [`${String(unexplained)} unexplained`] : [];
}

/** `entry`のTypeScriptと、そこから相対importでたどれるファイルすべての本文。 */
export function sourcesReachableFrom(entry: string): Map<string, string> {
  const sources = new Map<string, string>();
  const pending = [resolve(`${entry}.ts`)];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (sources.has(file)) continue;
    const source = readFileSync(file, "utf8");
    sources.set(file, source);
    for (const path of relativeImports(source)) {
      pending.push(resolve(dirname(file), path));
    }
  }
  return sources;
}

export function mentions(entry: string, variablePath: string): boolean {
  return [...sourcesReachableFrom(entry).values()].some((source) =>
    codeOf(source).includes(variablePath),
  );
}

export async function scan(pattern: string): Promise<string[]> {
  const found: string[] = [];
  for await (const file of new Glob(pattern).scan(".")) found.push(file);
  return found.sort();
}

export async function yamlOf(file: string): Promise<Record<string, unknown>> {
  const parsed: unknown = Bun.YAML.parse(await Bun.file(file).text());
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file}: not a YAML mapping`);
  }
  return Object.fromEntries(Object.entries(parsed));
}

export async function secretVariablePaths(): Promise<string[]> {
  const paths: string[] = [];
  for (const file of await scan("f/factory/*.variable.yaml")) {
    if ((await yamlOf(file)).is_secret === true) {
      paths.push(file.replace(/\.variable\.yaml$/, ""));
    }
  }
  return paths;
}

export const relative = (file: string) => file.replace(`${process.cwd()}/`, "");

/**
 * 解析したYAMLの中に、キー`tag`か`tag_override`の値が`tag`であるものがあるか。
 * scriptの定義、スケジュール、フローのモジュールが、ジョブの振り分け先を決める形をたどる。
 */
export function mentionsTag(value: unknown, tag: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => mentionsTag(item, tag));
  }
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, child]) =>
      ((key === "tag" || key === "tag_override") && child === tag) ||
      mentionsTag(child, tag),
  );
}

/**
 * YAMLの本文を解析する。解析できなければ、ファイル名を添えて例外にする。
 * 解析の関数は、失敗の分岐を確かめるために差し替えられる。
 */
export function parseYamlFile(
  file: string,
  text: string,
  parse: (text: string) => unknown = (source) => Bun.YAML.parse(source),
): unknown {
  try {
    return parse(text);
  } catch (error) {
    throw new Error(`${file}: cannot parse the YAML (${String(error)})`);
  }
}

/** `f/`の下のYAMLのうち、`mentionsTag`が真になるファイルのパス。読めないYAMLがあれば、ファイル名を添えて例外にする。 */
export async function filesWithTag(tag: string): Promise<string[]> {
  const found: string[] = [];
  for (const file of await scan("f/**/*.yaml")) {
    const parsed = parseYamlFile(file, await Bun.file(file).text());
    if (mentionsTag(parsed, tag)) found.push(file);
  }
  return found;
}

/** scriptの定義の`timeout`(秒)。数でなければ`null`。 */
export async function scriptTimeoutSeconds(
  path: string,
): Promise<number | null> {
  const timeout = (await yamlOf(`${path}.script.yaml`)).timeout;
  return typeof timeout === "number" ? timeout : null;
}

const FILE_OR_PROCESS_MODULE =
  /^(?:node:)?(?:child_process|fs|fs\/promises|module|worker_threads|vm)$|^bun(?::|$)/;
const BUN_NAME = /\bBun\b/g;
const BUN_MEMBER = /^\s*\.\s*([\w$]+)/;
const GLOBAL_LOOKUP =
  /\bglobalThis\b|\bgetBuiltinModule\b|\bprocess\s*\.\s*binding\b/g;

/** ファイルにもサブプロセスにも届かない`Bun`のメンバー。 */
const HARMLESS_BUN_MEMBERS: ReadonlySet<string> = new Set([
  "sleep",
  "env",
  "version",
  "revision",
  "hash",
  "nanoseconds",
  "deepEquals",
  "escapeHTML",
  "randomUUIDv7",
  "CryptoHasher",
  "password",
  "stringWidth",
  "YAML",
]);

/**
 * 上流のイメージのworkerに無いものへ届く、import・呼び出し。
 * 次を数え、見つけたものを理由の文字列で返す。
 * - ファイル(`node:fs`)、サブプロセス(`node:child_process`)、`bun`モジュールのimport(名前付き、既定とも)。
 * - 迂回に使えるモジュール(`node:module`、`node:worker_threads`、`node:vm`)のimport。
 * - Claude(`claude.ts`)のimport。
 * - `Bun`の使い方。無害なメンバー(`Bun.sleep`など)の呼び出し以外は、すべて数える。
 *   `Bun.spawn`と`Bun.file`だけでなく、分割代入、別名への代入、添字アクセスも当たる。
 * - `globalThis`、`process.getBuiltinModule`、`process.binding`。これらを経由すると、名前を伏せて同じものに届くため。
 * 見ないもの: 文字列で組み立てた参照、`eval`と`Function`、注入された関数の中身、
 * 第三者パッケージ(`execa`、`fs-extra`、`zx`など)の中身。
 * 文字列の中の言及は数えない。
 */
export function toolDependencies(source: string): string[] {
  const found: string[] = [];
  for (const entry of transpiler.scanImports(source)) {
    if (
      FILE_OR_PROCESS_MODULE.test(entry.path) ||
      /(?:^|\/)claude\.ts$/.test(entry.path)
    ) {
      found.push(`import of ${entry.path}`);
    }
  }
  const skeleton = codeSkeleton(codeOf(source));
  for (const match of skeleton.matchAll(BUN_NAME)) {
    const member = BUN_MEMBER.exec(skeleton.slice(match.index + 3))?.[1];
    if (member === undefined || !HARMLESS_BUN_MEMBERS.has(member)) {
      found.push(`use of Bun${member === undefined ? "" : `.${member}`}`);
    }
  }
  for (const match of skeleton.matchAll(GLOBAL_LOOKUP)) {
    found.push(`use of ${match[0]}`);
  }
  return found;
}

/** `script.yaml`の本文が、入力の既定値で変数かresourceを参照しているか。 */
export function hasInputReference(yamlText: string): boolean {
  return /\$(?:var|res):/.test(yamlText);
}

/** `entries`がimportでたどれるファイルのうち、`predicate`が真になる本文のものを、重複なく並べる。 */
function reachedFilesWhere(
  entries: readonly string[],
  predicate: (file: string, source: string) => boolean,
): string[] {
  const found = new Set<string>();
  for (const entry of entries) {
    for (const [file, source] of sourcesReachableFrom(entry)) {
      if (predicate(relative(file), source)) found.add(relative(file));
    }
  }
  return [...found].sort();
}

/** `entries`のうち、importでたどれるソースに、走査でたどれないimportの形があるファイル。 */
export function filesWithUnfollowableImports(
  entries: readonly string[],
): string[] {
  return reachedFilesWhere(
    entries,
    (_file, source) => unfollowableImports(source).length > 0,
  );
}

/** `entries`のうち、`allowed`に無い、引数が文字列リテラルでない変数の読み取りがあるファイル。 */
export function filesWithNonLiteralReads(
  entries: readonly string[],
  allowed: Readonly<Record<string, string>>,
): string[] {
  return reachedFilesWhere(
    entries,
    (file, source) =>
      nonLiteralVariableReads(source).length > 0 && !(file in allowed),
  );
}

/** `entries`のうち、importでたどれるソースに、道具への依存があるファイル。 */
export function filesWithToolDependencies(
  entries: readonly string[],
): string[] {
  return reachedFilesWhere(
    entries,
    (_file, source) => toolDependencies(source).length > 0,
  );
}

/** `entries`がimportでたどれるソースに現れるsecret変数のうち、`allowed`に無いもの。 */
export async function secretsOutside(
  entries: readonly string[],
  allowed: readonly string[],
): Promise<string[]> {
  const found = new Set<string>();
  const secrets = await secretVariablePaths();
  for (const entry of entries) {
    const codes = [...sourcesReachableFrom(entry).values()].map(codeOf);
    for (const secret of secrets) {
      if (!allowed.includes(secret) && codes.some((c) => c.includes(secret))) {
        found.add(secret);
      }
    }
  }
  return [...found].sort();
}

/** script別に許すSDKの呼び出し。`services`は`JobService.getJob`の形、`members`は`wmill.<member>`の関数名。 */
export type SdkAllowance = {
  readonly services: readonly string[];
  readonly members: readonly string[];
};

export type SdkFindings = {
  /** `wmill.<X>Service.<method>`と`wmill.<member>`の使用。 */
  readonly used: readonly string[];
  /** 許可表に関わらず禁じる形(別名、名前付きimport、fetch、深いパスのimportなど)。 */
  readonly problems: readonly string[];
};

const CLIENT_IMPORT = /^windmill-client(?:@[\w.+-]+)?$/;
const FORBIDDEN_NAMES =
  /\b(?:WM_TOKEN|BASE_INTERNAL_URL|BASE_URL|OpenAPI|XMLHttpRequest|WebSocket|EventSource)\b/;
const CLIENT_IMPORT_CLAUSE =
  /\bimport\s+([^;"']*?)\s*\bfrom\s*["']windmill-client[^"']*["']/g;
const IMPORT_STATEMENT = /\bimport\s+[^;"']*?\bfrom\s*""/g;
const FETCH_REFERENCE = /(?<![.\w$])fetch(?![\w$])(?!\s*:)/;
// `require`は呼び出しの形に限らず、変数に入れる形も禁じる。`import.meta`は`env`や`require`を持つ。
const REQUIRE_REFERENCE = /(?<![.\w$])require(?![\w$])(?!\s*:)/;
const IMPORT_META = /(?<![.\w$])import\s*\.\s*meta(?![\w$])/;
const WORKER_REFERENCE = /(?<![.\w$])Worker(?![\w$])(?!\s*:)/;
const GLOBAL_OBJECT = /(?<![.\w$])(?:globalThis|global|self|window)(?![\w$])/;
const MEMBER_ACCESS = /^\s*\.\s*([A-Za-z_$][\w$]*)/;

/**
 * パスをリテラルに固定するSDKの呼び出し。`requestBody`を続けてよいのは、更新の呼び出しだけである。
 * 読み取りの呼び出しが本文を受け取る形は、固定したパス以外を読ませる抜け道になりうる。
 */
const BOUND_PATH_CALLS: Readonly<
  Record<string, { readonly path: string; readonly requestBody: boolean }>
> = {
  "ResourceService.getResourceValue": {
    path: "f/factory/factory_config",
    requestBody: false,
  },
  "ResourceService.updateResourceValue": {
    path: "f/factory/factory_config",
    requestBody: true,
  },
};

/**
 * パスをリテラルに固定する変数の呼び出し。凍結の変数だけを読み書きしてよい。
 * `setVariable`は変数が無いときに作るので、秘密の変数として作らないよう、3番目の引数を`false`に固定する。
 */
const BOUND_VARIABLE_PATH = "f/factory/freezes";
const BOUND_VARIABLE_CALLS = ["getVariable", "setVariable"] as const;

/** `text`の`index`にある引用符で始まる文字列の、次の位置。閉じていなければ`undefined`。 */
function skipQuoted(text: string, index: number): number | undefined {
  const quote = text[index];
  for (let i = index + 1; i < text.length; i += 1) {
    if (text[i] === "\\") i += 1;
    else if (text[i] === quote) return i + 1;
  }
  return undefined;
}

/** `${`の直後の`from`から、対応する`}`の次の位置。 */
function skipBraces(text: string, from: number): number | undefined {
  let depth = 1;
  let i = from;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const next = skipQuoted(text, i);
      if (next === undefined) return undefined;
      i = next;
      continue;
    }
    if (ch === "`") {
      const next = skipTemplate(text, i);
      if (next === undefined) return undefined;
      i = next;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return undefined;
}

/** バッククォートで始まるテンプレートの、次の位置。`${}`の中の括弧を数える。 */
function skipTemplate(text: string, index: number): number | undefined {
  let i = index + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
    } else if (ch === "`") {
      return i + 1;
    } else if (ch === "$" && text[i + 1] === "{") {
      const next = skipBraces(text, i + 2);
      if (next === undefined) return undefined;
      i = next;
    } else {
      i += 1;
    }
  }
  return undefined;
}

/**
 * `text`を、括弧の外側(最上位)のカンマで分ける。文字列とテンプレートの中の括弧とカンマは数えない。
 * 括弧が合わない、文字列が閉じていないなど、読み切れないときは`undefined`を返す。
 */
function splitTopLevel(text: string): string[] | undefined {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const next = ch === "`" ? skipTemplate(text, i) : skipQuoted(text, i);
      if (next === undefined) return undefined;
      i = next;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth < 0) return undefined;
    }
    if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  if (depth !== 0) return undefined;
  parts.push(text.slice(start));
  return parts;
}

/** `code`の`open`にある丸括弧に対応する閉じ括弧までの、括弧の内側の本文。閉じていなければ`undefined`。 */
function callArguments(code: string, open: number): string | undefined {
  let depth = 0;
  let i = open;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const next = ch === "`" ? skipTemplate(code, i) : skipQuoted(code, i);
      if (next === undefined) return undefined;
      i = next;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
    i += 1;
  }
  return undefined;
}

/** 末尾のカンマが作る空の要素を落とす。 */
function withoutTrailingBlank(parts: string[]): string[] {
  const last = parts[parts.length - 1];
  return parts.length > 1 && last !== undefined && last.trim() === ""
    ? parts.slice(0, -1)
    : parts;
}

/**
 * 固定するSDKの呼び出しの引数が、`{ workspace, path: "<定数>" }`と、許された`requestBody`だけでできているか。
 * 引数の最上位のキーを数え、スプレッド、別のキー、重複したキー、計算したキーを禁じる。
 * `requestBody`の本文の中身は見ない。本文の外側に`path`を置く形は、最上位のキーとして数える。
 * 違反の理由を返し、合っていれば`undefined`を返す。
 */
function boundArgumentsProblem(
  args: string | undefined,
  path: string,
  allowRequestBody: boolean,
): string | undefined {
  const argumentList = args === undefined ? undefined : splitTopLevel(args);
  if (argumentList === undefined) return "arguments cannot be read";
  const calls = withoutTrailingBlank(argumentList);
  const object = calls[0]?.trim();
  if (calls.length !== 1 || object === undefined) {
    return "arguments are not a single object";
  }
  if (!object.startsWith("{") || !object.endsWith("}")) {
    return "the argument is not an object literal";
  }
  const properties = splitTopLevel(object.slice(1, -1));
  if (properties === undefined) return "properties cannot be read";
  const seen = { workspace: 0, path: 0, requestBody: 0 };
  for (const raw of withoutTrailingBlank(properties)) {
    const property = raw.trim();
    if (property === "workspace") {
      seen.workspace += 1;
    } else if (property === `path: ${JSON.stringify(path)}`) {
      seen.path += 1;
    } else if (allowRequestBody && /^requestBody\s*:/.test(property)) {
      seen.requestBody += 1;
    } else {
      return `unexpected property ${property.slice(0, 24)}`;
    }
  }
  return seen.workspace === 1 && seen.path === 1 && seen.requestBody <= 1
    ? undefined
    : "workspace, path and requestBody must each appear once";
}

function clientBindings(code: string, problems: string[]): string[] {
  const bindings: string[] = [];
  for (const match of code.matchAll(CLIENT_IMPORT_CLAUSE)) {
    const clause = match[1] ?? "";
    if (clause.includes("{")) {
      problems.push("named import from windmill-client");
    }
    const namespace = /\*\s*as\s+([\w$]+)/.exec(clause)?.[1];
    if (namespace !== undefined) bindings.push(namespace);
    const fallback = /^([\w$]+)\s*(?:,|$)/.exec(clause.trim())?.[1];
    if (fallback !== undefined) bindings.push(fallback);
  }
  return bindings;
}

function importProblems(source: string, problems: string[]): void {
  for (const entry of transpiler.scanImports(source)) {
    const path = entry.path;
    if (path.startsWith(".")) continue;
    if (CLIENT_IMPORT.test(path) && entry.kind !== "dynamic-import") continue;
    problems.push(`import of ${path}`);
  }
}

/**
 * 1つのソースが使うSDKの呼び出し(`used`)と、許可表に関わらず禁じる形(`problems`)。
 * windmill-clientのnamespaceとdefaultの束縛を見つけ、束縛の出現をすべて数える。
 * `<束縛>.<member>`と`<束縛>.<X>Service.<method>`の形で説明できない出現(別名、添字、optional chain、
 * 引数への受け渡し)は禁じる。名前付きimport、windmill-client以外の外部のimportと深いパスのimport、
 * `fetch`、`require`(変数に入れる形も)、`import.meta`、`Worker`、`globalThis`、`WM_TOKEN`などの名前も禁じる。
 * 文字列とコメントの中の言及は数えない。ただし`WM_TOKEN`などの名前は、文字列でも禁じる。
 * パスをリテラルに固定する呼び出し(`BOUND_PATH_CALLS`)は、その定数以外のパスを禁じる。
 */
export function sdkFindings(source: string): SdkFindings {
  const problems: string[] = [];
  const used = new Set<string>();
  const code = codeOf(source);
  importProblems(source, problems);
  const bindings = clientBindings(code, problems);
  const skeleton = codeSkeleton(code).replace(IMPORT_STATEMENT, "");
  for (const binding of bindings) {
    const escaped = binding.replaceAll("$", "\\$");
    const occurrence = new RegExp(`(?<![\\w$.])${escaped}(?![\\w$])`, "g");
    for (const match of skeleton.matchAll(occurrence)) {
      const after = skeleton.slice(match.index + binding.length);
      const member = MEMBER_ACCESS.exec(after);
      if (member === null || member[1] === undefined) {
        problems.push(`${binding} is used without a member access`);
        continue;
      }
      const name = member[1];
      if (!name.endsWith("Service")) {
        used.add(name);
        continue;
      }
      const method = MEMBER_ACCESS.exec(after.slice(member[0].length))?.[1];
      if (method === undefined) {
        problems.push(`${name} is used without a method`);
      } else {
        used.add(`${name}.${method}`);
      }
    }
  }
  // windmill-clientを指すimportの数と、許可した形の数が合わなければ、再エクスポートがある。
  const clientStatements = [
    ...code.matchAll(/\bfrom\s*["']windmill-client[^"']*["']/g),
  ].length;
  if (clientStatements !== [...code.matchAll(CLIENT_IMPORT_CLAUSE)].length) {
    problems.push("re-export of windmill-client");
  }
  if (FETCH_REFERENCE.test(skeleton)) problems.push("use of fetch");
  if (REQUIRE_REFERENCE.test(skeleton)) problems.push("use of require");
  if (IMPORT_META.test(skeleton)) problems.push("use of import.meta");
  if (WORKER_REFERENCE.test(skeleton)) problems.push("use of Worker");
  const globalObject = GLOBAL_OBJECT.exec(skeleton)?.[0];
  if (globalObject !== undefined) problems.push(`use of ${globalObject}`);
  const forbidden = FORBIDDEN_NAMES.exec(code)?.[0];
  if (forbidden !== undefined) problems.push(`mention of ${forbidden}`);
  for (const [call, bound] of Object.entries(BOUND_PATH_CALLS)) {
    const [service, method] = call.split(".");
    const opening = new RegExp(`\\b${service}\\s*\\.\\s*${method}\\s*\\(`, "g");
    // 引数は`{ workspace, path: "<定数>" }`の形だけを許す(更新は`requestBody`を続けてよい)。
    for (const match of code.matchAll(opening)) {
      const args = callArguments(code, match.index + match[0].length - 1);
      if (
        boundArgumentsProblem(args, bound.path, bound.requestBody) !== undefined
      ) {
        problems.push(`${call} is not bound to the literal ${bound.path}`);
      }
    }
  }
  for (const name of BOUND_VARIABLE_CALLS) {
    const opening = new RegExp(`(?<![\\w$])${name}\\s*\\(`, "g");
    for (const match of code.matchAll(opening)) {
      const args = callArguments(code, match.index + match[0].length - 1);
      const parts = args === undefined ? undefined : splitTopLevel(args);
      if (parts?.[0]?.trim() !== JSON.stringify(BOUND_VARIABLE_PATH)) {
        problems.push(
          `${name} is not bound to the literal ${BOUND_VARIABLE_PATH}`,
        );
      } else if (name === "setVariable" && parts[2]?.trim() !== "false") {
        problems.push("setVariable may not create a secret variable");
      }
    }
  }
  return { used: [...used].sort(), problems };
}

/** `sdkFindings`の問題と、許可表に無い使用。 */
export function sdkViolations(source: string, allowed: SdkAllowance): string[] {
  const findings = sdkFindings(source);
  const violations = [...findings.problems];
  for (const use of findings.used) {
    const permitted = use.includes(".")
      ? allowed.services.includes(use)
      : allowed.members.includes(use);
    if (!permitted) violations.push(`${use} is not on the allowance`);
  }
  return violations;
}

/** `entry`がimportでたどれるファイルの和に、許可表を当てる。違反はファイルの相対パスを添える。 */
export function sdkViolationsReachableFrom(
  entry: string,
  allowed: SdkAllowance,
): string[] {
  const found: string[] = [];
  for (const [file, source] of sourcesReachableFrom(entry)) {
    for (const violation of sdkViolations(source, allowed)) {
      found.push(`${relative(file)}: ${violation}`);
    }
  }
  return found;
}

/** `process.env`の使い方。`keys`は名前で読んだキー、`problems`は禁じる形。 */
export type EnvUses = {
  readonly keys: readonly string[];
  readonly problems: readonly string[];
};

/**
 * 環境変数の使い方を数える。`process.env.NAME`の形だけを、キー名つきで認める。
 * 環境全体を渡す形、添字の読み取り、分割代入、`process`の別名、`Bun.env`、`import.meta.env`は禁じる。
 * 環境変数にはジョブのトークンなどが入るので、読むキーを名前で固定するためである。
 * 文字列とコメントの中の言及は数えない。
 */
export function envUses(source: string): EnvUses {
  const skeleton = codeSkeleton(codeOf(source));
  const keys: string[] = [];
  const problems: string[] = [];
  for (const match of skeleton.matchAll(/(?<![.\w$])process(?![\w$])/g)) {
    const after = skeleton.slice(match.index + "process".length);
    const key = /^\s*\.\s*env\s*\.\s*([A-Za-z_$][\w$]*)/.exec(after)?.[1];
    if (key === undefined) {
      problems.push("process is used other than as process.env.NAME");
    } else {
      keys.push(key);
    }
  }
  if (/(?<![.\w$])Bun\s*\.\s*env(?![\w$])/.test(skeleton)) {
    problems.push("use of Bun.env");
  }
  if (/import\s*\.\s*meta\s*\.\s*env/.test(skeleton)) {
    problems.push("use of import.meta.env");
  }
  return { keys: [...new Set(keys)].sort(), problems };
}

/** `source`が読み込む先の指定。 */
export function transpilerImports(source: string): string[] {
  return transpiler.scanImports(source).map((entry) => entry.path);
}

/**
 * 字句の禁止で見つける、走査を迂回できる書き方。
 * - `constructor`の言及。文字列の中の言及も数える。`x["constructor"]`は、文字列を組み立てずに書ける。
 * - `eval`と`Function`の使用。コメントと文字列の中の言及は数えない。
 * - `Bun`の添字アクセス(`Bun["env"]`)。
 * 連結した名前で組み立てる参照、割り算を正規表現リテラルと読み違えた範囲の中身は、見つけられない。
 * それらは、保護した部品の変更をレビューするときの観点にする。
 */
export function escapeHatches(source: string): string[] {
  const code = codeOf(source);
  const skeleton = codeSkeleton(code);
  const found: string[] = [];
  if (/constructor/.test(code)) found.push("mention of constructor");
  if (/(?<![\w$])eval(?![\w$])/.test(skeleton)) found.push("use of eval");
  if (/(?<![.\w$])Function(?![\w$])/.test(skeleton)) {
    found.push("use of Function");
  }
  if (/(?<![.\w$])Bun\s*\[/.test(skeleton)) {
    found.push("subscript of Bun");
  }
  return found;
}

/**
 * datatableに文字列でSQLを渡す書き方(`sql.query(...)`、`sql.raw(...)`)。
 * タグ付きテンプレートの`${}`は引数として渡るが、この2つは文字列がそのままSQLになる。
 */
export function datatableStringSql(source: string): string[] {
  const skeleton = codeSkeleton(codeOf(source));
  const found: string[] = [];
  for (const match of skeleton.matchAll(/\.\s*(query|raw)\s*\(/g)) {
    found.push(`call of .${match[1] ?? ""}()`);
  }
  if (/\bRawSql\b/.test(skeleton)) found.push("use of RawSql");
  return found;
}
