// scriptの`main`と`preprocessor`の署名、同じファイルのトップレベルの型宣言、Windmillの注釈を、字句の単位で読んで比べる。
// `.script.yaml`の`schema`と`has_preprocessor`は、これらからだけ決まるので、変わらなければ`.script.yaml`も変わらない。
// 構文木は作らない。コメントを除き、文字列、テンプレート、正規表現を1つの字句にして、
// 括弧の対応を数える。字句の切れ目に確信が持てないときは、読めないものとして断る。
// 副作用を持たない純粋な関数だけを置く。

type TokenKind = "word" | "number" | "punct" | "string" | "template" | "regex";

type Token = {
  readonly text: string;
  readonly kind: TokenKind;
  /** この字句の前に、改行(複数行のコメントを含む)があった。 */
  readonly newline: boolean;
};

/** 直後の`/`が正規表現の開始になる語。 */
const REGEX_KEYWORDS: ReadonlySet<string> = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "case",
  "delete",
  "void",
  "throw",
  "new",
  "yield",
  "await",
  "do",
  "else",
]);

const WORD_START = /[\p{ID_Start}$_]/u;
const WORD = /[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*/uy;
const NUMBER = /[0-9][0-9A-Za-z_.]*/y;
const REGEX_FLAGS = /[A-Za-z]*/y;
const WHITESPACE = /\s/u;
const LINE_BREAK = new RegExp(
  `[\\n\\r${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`,
);

type ScanResult = { readonly tokens: Token[]; readonly end: number };

function isDivisionAfter(tokens: readonly Token[]): boolean | null {
  const previous = tokens.at(-1);
  if (previous === undefined) {
    return false;
  }
  switch (previous.kind) {
    case "number":
    case "string":
    case "template":
    case "regex":
      return true;
    case "word":
      return !REGEX_KEYWORDS.has(previous.text);
    case "punct": {
      if (previous.text === ")" || previous.text === "]") {
        return true;
      }
      if (previous.text === "}") {
        return null;
      }
      const before = tokens.at(-2);
      if (
        (previous.text === "+" || previous.text === "-") &&
        before?.text === previous.text
      ) {
        return null;
      }
      return false;
    }
  }
}

/** 引用符で囲んだ文字列の終わりの次の位置。改行を含む文字列と閉じないものはnull。 */
function endOfQuoted(code: string, start: number): number | null {
  const quote = code[start];
  let index = start + 1;
  while (index < code.length) {
    const char = code[index];
    if (char === "\\") {
      index += 2;
    } else if (char === quote) {
      return index + 1;
    } else if (char !== undefined && LINE_BREAK.test(char)) {
      return null;
    } else {
      index += 1;
    }
  }
  return null;
}

/** 正規表現の終わりの次の位置(フラグを含む)。同じ行で閉じないものはnull。 */
function endOfRegex(code: string, start: number): number | null {
  let index = start + 1;
  let inClass = false;
  while (index < code.length) {
    const char = code[index];
    if (char === "\\") {
      index += 2;
    } else if (char !== undefined && LINE_BREAK.test(char)) {
      return null;
    } else if (char === "[") {
      inClass = true;
      index += 1;
    } else if (char === "]") {
      inClass = false;
      index += 1;
    } else if (char === "/" && !inClass) {
      REGEX_FLAGS.lastIndex = index + 1;
      const flags = REGEX_FLAGS.exec(code);
      return index + 1 + (flags?.[0].length ?? 0);
    } else {
      index += 1;
    }
  }
  return null;
}

/** テンプレートリテラルの終わりの次の位置。`${}`の中は字句として読み、閉じないものはnull。 */
function endOfTemplate(
  code: string,
  start: number,
  level: number,
): number | null {
  if (level >= MAX_NESTING) {
    return null;
  }
  let index = start + 1;
  while (index < code.length) {
    const char = code[index];
    if (char === "\\") {
      index += 2;
    } else if (char === "`") {
      return index + 1;
    } else if (char === "$" && code[index + 1] === "{") {
      const inner = scan(code, index + 2, true, level + 1);
      if (inner === null) {
        return null;
      }
      index = inner.end;
    } else {
      index += 1;
    }
  }
  return null;
}

/**
 * `start`から字句に分ける。`nested`が真のとき、対応する開き波括弧の無い`}`の次の位置で止まる。
 * 読み切れないとき(閉じない文字列とコメント、判断できない`/`)はnull。
 */
function scan(
  code: string,
  start: number,
  nested: boolean,
  level: number,
): ScanResult | null {
  const tokens: Token[] = [];
  let index = start;
  let braces = 0;
  let newline = false;
  const push = (end: number, kind: TokenKind): void => {
    tokens.push({ text: code.slice(index, end), kind, newline });
    newline = false;
    index = end;
  };
  while (index < code.length) {
    const char = code[index] ?? "";
    const next = code[index + 1];
    if (WHITESPACE.test(char)) {
      newline ||= LINE_BREAK.test(char);
      index += 1;
    } else if (char === "/" && next === "/") {
      const end = code.slice(index).search(LINE_BREAK);
      index = end === -1 ? code.length : index + end;
    } else if (char === "/" && next === "*") {
      const end = code.indexOf("*/", index + 2);
      if (end === -1) {
        return null;
      }
      newline ||= LINE_BREAK.test(code.slice(index, end));
      index = end + 2;
    } else if (char === '"' || char === "'") {
      const end = endOfQuoted(code, index);
      if (end === null) {
        return null;
      }
      push(end, "string");
    } else if (char === "`") {
      const end = endOfTemplate(code, index, level);
      if (end === null) {
        return null;
      }
      push(end, "template");
    } else if (char === "/") {
      const division = isDivisionAfter(tokens);
      if (division === null) {
        return null;
      }
      if (division) {
        push(index + 1, "punct");
      } else {
        const end = endOfRegex(code, index);
        if (end === null) {
          return null;
        }
        push(end, "regex");
      }
    } else if (char === "}" && nested && braces === 0) {
      return { tokens, end: index + 1 };
    } else if (char === "=" && next === ">") {
      push(index + 2, "punct");
    } else if (WORD_START.test(char)) {
      WORD.lastIndex = index;
      push(index + (WORD.exec(code)?.[0].length ?? 1), "word");
    } else if (char >= "0" && char <= "9") {
      NUMBER.lastIndex = index;
      push(index + (NUMBER.exec(code)?.[0].length ?? 1), "number");
    } else {
      if (char === "{") {
        braces += 1;
      } else if (char === "}") {
        braces -= 1;
      }
      push(
        index + String.fromCodePoint(code.codePointAt(index) ?? 0).length,
        "punct",
      );
    }
  }
  return nested ? null : { tokens, end: index };
}

const OPENERS: Readonly<Record<string, string>> = {
  "(": ")",
  "[": "]",
  "{": "}",
};

/**
 * 字句ごとの、その字句の前の括弧の深さ。`(`、`[`、`{`の入れ子を数える。
 * 閉じ括弧が対応しないときはnull。
 */
function depths(tokens: readonly Token[]): number[] | null {
  const result: number[] = [];
  const stack: string[] = [];
  for (const token of tokens) {
    if (token.kind !== "punct") {
      result.push(stack.length);
      continue;
    }
    const closer = OPENERS[token.text];
    if (closer !== undefined) {
      result.push(stack.length);
      stack.push(closer);
    } else if (token.text === ")" || token.text === "]" || token.text === "}") {
      if (stack.pop() !== token.text) {
        return null;
      }
      result.push(stack.length);
    } else {
      result.push(stack.length);
    }
  }
  return stack.length === 0 ? result : null;
}

/** 本体の開き波括弧の直前に来られない字句。ここに続く`{`は型の波括弧として読む。 */
const TYPE_CONTINUATION: ReadonlySet<string> = new Set([
  ":",
  "|",
  "&",
  "<",
  ",",
  "(",
  "[",
  "=>",
  "?",
  "extends",
  "keyof",
  "typeof",
  "is",
  "asserts",
  "infer",
  "readonly",
  "unique",
  "in",
  "out",
]);

/** 戻り値の型の後ろの、本体の開き波括弧の位置。見つからないときはnull。 */
function findBody(tokens: readonly Token[], from: number): number | null {
  let paren = 0;
  let bracket = 0;
  let angle = 0;
  let brace = 0;
  for (let index = from; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      return null;
    }
    const text = token.kind === "punct" ? token.text : "";
    const previous = tokens[index - 1]?.text ?? "";
    const flat = paren === 0 && bracket === 0 && angle === 0 && brace === 0;
    if (text === "{") {
      if (flat && !TYPE_CONTINUATION.has(previous)) {
        return index;
      }
      brace += 1;
    } else if (text === "}") {
      brace -= 1;
    } else if (text === "(") {
      paren += 1;
    } else if (text === ")") {
      paren -= 1;
    } else if (text === "[") {
      bracket += 1;
    } else if (text === "]") {
      bracket -= 1;
    } else if (text === "<") {
      angle += 1;
    } else if (text === ">") {
      angle = Math.max(0, angle - 1);
    } else if (text === ";" && flat) {
      return null;
    }
    if (paren < 0 || bracket < 0 || brace < 0) {
      return null;
    }
  }
  return null;
}

