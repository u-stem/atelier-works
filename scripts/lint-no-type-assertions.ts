#!/usr/bin/env bun
// TypeScriptの型アサーション(`expr as Type`と`<Type>expr`)を禁止する。
// 例外は`as const`と、ユーザー定義の型ガード関数(戻り値の型が型述語の関数。
// 例: `function isFoo(v: unknown): v is Foo { ... }`)の本体の中だけ。
//
// 実装の注意: TypeScript 7の`typescript`パッケージには、従来の同期パーサー
// (`ts.createSourceFile`と`ts.isXxx`のノードガード)が無い。完全なASTは
// ネイティブのProject/Program/CheckerのIPC API(`typescript/unstable/sync`)
// からしか得られず、ネイティブのコンパイラのプロセスを起動するので、
// 小さく速いlintには向かない。そこで`typescript/unstable/ast`が公開する
// 純粋JSのトークナイザ(`createScanner`)を使い、トークン単位の
// ヒューリスティックでアサーションと型ガード関数の本体を見つける。
// 完全な構文解析ではないので、まれな入力(コロンの直後のジェネリックな
// 関数「型」の注釈、例えば`const f: <T>(v: T) => T = ...`)では理論上
// 誤検知しうる。このリポジトリのアプリケーションコードではまれである。
// 同じ理由で、入れ子のジェネリクスでスキャナーが別々の`>`ではなく
// `>>`・`>>>`を1トークンで返す場合(例: `Array<Array<Foo>>`)も対象外。
//
// `tokenize`は、スキャナーの2つの落とし穴を明示的に処理する。テンプレート
// リテラルの続き(`${`の置換の後の`}...`)と正規表現リテラルは、どちらも
// 再スキャンが要る。単純な`scan()`のループでは中身を普通のコードとして
// 扱ってしまうため。正規表現は誤検知だけでなく停止性の問題でもある。
// TypeScript 7の純粋JSのスキャナーは、識別子が続かない`#`
// (例: `/#(\d+)/`の`#(`)から先へ進まず、正規表現の本体をコードとして
// 読むと`scan()`が同じトークンを返し続け、プロセスが際限なく膨らむ。
// そのため`tokenize`は、スキャナーが進まなくなったらエラーで中断する。

import {
  computeLineStarts,
  createScanner,
  LanguageVariant,
  SyntaxKind,
} from "typescript/unstable/ast";

export type Finding = {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
};

/**
 * 引数が無いときに検査するファイル。
 * `.tsx`は含めない。このスキャナーはJSXの本文を通常のコードとして読み、
 * 本文の"as"などを誤検知するため。
 */
export const DEFAULT_GLOBS: readonly string[] = [
  "f/**/*.ts",
  "tests/**/*.ts",
  "scripts/**/*.ts",
  "console/*.ts",
  "console/src/**/*.ts",
  "console/scripts/**/*.ts",
  "infra/console_fetcher/**/*.ts",
];

export type Token = {
  readonly kind: number;
  readonly start: number;
  readonly text: string;
};

/**
 * 式を終えられるトークンの集合。直前のトークンがこの集合に無ければ、続く`/`は
 * 除算ではなく正規表現リテラルの始まりなので、正規表現として再スキャンする。
 * 式を終えられるのは、識別子、リテラル、閉じ括弧、`this`・`super`・`true`・
 * `false`・`null`、後置の`++`・`--`だけ。
 * 閉じ波括弧は意図して入れていない。トークン単位では、ブロック文を閉じる`}`
 * (後の`/`は正規表現)とオブジェクトリテラルを閉じる`}`(後の`/`は除算)を
 * 見分けられず、実際のコードでは前者がずっと多いため。
 * したがって、オブジェクトリテラルを直接割る式(`{ a: 1 } / 2`)の誤った
 * トークン化は、入れ子のジェネリクスと同じく既知の制限として受け入れる。
 */
const EXPRESSION_END_TOKENS = new Set<number>([
  SyntaxKind.Identifier,
  SyntaxKind.PrivateIdentifier,
  SyntaxKind.StringLiteral,
  SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateTail,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.CloseParenToken,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.ThisKeyword,
  SyntaxKind.SuperKeyword,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.PlusPlusToken,
  SyntaxKind.MinusMinusToken,
]);

function isRegularExpressionStart(
  kind: number,
  previousKind: number | undefined,
): boolean {
  if (kind !== SyntaxKind.SlashToken && kind !== SyntaxKind.SlashEqualsToken) {
    return false;
  }
  return previousKind === undefined || !EXPRESSION_END_TOKENS.has(previousKind);
}

