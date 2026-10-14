// CIが再生成した`*.script.yaml`と`wmill-lock.yaml`を、YAMLの完全な解析なしに検査する。
// どちらもwmillが決まった形で書くファイルなので、トップレベルのキーごとの塊に分けるか、
// 1行ずつ厳密な形に合わせて読む。形から外れたものは、解釈を試みずに拒む。
// 副作用を持たない純粋な関数だけを置く。

const TOP_LEVEL_KEY = /^([A-Za-z_][A-Za-z0-9_-]*):(?: .*)?$/;
const WMILL_LOCK_ENTRY = /^ {2}([A-Za-z0-9_+./-]+): ([0-9a-f]{64})$/;

/** 新しいscriptの`.script.yaml`に書いてよいキー。`tag`や`timeout`などの実行の設定は含めない。 */
const NEW_SCRIPT_KEYS: ReadonlySet<string> = new Set([
  "summary",
  "description",
  "lock",
  "kind",
  "schema",
]);

function hasForbiddenCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (
      (code < 0x20 && code !== 0x0a && code !== 0x09) ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

// wmillが`schema`の先頭に書く、JSON Schemaの版の行。`$`を含んでよい唯一の行である。
const SCHEMA_MARKER_LINE =
  "  $schema: https://json-schema.org/draft/2020-12/schema";
// YAMLの復号を実装せずに値の意味を変えうる文字。エスケープ(`\`)、タグ(`!`)、アンカー(`&`)、
// エイリアス(`*`)、ディレクティブ(`%`)、タブ、`$`(`$var:`や`$res:`は実行者の権限で解決される)。
const RISKY_SCHEMA_CHARS = /[\\!&*%\t$]/;
const WINDMILL_EXTENSION = /x-windmill/i;

/**
 * `schema`の中で、スキーマの語彙として書いてよいキー。
 * リポジトリのすべての`.script.yaml`の`schema`で使われているキーの和集合である。
 * `showExpr`や`customErrorMessage`のように、Windmillの式やUIの挙動に関わるキーは含めない。
 */
export const ALLOWED_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set<string>([
  "type",
  "properties",
  "required",
  "description",
  "default",
  "originalType",
  "format",
  "items",
  "resourceType",
  "enum",
]);

// 値を持たない`properties`と`items`の子は、スキーマの語彙を持つ入れ子として読む。
const NESTED_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  "properties",
  "items",
]);
const KEY_LINE = /^( *)(.+?):(?: +(.*))?$/;

type SchemaState = "schema" | "names" | "opaque";
type SchemaFrame = { readonly indent: number; readonly child: SchemaState };

export type SchemaWalk =
  | { readonly ok: true; readonly keywords: ReadonlySet<string> }
  | { readonly ok: false };

function unquote(key: string): string {
  const trimmed = key.trim();
  const quoted =
    trimmed.length >= 2 &&
    (trimmed[0] === '"' || trimmed[0] === "'") &&
    trimmed.at(-1) === trimmed[0];
  return quoted ? trimmed.slice(1, -1) : trimmed;
}

/**
 * `schema`の塊をインデントで読み、スキーマの語彙として書かれたキーを集める。
 * `schema`直下、`properties`の各項目の中、`items`の中のキーを語彙として読む。
 * `properties`の直下のキー(引数の名前)は自由に読み、`default`や`enum`など、ほかのキーの中身は読まない。
 * 語彙の位置にある行が、キーの行でないとき、リストの項目のとき、
 * `properties`と`items`の中身が同じ行の`{...}`で書かれているときは、失敗にする。
 * 流れ形式の入れ子に、語彙のキーを隠させないためである。
 */