/** `open`の位置の括弧に対応する閉じ括弧の位置。 */
function findClosing(
  tokens: readonly Token[],
  depth: readonly number[],
  open: number,
): number | null {
  const level = depth[open];
  for (let index = open + 1; index < tokens.length; index += 1) {
    if (depth[index] === level && tokens[index]?.kind === "punct") {
      return index;
    }
  }
  return null;
}

/** 型引数の山括弧の閉じの位置。`open`は`<`の位置。 */
function findAngleClosing(
  tokens: readonly Token[],
  open: number,
): number | null {
  let angle = 0;
  for (let index = open; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== "punct") {
      continue;
    }
    if (token.text === "<") {
      angle += 1;
    } else if (token.text === ">") {
      angle -= 1;
      if (angle === 0) {
        return index;
      }
    }
  }
  return null;
}

function joined(tokens: readonly Token[], from: number, to: number): string {
  return tokens
    .slice(from, to)
    .map((token) => token.text)
    .join(" ");
}

type MainFound = { readonly signature: string } | "none" | "ambiguous";

/**
 * `export`の宣言の頭に`name`が現れるか。`export const main`、`export default function main`、`export { main }`などである。
 * 頭は、`export`の次から、`=`、`(`、`;`、または12字句までを見る。改行では打ち切らない。
 * `{`で始まるときは、閉じ波括弧までを見る。
 * exportしない同名の局所変数は、`schema`に関わらないので数えない。
 */