/**
 * スキャナーが進まずにトークンを返したときに`tokenize`が投げる例外
 * (理由はファイル冒頭を参照)。呼び出し側が止まらずに`file:line:column`の
 * 位置を報告できるよう、ソース上のオフセットを持つ。
 */
export class ScannerStallError extends Error {
  readonly position: number;
  constructor(position: number, kind: number) {
    super(
      `scanner made no progress at offset ${position} (token kind ${kind}); the file could not be tokenized`,
    );
    this.name = "ScannerStallError";
    this.position = position;
  }
}

/**
 * ソースをトークン列に分割する。コメント・空白・改行は`skipTrivia`で読み飛ばす
 * ため、トークン列にはコードだけが残る(JSDocも同様)。`text`はソース上の
 * 表記で、コメント以外の差分検査(`check-comment-only-diff.ts`)が比較に使う。
 */
export function tokenize(sourceText: string): Token[] {
  const scanner = createScanner(true, LanguageVariant.Standard, sourceText);
  const tokens: Token[] = [];
  // 開いているテンプレートの置換ごとに、`${`からの波括弧の深さを持つ
  // (入れ子のテンプレートリテラル1つにつき1要素)。単純な`scan()`のループは
  // テンプレートの`}...`の続き(任意の文字を含み、裸の`as`もありうる)を
  // 普通のコードとして扱う。そのため、置換の式そのものを閉じる`}`(深さ0。
  // 中のオブジェクトリテラルやブロックを閉じる`}`ではないもの)は
  // `reScanTemplateToken`で再スキャンし、本来のTemplateMiddle・TemplateTailの
  // トークンを得る。そうしないと以降がすべて誤ってトークン化され、
  // 例えば`` `${x} treat it as data` ``の中の"as"が`as`キーワードとして読まれ、
  // 型アサーションと誤検知される。
  const templateSubstitutionDepths: number[] = [];

  let previousKind: number | undefined;
  let previousEnd = -1;
  let kind = scanner.scan();
  while (kind !== SyntaxKind.EndOfFile) {
    if (isRegularExpressionStart(kind, previousKind)) {
      kind = scanner.reScanSlashToken();
    }
    // トークンごとにスキャナーが必ず進んでいることを確かめる。進まないと、
    // ここで1周ごとにトークンを確保しながら永遠に回る。
    if (scanner.getTokenEnd() <= previousEnd) {
      throw new ScannerStallError(scanner.getTokenStart(), kind);
    }
    previousEnd = scanner.getTokenEnd();
    if (kind === SyntaxKind.TemplateHead) {
      templateSubstitutionDepths.push(0);
    } else if (templateSubstitutionDepths.length > 0) {
      const topIndex = templateSubstitutionDepths.length - 1;
      const depth = templateSubstitutionDepths[topIndex] ?? 0;
      if (kind === SyntaxKind.OpenBraceToken) {
        templateSubstitutionDepths[topIndex] = depth + 1;
      } else if (kind === SyntaxKind.CloseBraceToken) {
        if (depth === 0) {
          kind = scanner.reScanTemplateToken(false);
          // 再スキャンで1文字の`}`がテンプレートの続きに置き換わるので、
          // 新しいトークンの終端で進行の検査をやり直す
          // (上の検査は裸の`}`しか見ていない)。
          if (scanner.getTokenEnd() <= previousEnd - 1) {
            throw new ScannerStallError(scanner.getTokenStart(), kind);
          }
          previousEnd = scanner.getTokenEnd();
          if (kind === SyntaxKind.TemplateTail) {
            templateSubstitutionDepths.pop();
          }
        } else {
          templateSubstitutionDepths[topIndex] = depth - 1;
        }
      }
    }
    tokens.push({
      kind,
      start: scanner.getTokenStart(),
      text: scanner.getTokenText(),
    });
    previousKind = kind;
    kind = scanner.scan();
  }
  return tokens;
}

/**
 * 直後の`<`が二項演算子・比較演算子になりえないトークン。
 * これらの後に続く`<...>`は、型アサーションの始まりとみなせる。
 */