export function walkSchema(block: string): SchemaWalk {
  const keywords = new Set<string>();
  const frames: SchemaFrame[] = [];
  const lines = block.split("\n").slice(1);
  for (const line of lines) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    if (line === SCHEMA_MARKER_LINE) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    while (frames.length > 0 && (frames.at(-1)?.indent ?? 0) >= indent) {
      frames.pop();
    }
    const container: SchemaState = frames.at(-1)?.child ?? "schema";
    const content = line.trimStart();
    if (content === "-" || content.startsWith("- ")) {
      if (container !== "opaque") {
        return { ok: false };
      }
      continue;
    }
    const match = KEY_LINE.exec(line);
    if (match?.[2] === undefined) {
      if (container !== "opaque") {
        return { ok: false };
      }
      continue;
    }
    const key = unquote(match[2]);
    const inline = (match[3] ?? "").trim();
    let child: SchemaState = "opaque";
    if (container === "schema") {
      keywords.add(key);
      if (NESTED_SCHEMA_KEYS.has(key)) {
        child = key === "properties" ? "names" : "schema";
        if (inline !== "" && inline !== "{}") {
          return { ok: false };
        }
      }
    } else if (container === "names") {
      child = "schema";
      if (inline !== "" && inline !== "{}") {
        return { ok: false };
      }
    }
    frames.push({ indent, child });
  }
  return { ok: true, keywords };
}

/**
 * `schema`の塊が、許可リストの範囲に収まるか。
 * - 塊の1行目が`schema:`だけで、値が同じ行に書かれていないこと。流れ形式やブロックスカラーで中身を隠せない。
 * - 既知の1行を除いて、復号の前に、値の意味を変えうる文字と`x-windmill`を含まないこと。
 * - スキーマの語彙のキーが、`ALLOWED_SCHEMA_KEYWORDS`の中にあること。
 * `schema`はコードを動かさないが、`$`で始まる値は実行者の権限で解決され、
 * `x-windmill`や`showExpr`のようなキーはフォームの挙動と式の評価を変える。
 * エスケープやタグで綴りを変えられると正規表現では見分けられないので、それらの文字ごと拒む。
 */
function isInertSchema(block: string): boolean {
  const lines = block.split("\n");
  if (lines[0] !== "schema:") {
    return false;
  }
  const known = lines.indexOf(SCHEMA_MARKER_LINE);
  const text = lines.filter((_line, index) => index !== known).join("\n");
  if (RISKY_SCHEMA_CHARS.test(text) || WINDMILL_EXTENSION.test(text)) {
    return false;
  }
  const walked = walkSchema(block);
  return (
    walked.ok &&
    [...walked.keywords].every((key) => ALLOWED_SCHEMA_KEYWORDS.has(key))
  );
}

export type BlocksResult =
  | { readonly ok: true; readonly blocks: ReadonlyMap<string, string> }
  | { readonly ok: false };

/**
 * ファイルを、トップレベルのキーごとの塊に分ける。
 * 塊は、キーの行と、その後ろの空行と字下げされた行である。
 * 字下げのないキー以外の行(コメント、`---`、リスト、引用符つきのキー)、キーの重複、
 * 最初のキーより前の字下げされた行、CRと制御文字は失敗にする。
 * 字下げのない行がキーの行だけなので、`schema`の塊の中に別のトップレベルのキーを隠せない。
 */
export function splitTopLevelBlocks(text: string): BlocksResult {
  if (text.includes("\r") || hasForbiddenCharacter(text)) {
    return { ok: false };
  }
  const blocks = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    const match = TOP_LEVEL_KEY.exec(line);
    if (match?.[1] !== undefined) {
      if (blocks.has(match[1])) {
        return { ok: false };
      }
      current = [line];
      blocks.set(match[1], current);
    } else if (line === "" || line.startsWith(" ")) {
      if (current !== null) {
        current.push(line);
      } else if (line !== "") {
        return { ok: false };
      }
    } else {
      return { ok: false };
    }
  }
  const joined = new Map<string, string>();
  for (const [key, lines] of blocks) {
    joined.set(key, lines.join("\n").replace(/\n+$/, ""));
  }
  return { ok: true, blocks: joined };
}

export type ScriptYamlFailure =
  | "malformed"
  | "no_schema"
  | "unsafe_schema"
  | "bad_lock"
  | "disallowed_key"
  | "bad_kind"
  | "no_head"
  | "key_changed";