function exportsNameElsewhere(
  tokens: readonly Token[],
  depth: readonly number[],
  name: string,
): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    if (depth[index] !== 0 || tokens[index]?.text !== "export") {
      continue;
    }
    const braced = tokens[index + 1]?.text === "{";
    const limit = braced
      ? (findClosing(tokens, depth, index + 1) ?? tokens.length)
      : Math.min(tokens.length, index + 12);
    for (let cursor = index + 1; cursor <= limit; cursor += 1) {
      const token = tokens[cursor];
      if (token === undefined) {
        break;
      }
      const ends =
        !braced &&
        (token.text === "=" || token.text === "(" || token.text === ";");
      if (ends) {
        break;
      }
      if (token.kind === "word" && token.text === name) {
        return true;
      }
    }
  }
  return false;
}

/**
 * トップレベルの`export (async )?function <name>`を探し、本体の前までを返す。
 * 見つからず、`name`という語が別の形でexportされるとき(変数、既定のexportなど)と、2つ以上あるとき、
 * exportの付かない`function <name>`があるとき、本体の位置を決められないときは、決められないものとして返す。
 * exportの付かない`main`も、Windmillは`.script.yaml`の`schema`の元にするので、見落とさない。
 */
function findExported(
  tokens: readonly Token[],
  depth: readonly number[],
  name: string,
): MainFound {
  const starts: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (depth[index] !== 0 || tokens[index]?.text !== "export") {
      continue;
    }
    let cursor = index + 1;
    if (tokens[cursor]?.text === "async") {
      cursor += 1;
    }
    if (
      tokens[cursor]?.text === "function" &&
      tokens[cursor + 1]?.text === name &&
      tokens[cursor + 1]?.kind === "word"
    ) {
      starts.push(index);
    }
  }
  const declared = tokens.filter((token, index) => {
    if (depth[index] !== 0 || token.text !== "function") {
      return false;
    }
    const nameAt = tokens[index + 1]?.text === "*" ? index + 2 : index + 1;
    return tokens[nameAt]?.text === name;
  }).length;
  if (declared > starts.length) {
    return "ambiguous";
  }
  if (starts.length === 0) {
    return exportsNameElsewhere(tokens, depth, name) ? "ambiguous" : "none";
  }
  const [start] = starts;
  if (starts.length > 1 || start === undefined) {
    return "ambiguous";
  }
  let cursor = start + 1;
  if (tokens[cursor]?.text === "async") {
    cursor += 1;
  }
  cursor += 2;
  if (tokens[cursor]?.text === "<") {
    const closing = findAngleClosing(tokens, cursor);
    if (closing === null) {
      return "ambiguous";
    }
    cursor = closing + 1;
  }
  if (tokens[cursor]?.text !== "(") {
    return "ambiguous";
  }
  const closing = findClosing(tokens, depth, cursor);
  if (closing === null) {
    return "ambiguous";
  }
  cursor = closing + 1;
  let body: number | null;
  if (tokens[cursor]?.text === ":") {
    body = findBody(tokens, cursor + 1);
  } else {
    body = tokens[cursor]?.text === "{" ? cursor : null;
  }
  if (body === null) {
    return "ambiguous";
  }
  return { signature: joined(tokens, start, body) };
}

