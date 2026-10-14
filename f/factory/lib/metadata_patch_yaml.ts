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

// 実行者の権限で変数やリソースの値に解決される、`$var:`や`$res:`の形の値の先頭。
// キーの先頭の`$schema`は、検査の前に取り除く。
const SCHEMA_MARKER_LINE =
  /^ *\$schema: https:\/\/json-schema\.org\/draft\/2020-12\/schema *$/gm;
const DOLLAR_VALUE = /(?:^ *|[:,[{] *|- +)["']?\$/m;
const WINDMILL_EXTENSION = /x-windmill-/i;

/**
 * `schema`の塊が、値の解決も拡張も含まないか。
 * `schema`はコードを動かさないが、`$`で始まる文字列の値は実行者の権限で解決され、
 * `x-windmill-`のキーはフォームの挙動を変える。
 */
function isInertSchema(block: string): boolean {
  const text = block.replace(SCHEMA_MARKER_LINE, "");
  return !(DOLLAR_VALUE.test(text) || WINDMILL_EXTENSION.test(text));
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
 * 共通して、`schema`があり、その中に`$`で始まる値と`x-windmill-`のキーが無く、
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
