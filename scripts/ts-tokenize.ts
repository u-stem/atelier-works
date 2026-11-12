// TypeScriptのソースを、コメントと空白を除いたトークン列に分ける。
// コメント以外の差分の検査(`check-comment-only-diff.ts`)と、短いリモート追跡refの検出
// (`lint-no-short-remote-ref.ts`)が使う。
//
// 実装の注意: TypeScript 7の`typescript`パッケージには、従来の同期パーサー
// (`ts.createSourceFile`と`ts.isXxx`のノードガード)が無い。完全なASTは
// ネイティブのProject/Program/CheckerのIPC API(`typescript/unstable/sync`)
// からしか得られず、ネイティブのコンパイラのプロセスを起動するので、
// 小さく速い検査には向かない。そこで`typescript/unstable/ast`が公開する
// 純粋JSのトークナイザ(`createScanner`)を使う。
// 完全な構文解析ではないので、まれな入力では読み違いがありうる。
//
// `.tsx`では、スキャナーをJSXのモードにし、JSXの要素のタグ・本文・`{...}`を
// 読み分ける(`tokenize`を参照)。本文・属性の文字列・属性名は、コードのトークンとして
// 読まない。コードをJSXと読み違えると以降が黙って本文として読まれるため、
// ファイルの終わりまでに閉じないJSXの要素は`UnclosedJsxError`として位置を報告する。
//
// `tokenize`は、スキャナーの2つの落とし穴を明示的に処理する。テンプレート
// リテラルの続き(`${`の置換の後の`}...`)と正規表現リテラルは、どちらも
// 再スキャンが要る。単純な`scan()`のループでは中身を普通のコードとして
// 扱ってしまうため。正規表現は読み違いだけでなく停止性の問題でもある。
// TypeScript 7の純粋JSのスキャナーは、識別子が続かない`#`
// (例: `/#(\d+)/`の`#(`)から先へ進まず、正規表現の本体をコードとして
// 読むと`scan()`が同じトークンを返し続け、プロセスが際限なく膨らむ。
// そのため`tokenize`は、スキャナーが進まなくなったらエラーで中断する。

import {
  createScanner,
  LanguageVariant,
  SyntaxKind,
} from "typescript/unstable/ast";

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