const DECLARATION_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "interface",
  "enum",
  "class",
]);
/** `declare`の後ろに来て、新しい文が始まることを示す語。 */
const DECLARE_TARGETS: ReadonlySet<string> = new Set([
  "const",
  "let",
  "var",
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "namespace",
  "module",
  "global",
  "abstract",
]);
const DECLARATION_PREFIXES: ReadonlySet<string> = new Set([
  "export",
  "declare",
  "abstract",
  "default",
  "const",
]);
/** 改行の後に来たら、型の別名が終わったとみなす、文の先頭の語。 */
const STATEMENT_START: ReadonlySet<string> = new Set([
  "export",
  "import",
  "const",
  "let",
  "var",
  "function",
  "async",
  "class",
  "interface",
  "type",
  "enum",
  "declare",
  "abstract",
  "namespace",
  "module",
  "if",
  "for",
  "while",
  "do",
  "switch",
  "try",
  "return",
  "throw",
]);

function isDeclarationAt(tokens: readonly Token[], index: number): boolean {
  const token = tokens[index];
  if (token?.kind !== "word" || !DECLARATION_KEYWORDS.has(token.text)) {
    return false;
  }
  if (tokens[index - 1]?.text === ".") {
    return false;
  }
  const name = tokens[index + 1];
  if (name?.kind !== "word") {
    return false;
  }
  if (token.text !== "type") {
    return true;
  }
  const after = tokens[index + 2]?.text;
  return after === "=" || after === "<";
}

/** 宣言の範囲を数える仕事量の上限。入力が仕事量を2乗にできないようにする。 */
const MAX_DECLARATION_STEPS = 2_000_000;

type StepBudget = { remaining: number };

/** 続きの行の先頭に来たとき、型の別名の終わりを示す文の先頭の語か。型の続きになりうる形は、終わりとみなさない。 */
function startsStatement(tokens: readonly Token[], index: number): boolean {
  const token = tokens[index];
  if (token?.kind !== "word" || !STATEMENT_START.has(token.text)) {
    return false;
  }
  const next = tokens[index + 1]?.text;
  switch (token.text) {
    case "abstract":
      return next === "class";
    case "declare":
      return next !== undefined && DECLARE_TARGETS.has(next);
    case "import":
      return next !== "(";
    case "type":
    case "interface":
    case "enum":
    case "class":
      return isDeclarationAt(tokens, index);
    default:
      return true;
  }
}