export type ScriptYamlResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ScriptYamlFailure };

function reject(reason: ScriptYamlFailure): ScriptYamlResult {
  return { ok: false, reason };
}

/**
 * 再生成した`.script.yaml`(`patch`)を検査する。`scriptPath`は拡張子のないscriptのパス。
 * 共通して、`schema`があり、その中に許可リスト外の文字(`\`、`!`、`&`、`*`、`%`、タブ、`$`)と
 * `x-windmill`が無く、スキーマの語彙のキーが`ALLOWED_SCHEMA_KEYWORDS`の中にあり、
 * `lock`が`'!inline <scriptPath>.script.lock'`であることを求める。
 * - 新しいscript(`isNewScript`): キーが許可リストの中にあり、`kind`があるなら`script`であること。
 * - 既存のscript: 現在の版(`head`)と比べて、`schema`以外のキーの塊が同じであること。
 *   summaryなどを正当に変えたPRを拒まず、`tag`や`timeout`の追加と削除を拒むため。
 */
export function checkScriptYaml(input: {
  readonly patch: string;
  readonly head: string | null;
  readonly scriptPath: string;
  readonly isNewScript: boolean;
}): ScriptYamlResult {
  const patch = splitTopLevelBlocks(input.patch);
  if (!patch.ok) {
    return reject("malformed");
  }
  const schema = patch.blocks.get("schema");
  if (schema === undefined) {
    return reject("no_schema");
  }
  if (!isInertSchema(schema)) {
    return reject("unsafe_schema");
  }
  const expectedLock = `lock: '!inline ${input.scriptPath}.script.lock'`;
  if (patch.blocks.get("lock") !== expectedLock) {
    return reject("bad_lock");
  }
  if (input.isNewScript) {
    for (const key of patch.blocks.keys()) {
      if (!NEW_SCRIPT_KEYS.has(key)) {
        return reject("disallowed_key");
      }
    }
    const kind = patch.blocks.get("kind");
    return kind === undefined || kind === "kind: script"
      ? { ok: true }
      : reject("bad_kind");
  }
  if (input.head === null) {
    return reject("no_head");
  }
  const head = splitTopLevelBlocks(input.head);
  if (!head.ok) {
    return reject("malformed");
  }
  const keys = new Set([...patch.blocks.keys(), ...head.blocks.keys()]);
  keys.delete("schema");
  for (const key of keys) {
    if (patch.blocks.get(key) !== head.blocks.get(key)) {
      return reject("key_changed");
    }
  }
  return { ok: true };
}

export type WmillLockFailure = "unknown_version" | "malformed";

export type WmillLockResult =
  | { readonly ok: true; readonly locks: ReadonlyMap<string, string> }
  | { readonly ok: false; readonly reason: WmillLockFailure };

/**
 * `wmill-lock.yaml`を読む。形は`version: v2`、`locks:`、`  <path>: <64桁の小文字の16進数>`の行だけである。
 * 版が`v2`以外なら`unknown_version`、それ以外の形の違いとキーの重複は`malformed`を返す。
 */
export function parseWmillLock(text: string): WmillLockResult {
  if (text.includes("\r") || hasForbiddenCharacter(text)) {
    return { ok: false, reason: "malformed" };
  }
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  const [version, locksLine, ...entries] = lines;
  if (version === undefined || !version.startsWith("version: ")) {
    return { ok: false, reason: "malformed" };
  }
  if (version !== "version: v2") {
    return { ok: false, reason: "unknown_version" };
  }
  if (locksLine !== "locks:") {
    return { ok: false, reason: "malformed" };
  }
  const locks = new Map<string, string>();
  for (const line of entries) {
    const match = WMILL_LOCK_ENTRY.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      return { ok: false, reason: "malformed" };
    }
    if (locks.has(match[1])) {
      return { ok: false, reason: "malformed" };
    }
    locks.set(match[1], match[2]);
  }
  return { ok: true, locks };
}
