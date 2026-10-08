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
// 完全な構文解析ではないので、まれな入力では誤検知・検知漏れがありうる。
// `.ts`では、`<Type>expr`の検査が式の位置の`<`の読み分けを誤ることがある。
//
// `.tsx`も対象にする。`.tsx`ではスキャナーをJSXのモードにし、JSXの要素の
// タグ・本文・`{...}`を読み分ける(`tokenize`を参照)。本文・属性の文字列・
// 属性名の"as"は検出せず、`{...}`の中の`as`は検出する。`.tsx`には
// `<Type>expr`の構文が無いので、その検査はしない。コードをJSXと読み違えると
// 以降が検査から漏れるため、ファイルの終わりまでに閉じないJSXの要素は
// `UnclosedJsxError`として位置を報告し、黙って通さない。
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
 * `console/`は`node_modules`を歩かないよう、ソースのあるディレクトリだけを挙げる。
 */
export const DEFAULT_GLOBS: readonly string[] = [
  "f/**/*.{ts,tsx}",
  "tests/**/*.{ts,tsx}",
  "scripts/**/*.{ts,tsx}",
  "console/*.{ts,tsx}",
  "console/src/**/*.{ts,tsx}",
  "console/scripts/**/*.{ts,tsx}",
  "infra/console_fetcher/**/*.{ts,tsx}",
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
 * トークン化は、既知の制限として受け入れる。
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

/**
 * トークン`kind`が式を終えるかを返す。`EXPRESSION_END_TOKENS`に加え、
 * 次の2つも式を終える。
 * - `.`・`?.`の直後の名前。キーワードと同じ綴り(`r.from`・`a.default`)でも
 *   プロパティの名前なので、識別子と同じく扱う。
 * - 式の直後に改行を挟まず続く`!`。後置の非nullアサーション(`x!`)。
 * `previousKind`は直前のトークン、`previousEndsExpression`は直前の
 * トークンが式を終えたか。
 */
function endsExpression(
  kind: number,
  previousKind: number | undefined,
  previousEndsExpression: boolean,
  precededByLineBreak: boolean,
): boolean {
  if (EXPRESSION_END_TOKENS.has(kind)) return true;
  if (
    (previousKind === SyntaxKind.DotToken ||
      previousKind === SyntaxKind.QuestionDotToken) &&
    isIdentifierOrKeyword(kind)
  ) {
    return true;
  }
  return (
    kind === SyntaxKind.ExclamationToken &&
    previousEndsExpression &&
    !precededByLineBreak
  );
}

function isRegularExpressionStart(
  kind: number,
  previousEndsExpression: boolean,
): boolean {
  if (kind !== SyntaxKind.SlashToken && kind !== SyntaxKind.SlashEqualsToken) {
    return false;
  }
  return !previousEndsExpression;
}

/**
 * `tokenize`がソースを読み切れなかったときの例外。呼び出し側が止まらずに
 * `file:line:column`の位置を報告できるよう、ソース上のオフセットを持つ。
 */
export class TokenizeError extends Error {
  readonly position: number;
  constructor(position: number, message: string) {
    super(message);
    this.name = "TokenizeError";
    this.position = position;
  }
}

/**
 * スキャナーが進まずにトークンを返したときに`tokenize`が投げる例外
 * (理由はファイル冒頭を参照)。
 */
export class ScannerStallError extends TokenizeError {
  constructor(position: number, kind: number) {
    super(
      position,
      `scanner made no progress at offset ${position} (token kind ${kind}); the file could not be tokenized`,
    );
    this.name = "ScannerStallError";
  }
}

/**
 * `.tsx`で、ファイルの終わりまでにJSXの要素が閉じなかったときに`tokenize`が
 * 投げる例外。コードをJSXと読み違えると、それ以降はすべてJSXの本文として
 * 読まれ、検査から黙って漏れる。それを防ぐため、読み違いをエラーとして知らせる。
 * 位置は、閉じていない最も外側の要素の`<`。
 */
export class UnclosedJsxError extends TokenizeError {
  constructor(position: number) {
    super(
      position,
      "JSX element is not closed by the end of the file; the code may have been misread as JSX",
    );
    this.name = "UnclosedJsxError";
  }
}

/**
 * JSXの読み取り中の文脈。`tokenize`は、これを積んだスタックの先頭で
 * 次のトークンの読み方を決める。
 * - `tag`: `<`・`</`から`>`までのタグの中。名前は`-`を含みうるので
 *   `scanJsxIdentifier`で読み、`=`の後の値は`scanJsxAttributeValue`で読む
 *   (JSXの属性の文字列はエスケープを持たない)。`closing`は閉じタグか。
 *   `typeArgumentDepth`は、型引数(`<Foo<string> />`の`<string>`)の
 *   入れ子の深さ。型引数の中の`>`ではタグを閉じない。
 * - `children`: 開きタグと閉じタグの間。`scanJsxToken`で読み、本文は
 *   JsxTextの1トークンになる(本文の"as"を`as`キーワードと誤読しない)。
 * - `expression`: JSXの中の`{...}`。普通のコードとして読み、
 *   `braceDepth`で自分を閉じる`}`を見分ける。
 */
type JsxFrame =
  | {
      readonly kind: "tag";
      readonly closing: boolean;
      typeArgumentDepth: number;
    }
  | { readonly kind: "children" }
  | { kind: "expression"; braceDepth: number };

function isIdentifierOrKeyword(kind: number): boolean {
  return (
    kind === SyntaxKind.Identifier ||
    (kind >= SyntaxKind.FirstKeyword && kind <= SyntaxKind.LastKeyword)
  );
}

export type TokenizeOptions = {
  /** `.tsx`のときtrue。JSXの要素を読み分ける。 */
  readonly jsx?: boolean;
};

/**
 * ソースをトークン列に分割する。コメント・空白・改行は`skipTrivia`で読み飛ばす
 * ため、トークン列にはコードだけが残る(JSDocも同様)。`text`はソース上の
 * 表記で、コメント以外の差分検査(`check-comment-only-diff.ts`)が比較に使う。
 *
 * `jsx`のときは、式の位置の`<`の後に名前か`>`が続けばJSXの要素の始まりと
 * みなし、`JsxFrame`のスタックで要素の終わりまで読み分ける。次の`<`は
 * JSXとみなさない。
 * - ジェネリックなアロー関数の型引数。TypeScriptのパーサーと同じ規則で、
 *   `<T,`・`<T =`・`<const T,`・`<T extends U`の形を型引数とみなす。
 * - `<T>(...) =>`の形。型の位置のジェネリックな関数型
 *   (`type F = <T>(x: T) => T`・`const f: <T>(v: T) => T`)で、
 *   式の位置のこの形は`.tsx`ではコンパイルできない。
 * 次の入力は読み違える。
 * - 本文が`(...) =>`で始まる要素(`<b>(x) => y</b>`)。コードとして読む。
 * - 型の位置の呼び出しシグネチャ(`{ <T>(x: T): T }`)と、キーワードと同じ
 *   綴りの変数を`<`で比べる式(`const from = 1; from < max`)。JSXとして読む。
 * JSXとして読み違えた要素は、たいていファイルの終わりまで閉じないので
 * `UnclosedJsxError`になる。ただし、後ろの文字列リテラルなどにある`</`
 * (`"</a>"`)が読み違えた要素を閉じると、その間のコードは黙って検査から漏れる。
 */
export function tokenize(
  sourceText: string,
  options: TokenizeOptions = {},
): Token[] {
  const jsx = options.jsx ?? false;
  const scanner = createScanner(
    true,
    jsx ? LanguageVariant.JSX : LanguageVariant.Standard,
    sourceText,
  );
  const tokens: Token[] = [];
  const jsxFrames: JsxFrame[] = [];
  let previousKind: number | undefined;
  let previousEndsExpression = false;
  // 開いている最も外側のJSXの要素の`<`の位置。
  let jsxRootStart = 0;

  // `(`(今のトークン)に対応する`)`まで読み、その後に`=>`が続くかを返す。
  // 先読みの中だけで使う。
  const isFollowedByArrowAfterParens = (): boolean => {
    let depth = 1;
    let previousEnd = scanner.getTokenEnd();
    while (depth > 0) {
      const kind = scanner.scan();
      // 本文の中の`</`に当たったら関数型ではない。スキャナーが進まない
      // ときも、ここで永遠に回らないよう打ち切る。
      if (
        kind === SyntaxKind.EndOfFile ||
        kind === SyntaxKind.LessThanSlashToken ||
        scanner.getTokenEnd() <= previousEnd
      ) {
        return false;
      }
      previousEnd = scanner.getTokenEnd();
      if (kind === SyntaxKind.OpenParenToken) {
        depth++;
      } else if (kind === SyntaxKind.CloseParenToken) {
        depth--;
      }
    }
    return scanner.scan() === SyntaxKind.EqualsGreaterThanToken;
  };

  // 式の位置の`<`(今のトークン)がJSXの要素を始めるかを、先読みで判断する。
  const startsJsxElement = (): boolean =>
    scanner.lookAhead(() => {
      const name = scanner.scan();
      if (name === SyntaxKind.GreaterThanToken) return true;
      if (!isIdentifierOrKeyword(name)) return false;
      // `<const T`の`const`は型引数の修飾子なので、型引数の名前まで読み飛ばす。
      if (name === SyntaxKind.ConstKeyword) scanner.scan();
      const afterName = scanner.scan();
      if (
        afterName === SyntaxKind.CommaToken ||
        afterName === SyntaxKind.EqualsToken
      ) {
        return false;
      }
      if (afterName === SyntaxKind.ExtendsKeyword) {
        // `<T extends>`・`<T extends=...>`・`<T extends/>`は、`extends`という
        // 名前の属性を持つJSXの要素。
        const afterExtends = scanner.scan();
        return (
          afterExtends === SyntaxKind.GreaterThanToken ||
          afterExtends === SyntaxKind.EqualsToken ||
          afterExtends === SyntaxKind.SlashToken
        );
      }
      if (afterName === SyntaxKind.GreaterThanToken) {
        if (scanner.scan() !== SyntaxKind.OpenParenToken) return true;
        return !isFollowedByArrowAfterParens();
      }
      return true;
    });

  // JSXの文脈に応じて次のトークンを読む。
  const scanNext = (): number => {
    const top = jsxFrames.at(-1);
    if (top?.kind === "children") return scanner.scanJsxToken();
    if (top?.kind === "tag") {
      if (previousKind === SyntaxKind.EqualsToken) {
        return scanner.scanJsxAttributeValue();
      }
      const kind = scanner.scan();
      // タグの名前・属性の名前は、キーワードと同じ綴り(`<Link as="a">`の
      // `as`など)でも名前なので、Identifierとして扱う。
      if (isIdentifierOrKeyword(kind)) {
        scanner.scanJsxIdentifier();
        return SyntaxKind.Identifier;
      }
      return kind;
    }
    return scanner.scan();
  };
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

  let previousEnd = -1;
  let kind = scanner.scan();
  while (kind !== SyntaxKind.EndOfFile) {
    const jsxTop = jsxFrames.at(-1);
    const inJsxMarkup = jsxTop?.kind === "tag" || jsxTop?.kind === "children";
    // タグの中の`/`は自己終了の`/>`の一部で、正規表現ではない。
    if (
      !inJsxMarkup &&
      isRegularExpressionStart(kind, previousEndsExpression)
    ) {
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
    if (jsx) {
      const wasOutsideJsx = jsxFrames.length === 0;
      updateJsxFrames(
        jsxFrames,
        kind,
        previousKind,
        previousEndsExpression,
        startsJsxElement,
      );
      if (wasOutsideJsx && jsxFrames.length > 0) {
        jsxRootStart = scanner.getTokenStart();
      }
    }
    tokens.push({
      kind,
      start: scanner.getTokenStart(),
      text: scanner.getTokenText(),
    });
    previousEndsExpression = endsExpression(
      kind,
      previousKind,
      previousEndsExpression,
      scanner.hasPrecedingLineBreak(),
    );
    previousKind = kind;
    kind = scanNext();
  }
  if (jsxFrames.length > 0) throw new UnclosedJsxError(jsxRootStart);
  return tokens;
}

/**
 * 読んだトークン`kind`に応じて、JSXの文脈のスタックを進める。
 * `startsJsxElement`は、コードの中の`<`がJSXの要素を始めるかの先読み。
 */
function updateJsxFrames(
  frames: JsxFrame[],
  kind: number,
  previousKind: number | undefined,
  previousEndsExpression: boolean,
  startsJsxElement: () => boolean,
): void {
  const top = frames.at(-1);

  if (top === undefined || top.kind === "expression") {
    if (
      kind === SyntaxKind.LessThanToken &&
      !previousEndsExpression &&
      startsJsxElement()
    ) {
      frames.push({ kind: "tag", closing: false, typeArgumentDepth: 0 });
    } else if (top !== undefined && kind === SyntaxKind.OpenBraceToken) {
      top.braceDepth++;
    } else if (top !== undefined && kind === SyntaxKind.CloseBraceToken) {
      if (top.braceDepth === 0) {
        frames.pop();
      } else {
        top.braceDepth--;
      }
    }
    return;
  }

  if (top.kind === "children") {
    if (kind === SyntaxKind.LessThanToken) {
      frames.push({ kind: "tag", closing: false, typeArgumentDepth: 0 });
    } else if (kind === SyntaxKind.LessThanSlashToken) {
      frames.push({ kind: "tag", closing: true, typeArgumentDepth: 0 });
    } else if (kind === SyntaxKind.OpenBraceToken) {
      frames.push({ kind: "expression", braceDepth: 0 });
    }
    return;
  }

  // タグの中。
  if (kind === SyntaxKind.LessThanToken) {
    top.typeArgumentDepth++;
  } else if (
    kind === SyntaxKind.GreaterThanToken &&
    top.typeArgumentDepth > 0
  ) {
    top.typeArgumentDepth--;
  } else if (kind === SyntaxKind.OpenBraceToken) {
    frames.push({ kind: "expression", braceDepth: 0 });
  } else if (kind === SyntaxKind.GreaterThanToken) {
    frames.pop();
    if (top.closing) {
      // 閉じタグで、その要素の本文も終わる。
      frames.pop();
    } else if (previousKind !== SyntaxKind.SlashToken) {
      // 自己終了でない開きタグの後は本文が続く。
      frames.push({ kind: "children" });
    }
  }
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
  const jsx = fileName.endsWith(".tsx");
  let tokens: Token[];
  try {
    tokens = tokenize(sourceText, { jsx });
  } catch (err) {
    if (err instanceof TokenizeError) {
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

    // `.tsx`では`<Type>expr`の構文が無く(JSXと衝突するため)、`<`はJSXか
    // ジェネリクスなので検査しない。
    if (!jsx && token.kind === SyntaxKind.LessThanToken) {
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