/**
 * 宣言の終わりの次の位置。決められないときはnull。
 * `interface`、`enum`、`class`は、本体の閉じ波括弧までである。本体の開き波括弧は、`<>`の入れ子の外にある最初の`{`とする。
 * `type`は、`;`か、文の先頭の語(`startsStatement`)までである。
 * 数える字句の数を`budget`で減らし、尽きたらnullを返す。
 */
function endOfDeclaration(
  tokens: readonly Token[],
  depth: readonly number[],
  keyword: number,
  budget: StepBudget,
): number | null {
  if (tokens[keyword]?.text !== "type") {
    let angle = 0;
    for (let index = keyword + 1; index < tokens.length; index += 1) {
      budget.remaining -= 1;
      if (budget.remaining < 0) {
        return null;
      }
      const token = tokens[index];
      if (depth[index] !== 0 || token === undefined) {
        continue;
      }
      if (token.kind === "punct" && token.text === "<") {
        angle += 1;
      } else if (token.kind === "punct" && token.text === ">") {
        angle = Math.max(0, angle - 1);
      } else if (token.text === "{" && angle === 0) {
        const closing = findClosing(tokens, depth, index);
        return closing === null ? null : closing + 1;
      }
    }
    return null;
  }
  for (let index = keyword + 1; index < tokens.length; index += 1) {
    budget.remaining -= 1;
    if (budget.remaining < 0) {
      return null;
    }
    const token = tokens[index];
    if (depth[index] !== 0 || token === undefined) {
      continue;
    }
    if (token.kind === "punct" && token.text === ";") {
      return index + 1;
    }
    if (token.newline && startsStatement(tokens, index)) {
      return index;
    }
  }
  return tokens.length;
}

function collectDeclarations(
  tokens: readonly Token[],
  depth: readonly number[],
): string[] | null {
  const found: string[] = [];
  const budget: StepBudget = { remaining: MAX_DECLARATION_STEPS };
  for (let index = 0; index < tokens.length; index += 1) {
    if (depth[index] !== 0 || !isDeclarationAt(tokens, index)) {
      continue;
    }
    let start = index;
    while (
      start > 0 &&
      DECLARATION_PREFIXES.has(tokens[start - 1]?.text ?? "") &&
      depth[start - 1] === 0
    ) {
      start -= 1;
    }
    const end = endOfDeclaration(tokens, depth, index, budget);
    if (end === null) {
      return null;
    }
    found.push(joined(tokens, start, end));
  }
  return found.sort();
}

/**
 * scriptの形。
 * `main`と`preprocessor`の署名(無ければnull)、トップレベルの型宣言の文(ソート済み)、
 * Windmillの注釈に見えるコメント行(ソート済み)である。
 */
export type SourceShape = {
  readonly main: string | null;
  readonly preprocessor: string | null;
  readonly declarations: readonly string[];
  readonly annotations: readonly string[];
};

/**
 * Windmillの注釈に見えるコメント行。`//npm`、`//nodejs`、`//native`、`// package_json: x`、`//extra_requirements: y`などである。
 * 注釈は、依存の解決やworkerの種類を変える。どの注釈が効くかはWindmillの版で変わるので、形だけで拾い、
 * 文章のコメント(空白で区切った複数の語)は拾わない。ファイルのどこにあっても拾う。
 */
const ANNOTATION_LINE = /^\s*\/\/\s*[A-Za-z_][\w-]*(?:\s*:.*)?\s*$/;

// 注釈の値が次の行以降に続く形。コメント行である。
const COMMENT_LINE = /^\s*\/\//;

/**
 * 注釈に見えるコメント行を集める。`:`で終わる行と、`:`の後に値がある行には、
 * 続くコメント行(空行とコード行で終わる)も、注釈の値として集める。
 * 値を複数行に書く注釈(`//extra_package_json:`など)の中身を、見落とさないためである。
 */
function readAnnotations(code: string): string[] {
  const collected: string[] = [];
  let continuing = false;
  for (const line of code.split(/\r\n|[\n\r]/)) {
    const isAnnotation = ANNOTATION_LINE.test(line);
    if (isAnnotation || (continuing && COMMENT_LINE.test(line))) {
      collected.push(line.trim());
      continuing = isAnnotation ? line.includes(":") : continuing;
    } else {
      continuing = false;
    }
  }
  return collected.sort();
}