const EXPRESSION_EXPECTED_BEFORE_ANGLE_BRACKET = new Set<number>([
  SyntaxKind.EqualsToken,
  SyntaxKind.OpenParenToken,
  SyntaxKind.OpenBracketToken,
  SyntaxKind.CommaToken,
  SyntaxKind.ColonToken,
  SyntaxKind.QuestionToken,
  SyntaxKind.ReturnKeyword,
  SyntaxKind.TypeOfKeyword,
  SyntaxKind.VoidKeyword,
  SyntaxKind.DeleteKeyword,
  SyntaxKind.AwaitKeyword,
  SyntaxKind.YieldKeyword,
  SyntaxKind.EqualsGreaterThanToken,
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
  SyntaxKind.ExclamationToken,
  SyntaxKind.SemicolonToken,
]);

/** `<Type>`の直後で、キャストされる式を始めうるトークン。 */
const EXPRESSION_START_TOKENS = new Set<number>([
  SyntaxKind.Identifier,
  SyntaxKind.OpenParenToken,
  SyntaxKind.ThisKeyword,
  SyntaxKind.StringLiteral,
  SyntaxKind.NumericLiteral,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.OpenBracketToken,
  SyntaxKind.ExclamationToken,
  SyntaxKind.MinusToken,
  SyntaxKind.PlusToken,
]);

/**
 * `openIndex`の`<`を閉じる`>`の位置を返す。
 * 先に文やブロックの境界に当たったら`undefined`を返す。
 */
function findMatchingGreaterThanIndex(
  tokens: readonly Token[],
  openIndex: number,
): number | undefined {
  let depth = 0;
  for (let i = openIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) return undefined;
    if (
      token.kind === SyntaxKind.SemicolonToken ||
      token.kind === SyntaxKind.OpenBraceToken ||
      token.kind === SyntaxKind.CloseBraceToken
    ) {
      return undefined;
    }
    if (token.kind === SyntaxKind.LessThanToken) {
      depth++;
    } else if (token.kind === SyntaxKind.GreaterThanToken) {
      if (depth === 0) return i;
      depth--;
    }
  }
  return undefined;
}

/**
 * `openIndex`の`(`を閉じる`)`の位置を返す。見つからなければ`undefined`。
 * `<`・`>`と違い丸括弧はあいまいさが無いので、単純に深さを数える。
 */
function findMatchingCloseParenIndex(
  tokens: readonly Token[],
  openIndex: number,
): number | undefined {
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) return undefined;
    if (token.kind === SyntaxKind.OpenParenToken) {
      depth++;
    } else if (token.kind === SyntaxKind.CloseParenToken) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return undefined;
}

/**
 * `closeAngleIndex`で閉じる`<...>`が、ジェネリックなアロー関数の型引数の
 * 並びかを返す。`<...>`の直後に`(...)`が続く形は、括弧付きの式の型アサーション
 * (`<Foo>(expr)`)か、アロー関数の型引数と引数の並び(`<T>(x: T) => x`。
 * `=>`の前に戻り値の型注釈が入ることもある)かがあいまいなため。
 * 対応する`)`の後に、最上位の`=>`があるかで見分ける
 * (間にある`: ReturnType`は読み飛ばす)。
 */
function isGenericArrowFunctionTypeParams(
  tokens: readonly Token[],
  closeAngleIndex: number,
): boolean {
  const openParen = tokens[closeAngleIndex + 1];
  if (openParen === undefined || openParen.kind !== SyntaxKind.OpenParenToken) {
    return false;
  }

  const closeParenIndex = findMatchingCloseParenIndex(
    tokens,
    closeAngleIndex + 1,
  );
  if (closeParenIndex === undefined) return false;

  const afterParen = tokens[closeParenIndex + 1];
  if (afterParen === undefined) return false;
  if (afterParen.kind === SyntaxKind.EqualsGreaterThanToken) return true;
  if (afterParen.kind !== SyntaxKind.ColonToken) return false;

  // 戻り値の型注釈を読み飛ばし、最上位の`=>`を探す。
  let depth = 0;
  for (let i = closeParenIndex + 2; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) return false;
    if (depth === 0) {
      if (token.kind === SyntaxKind.EqualsGreaterThanToken) return true;
      if (
        token.kind === SyntaxKind.SemicolonToken ||
        token.kind === SyntaxKind.CloseBraceToken
      ) {
        return false;
      }
    }
    if (
      token.kind === SyntaxKind.OpenParenToken ||
      token.kind === SyntaxKind.OpenBracketToken ||
      token.kind === SyntaxKind.OpenBraceToken ||
      token.kind === SyntaxKind.LessThanToken
    ) {
      depth++;
    } else if (
      token.kind === SyntaxKind.CloseParenToken ||
      token.kind === SyntaxKind.CloseBracketToken ||
      token.kind === SyntaxKind.CloseBraceToken ||
      token.kind === SyntaxKind.GreaterThanToken
    ) {
      depth--;
    }
  }
  return false;
}

