#!/usr/bin/env bun
// Forbids TypeScript type assertions (`expr as Type` and `<Type>expr`)
// outside `as const` and outside the body of a user-defined type guard
// function (a function whose return type is a type predicate, e.g.
// `function isFoo(v: unknown): v is Foo { ... }`).
//
// Implementation note: TypeScript 7's `typescript` package no longer ships
// the classic synchronous parser (`ts.createSourceFile` + `ts.isXxx` node
// guards). The full AST is only reachable through the native
// Project/Program/Checker IPC API (`typescript/unstable/sync`), which spawns
// a native compiler process and is unsuitable for a small, fast lint script.
// This script instead uses the still-pure-JS tokenizer exported from
// `typescript/unstable/ast` (`createScanner`) and applies a token-level
// heuristic to find assertions and type-guard function bodies. This is not a
// full parse, so pathological inputs (e.g. a generic function *type*
// annotation like `const f: <T>(v: T) => T = ...` right after a colon) can in
// theory produce a false positive; such patterns are rare in this
// repository's application code. Nested generics that make the scanner emit
// a compound `>>`/`>>>` token instead of separate `>` tokens (e.g.
// `Array<Array<Foo>>`) are also out of scope for the same reason.
//
// Two scanner-level pitfalls are handled explicitly in `tokenize`: template
// literal continuations (`}...` after a `${` substitution) and regular
// expression literals both need a re-scan, because a plain `scan()` loop
// otherwise treats their text as ordinary source code. The regex case is
// also a robustness issue, not just a false-positive one: TypeScript 7's
// pure-JS scanner does not advance past a `#` that is not followed by an
// identifier (e.g. the `#(` in `/#(\d+)/`), so tokenizing a regex body as
// code makes `scan()` return the same token forever and the process grow
// without bound. `tokenize` therefore also aborts with an error if the
// scanner ever fails to make progress.

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

const DEFAULT_GLOBS = ["f/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"];

export type Token = {
  readonly kind: number;
  readonly start: number;
  readonly text: string;
};

// Tokens after which a `/` cannot be a division operator because they
// cannot end an expression, so a following `/` starts a regular expression
// literal and must be re-scanned as one. Expressed as the complement: the
// only tokens that CAN end an expression are identifiers, literals, closing
// parens/brackets, `this`/`super`/`true`/`false`/`null`, and postfix
// `++`/`--`. A closing brace is deliberately NOT in the set: at token level
// a `}` closing a block statement (after which `/` starts a regex) cannot
// be told apart from one closing an object literal (after which `/` would
// be a division), and the former is far more common in real code. Dividing
// an object literal directly (`{ a: 1 } / 2`) is therefore a known,
// accepted mis-tokenization, like the nested-generics case above.
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

/** Thrown by `tokenize` when the scanner returns a token without advancing
 * (see the module header) — carries the source offset so the caller can
 * report a `file:line:column` location instead of hanging. */
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
  // Brace-nesting depth since each currently-open template substitution's
  // `${`, one entry per nested template literal. A plain `scan()` loop
  // treats a template's `}...` continuation as ordinary source code (its
  // text can contain any character, including a bare `as`), so a `}` that
  // closes the substitution expression itself (depth 0, as opposed to one
  // that closes a nested object literal/block inside it) must be re-scanned
  // via `reScanTemplateToken` to get the real TemplateMiddle/TemplateTail
  // token — otherwise everything after it in the source is mis-tokenized,
  // e.g. the word "as" inside `` `${x} treat it as data` `` is scanned as
  // the `as` keyword and false-flagged as a type assertion.
  const templateSubstitutionDepths: number[] = [];

  let previousKind: number | undefined;
  let previousEnd = -1;
  let kind = scanner.scan();
  while (kind !== SyntaxKind.EndOfFile) {
    if (isRegularExpressionStart(kind, previousKind)) {
      kind = scanner.reScanSlashToken();
    }
    // Every token must move the scanner forward; a stalled scanner would
    // otherwise loop here forever, allocating a token per iteration.
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
          // The re-scan replaces the 1-char `}` token with the template
          // continuation, so the progress guard has to be re-applied to
          // the new token end (the check above only saw the bare `}`).
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

// Tokens after which `<` cannot be a binary/comparison operator, so a
// following `<...>` run is plausibly a type-assertion opener.
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

// Tokens that can plausibly start the casted expression right after `<Type>`.
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

// Finds the index of the `>` that closes the `<` at `openIndex`, bailing out
// (returning undefined) if a statement/block boundary is hit first.
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

// Finds the index of the `)` that closes the `(` at `openIndex`. Unlike `<`/
// `>`, parens are unambiguous, so this is a plain depth count.
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

// A `<...>` run immediately followed by `(...)` is ambiguous: it is either a
// type assertion of a parenthesized expression (`<Foo>(expr)`) or a generic
// arrow function's type parameter list followed by its parameter list
// (`<T>(x: T) => x`, optionally with a return type annotation before `=>`).
// Disambiguates by looking, after the matching `)`, for a top-level `=>`
// (skipping over an optional `: ReturnType` in between).
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

  // Skip a return type annotation, looking for a top-level `=>`.
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

// Computes, for each token index, the nesting depth of user-defined type
// guard function bodies the token is inside of (0 = not inside one).
//
// Handles both block bodies (`(...): v is Foo { ... }`) and concise arrow
// bodies (`(...): v is Foo => expr`). A concise body has no braces of its
// own, so its end is detected via a generic bracket-depth counter: the body
// ends at the first comma/semicolon at the same depth the body started at,
// or when an enclosing bracket closes.
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

    // Close out a concise (brace-less) type guard body before this token's
    // own bracket effect is applied, so the boundary token itself is not
    // counted as part of the guarded region.
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
        // Concise arrow body: the guard applies to the expression that
        // follows, starting at the current bracket depth.
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
      // `import * as name` / `export * as name`: a namespace binding, not a
      // type assertion — the only place `* as` can appear in valid syntax.
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

// Bun.Glob.scan has no built-in .gitignore/node_modules awareness (unlike
// e.g. ripgrep), so a nested `node_modules` under `f/**` — which a raw
// app's own package.json creates once `wmill app lint`/`wmill app dev`
// installs its frontend dependencies (see .claude/skills/raw-app/SKILL.md)
// — would otherwise have its third-party `.d.ts` files swept up by the
// `f/**/*.ts` glob and false-positive on this script's own assertion check
// (those files are not this repo's code and are gitignored regardless).
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