/** 字句の入れ子(テンプレートの`${}`)の深さの上限。呼び出しの再帰を有界にする。 */
const MAX_NESTING = 64;

export type ShapeResult =
  | { readonly ok: true; readonly shape: SourceShape }
  | { readonly ok: false; readonly reason: "unparsable" };

/**
 * ソースの`main`と`preprocessor`の署名、トップレベルの型宣言、注釈のコメント行を読む。
 * 署名は、`export`から本体の開き波括弧の前までの字句を、コメントと空白の違いを除いて1つの文字列にしたものである。
 * 引数の既定値も含むので、`schema`の`default`が変わるときも署名が変わる。
 * 読めないのは次のときで、いずれも`unparsable`を返す。
 * - 文字列、テンプレート、コメント、正規表現が閉じない。判断できない`/`がある。括弧が対応しない。
 * - `main`か`preprocessor`が`export function`以外の形でexportされる。同名が2つ以上ある。本体の位置を決められない。
 * - テンプレートの入れ子が深すぎる。字句に分ける処理が例外を投げる。
 * - 型宣言の範囲を決められない。
 */
export function readSourceShape(code: string): ShapeResult {
  try {
    return readShape(code);
  } catch {
    return { ok: false, reason: "unparsable" };
  }
}

function readShape(code: string): ShapeResult {
  const scanned = scan(code, 0, false, 0);
  if (scanned === null) {
    return { ok: false, reason: "unparsable" };
  }
  const depth = depths(scanned.tokens);
  if (depth === null) {
    return { ok: false, reason: "unparsable" };
  }
  const main = findExported(scanned.tokens, depth, "main");
  const preprocessor = findExported(scanned.tokens, depth, "preprocessor");
  if (main === "ambiguous" || preprocessor === "ambiguous") {
    return { ok: false, reason: "unparsable" };
  }
  const declarations = collectDeclarations(scanned.tokens, depth);
  if (declarations === null) {
    return { ok: false, reason: "unparsable" };
  }
  return {
    ok: true,
    shape: {
      main: main === "none" ? null : main.signature,
      preprocessor: preprocessor === "none" ? null : preprocessor.signature,
      declarations,
      annotations: readAnnotations(code),
    },
  };
}

export type ShapeChange =
  | "annotation_changed"
  | "main_presence_changed"
  | "main_changed"
  | "preprocessor_changed"
  | "declaration_changed";

export type ShapeDiff =
  | { readonly ok: true; readonly change: ShapeChange | null }
  | { readonly ok: false; readonly reason: "unparsable" };

/**
 * 2つのソースの形を比べる。どちらかが読めなければ`unparsable`を返す。
 * 違いが無ければ`change`はnull。注釈、`main`の有無、`main`の署名、`preprocessor`、型宣言のどれが違うかを返す。
 * 型宣言は、`main`と`preprocessor`のどちらかがあるファイルだけで比べる。
 * どちらも無いファイル(lib)の型宣言は、`.script.yaml`を変えないことを実機で確かめた。
 */
export function diffSourceShape(base: string, head: string): ShapeDiff {
  const before = readSourceShape(base);
  const after = readSourceShape(head);
  if (!before.ok || !after.ok) {
    return { ok: false, reason: "unparsable" };
  }
  if (
    before.shape.annotations.join("\n") !== after.shape.annotations.join("\n")
  ) {
    return { ok: true, change: "annotation_changed" };
  }
  if ((before.shape.main === null) !== (after.shape.main === null)) {
    return { ok: true, change: "main_presence_changed" };
  }
  if (before.shape.main !== after.shape.main) {
    return { ok: true, change: "main_changed" };
  }
  if (before.shape.preprocessor !== after.shape.preprocessor) {
    return { ok: true, change: "preprocessor_changed" };
  }
  const hasEntryPoint =
    before.shape.main !== null || before.shape.preprocessor !== null;
  if (
    hasEntryPoint &&
    before.shape.declarations.join("\n") !== after.shape.declarations.join("\n")
  ) {
    return { ok: true, change: "declaration_changed" };
  }
  return { ok: true, change: null };
}