const OPEN_BRACKET_KINDS = new Set<number>([
  SyntaxKind.OpenBraceToken,
  SyntaxKind.OpenParenToken,
  SyntaxKind.OpenBracketToken,
]);
const CLOSE_BRACKET_KINDS = new Set<number>([
  SyntaxKind.CloseBraceToken,
  SyntaxKind.CloseParenToken,
  SyntaxKind.CloseBracketToken,
]);

/**
 * トークンごとに、そのトークンを囲むユーザー定義の型ガード関数の本体の
 * 入れ子の深さを返す(0は本体の外)。
 * ブロックの本体(`(...): v is Foo { ... }`)と、簡潔なアロー関数の本体
 * (`(...): v is Foo => expr`)の両方を扱う。簡潔な本体には自前の波括弧が
 * 無いので、括弧の深さで終わりを判断する。本体が始まったのと同じ深さで
 * 最初のカンマかセミコロンが来るか、外側の括弧が閉じたら終わりとする。
 */
function computeTypeGuardDepths(tokens: readonly Token[]): number[] {
  const depths: number[] = new Array(tokens.length).fill(0);
  const braceIsTypeGuardBody: boolean[] = [];
  let depth = 0;
  let generalDepth = 0;
  let awaitingReturnTypeColon = false;
  let inReturnTypeAnnotation = false;
  let nextBraceIsTypeGuardBody = false;
  let conciseGuardBaseDepth: number | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;

    // このトークン自身の括弧の効果を反映する前に、簡潔な(波括弧の無い)
    // 型ガードの本体を閉じる。境界のトークンを本体に含めないため。
    if (conciseGuardBaseDepth !== undefined) {
      const closesEnclosingBracket =
        CLOSE_BRACKET_KINDS.has(token.kind) &&
        generalDepth <= conciseGuardBaseDepth;
      const separatesAtSameDepth =
        (token.kind === SyntaxKind.CommaToken ||
          token.kind === SyntaxKind.SemicolonToken) &&
        generalDepth === conciseGuardBaseDepth;
      if (closesEnclosingBracket || separatesAtSameDepth) {
        depth--;
        conciseGuardBaseDepth = undefined;
      }
    }

    if (token.kind === SyntaxKind.CloseParenToken) {
      awaitingReturnTypeColon = true;
    } else if (awaitingReturnTypeColon) {
      awaitingReturnTypeColon = false;
      inReturnTypeAnnotation = token.kind === SyntaxKind.ColonToken;
      nextBraceIsTypeGuardBody = false;
    } else if (inReturnTypeAnnotation) {
      if (token.kind === SyntaxKind.IsKeyword) {
        nextBraceIsTypeGuardBody = true;
      } else if (token.kind === SyntaxKind.SemicolonToken) {
        inReturnTypeAnnotation = false;
        nextBraceIsTypeGuardBody = false;
      }
    }

    if (token.kind === SyntaxKind.OpenBraceToken) {
      const isTypeGuardBody =
        inReturnTypeAnnotation && nextBraceIsTypeGuardBody;
      braceIsTypeGuardBody.push(isTypeGuardBody);
      if (isTypeGuardBody) depth++;
      inReturnTypeAnnotation = false;
      nextBraceIsTypeGuardBody = false;
    } else if (token.kind === SyntaxKind.CloseBraceToken) {
      const wasTypeGuardBody = braceIsTypeGuardBody.pop() ?? false;
      if (wasTypeGuardBody) depth--;
    } else if (
      token.kind === SyntaxKind.EqualsGreaterThanToken &&
      inReturnTypeAnnotation &&
      nextBraceIsTypeGuardBody
    ) {
      const next = tokens[i + 1];
      if (next === undefined || next.kind !== SyntaxKind.OpenBraceToken) {
        // 簡潔なアロー関数の本体。型ガードは、今の括弧の深さから始まる
        // 後続の式に及ぶ。
        depth++;
        conciseGuardBaseDepth = generalDepth;
      }
      inReturnTypeAnnotation = false;
      nextBraceIsTypeGuardBody = false;
    }

    if (OPEN_BRACKET_KINDS.has(token.kind)) {
      generalDepth++;
    } else if (CLOSE_BRACKET_KINDS.has(token.kind)) {
      generalDepth--;
    }

    depths[i] = depth;
  }

  return depths;
}

function positionToLineAndColumn(
  lineStarts: readonly number[],
  position: number,
): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const start = lineStarts[mid];
    if (start !== undefined && start <= position) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  const lineStart = lineStarts[low] ?? 0;
  return { line: low + 1, column: position - lineStart + 1 };
}

export function findTypeAssertions(
  fileName: string,
  sourceText: string,
): Finding[] {
  const lineStarts = computeLineStarts(sourceText);
  let tokens: Token[];
  try {
    tokens = tokenize(sourceText);
  } catch (err) {
    if (err instanceof ScannerStallError) {
      const { line, column } = positionToLineAndColumn(
        lineStarts,
        err.position,
      );
      throw new Error(`${fileName}:${line}:${column} ${err.message}`);
    }
    throw err;
  }
  const typeGuardDepths = computeTypeGuardDepths(tokens);
  const findings: Finding[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;
    if ((typeGuardDepths[i] ?? 0) > 0) continue;

    if (token.kind === SyntaxKind.AsKeyword) {
      const next = tokens[i + 1];
      if (next !== undefined && next.kind === SyntaxKind.ConstKeyword) continue;
      // `import * as name`・`export * as name`は名前空間の束縛で、型アサーション
      // ではない。正しい構文で`* as`が現れるのはここだけ。
      const previous = i > 0 ? tokens[i - 1] : undefined;
      if (previous !== undefined && previous.kind === SyntaxKind.AsteriskToken)
        continue;
      const { line, column } = positionToLineAndColumn(lineStarts, token.start);
      findings.push({
        file: fileName,
        line,
        column,
        message:
          "Unexpected type assertion (`as`). Use a type guard or Parse-don't-validate instead.",
      });
      continue;
    }

    if (token.kind === SyntaxKind.LessThanToken) {
      const previous = i > 0 ? tokens[i - 1] : undefined;
      const isExpressionContext =
        previous === undefined ||
        EXPRESSION_EXPECTED_BEFORE_ANGLE_BRACKET.has(previous.kind);
      if (!isExpressionContext) continue;

      const closeIndex = findMatchingGreaterThanIndex(tokens, i);
      if (closeIndex === undefined) continue;

      if (isGenericArrowFunctionTypeParams(tokens, closeIndex)) continue;

      const after = tokens[closeIndex + 1];
      if (after === undefined || !EXPRESSION_START_TOKENS.has(after.kind))
        continue;

      const { line, column } = positionToLineAndColumn(lineStarts, token.start);
      findings.push({
        file: fileName,
        line,
        column,
        message:
          "Unexpected type assertion (`<Type>expr`). Use `as Type` sparingly or a type guard instead.",
      });
    }
  }

  return findings;
}

/**
 * パスが`node_modules`の下にあるかを返す。
 * `Bun.Glob.scan`は(ripgrepなどと違い)`.gitignore`や`node_modules`を
 * 考慮しない。`wmill app lint`・`wmill app dev`がraw appのフロントエンドの
 * 依存を入れると`f/**`の下に`node_modules`ができ、そのままでは
 * サードパーティの`.d.ts`が`f/`配下のglobに拾われて誤検知する
 * (このリポジトリのコードではなく、gitignore済みでもある)。
 */
function isUnderNodeModules(path: string): boolean {
  return path.split("/").includes("node_modules");
}

async function collectDefaultFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const pattern of DEFAULT_GLOBS) {
    const glob = new Bun.Glob(pattern);
    for await (const file of glob.scan({
      cwd: process.cwd(),
      onlyFiles: true,
    })) {
      if (!isUnderNodeModules(file)) {
        files.push(file);
      }
    }
  }
  return files;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const targets = argv.length > 0 ? argv : await collectDefaultFiles();

  const allFindings: Finding[] = [];
  for (const file of targets) {
    const sourceText = await Bun.file(file).text();
    allFindings.push(...findTypeAssertions(file, sourceText));
  }

  if (allFindings.length > 0) {
    for (const finding of allFindings) {
      console.error(
        `${finding.file}:${finding.line}:${finding.column} ${finding.message}`,
      );
    }
    console.error(
      `\nFound ${allFindings.length} disallowed type assertion(s).`,
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
