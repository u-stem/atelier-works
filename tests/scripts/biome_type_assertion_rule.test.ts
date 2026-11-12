import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeLineStarts,
  getLeadingCommentRanges,
  getTrailingCommentRanges,
} from "typescript/unstable/ast";
import { isRecord } from "../../f/factory/lib/types.ts";
import {
  type Token,
  TokenizeError,
  tokenize,
} from "../../scripts/ts-tokenize.ts";

// 型アサーションを止めるBiomeの規則が、設定どおりに効き続けることを固定する。
// 規則はBiomeのnurseryにあり、版を上げると挙動が変わりうるため、実物のBiomeで確かめる。

const ROOT = join(import.meta.dir, "..", "..");
const RULE = "noUnsafeTypeAssertion";
// Biomeの`files.maxSize`の既定値(1 MiB)。
const DEFAULT_MAX_SIZE = 1024 * 1024;

const PRELUDE = [
  "type Foo = { readonly a: string };",
  "declare const x: unknown;",
  "declare const s: string;",
].join("\n");

// 一時ディレクトリに置いたファイルを、リポジトリの`biome.json`でlintする。
// 標準入力(`--stdin-file-path`)はこの版では診断を返さないので、実ファイルを渡す。
// cwdをリポジトリの根にすると、Biomeは根の`biome.json`と、インストール済みのBiomeを使う。
function lint(
  body: string,
  options: { readonly onlyRule: boolean },
): { readonly exitCode: number; readonly output: string } {
  const dir = mkdtempSync(join(tmpdir(), "biome-probe-"));
  try {
    const file = join(dir, "probe.ts");
    writeFileSync(file, `${PRELUDE}\n${body}\n`);
    const result = Bun.spawnSync(
      [
        "bunx",
        "--bun",
        "biome",
        "lint",
        ...(options.onlyRule ? [`--only=nursery/${RULE}`] : []),
        file,
      ],
      { cwd: ROOT, env: { PATH: process.env.PATH ?? "" } },
    );
    return {
      exitCode: result.exitCode,
      output: `${result.stdout.toString()}${result.stderr.toString()}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function trackedTypeScriptFiles(): string[] {
  const result = Bun.spawnSync(
    ["git", "ls-files", "-z", "--", "*.ts", "*.tsx", "*.mts", "*.cts"],
    { cwd: ROOT, env: { PATH: process.env.PATH ?? "" } },
  );
  if (result.exitCode !== 0) throw new Error("git ls-files failed");
  return result.stdout
    .toString()
    .split("\0")
    .filter((path) => path !== "");
}

// `position`が何行目か(1始まり)を返す。
function lineAt(lineStarts: readonly number[], position: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((lineStarts[mid] ?? 0) <= position) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low + 1;
}

type Comment = { readonly where: string; readonly text: string };

// ファイルの中のコメントを返す。
// 行頭に限らず、行末、式の途中、JSXの`{/* ... */}`のコメントも拾う。
// 文字列、テンプレート、正規表現、JSXの本文の中の同じ並びは、コメントに数えない。
// トークンに分けられないファイルは、全体を1つのコメントとみなし、見逃さない側に倒す。
function commentsOf(path: string): Comment[] {
  const text = readFileSync(join(ROOT, path), "utf8");
  let tokens: Token[];
  try {
    tokens = tokenize(text, { jsx: path.endsWith(".tsx") });
  } catch (err) {
    if (err instanceof TokenizeError) return [{ where: path, text }];
    throw err;
  }
  const lineStarts = computeLineStarts(text);
  const seen = new Set<number>();
  const comments: Comment[] = [];
  const collect = (position: number): void => {
    const ranges = [
      ...(getTrailingCommentRanges(text, position) ?? []),
      ...(getLeadingCommentRanges(text, position) ?? []),
    ];
    for (const range of ranges) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      comments.push({
        where: `${path}:${lineAt(lineStarts, range.pos)}`,
        text: text.slice(range.pos, range.end),
      });
    }
  };
  collect(0);
  for (const token of tokens) collect(token.start + token.text.length);
  return comments;
}

// 条件に合うコメントの位置を`path:line`の形で返す。
// このテスト自身も対象にする。規則名と正規表現はコードに書き、コメントには書かない。
function commentsMatching(match: (comment: string) => boolean): string[] {
  return trackedTypeScriptFiles().flatMap((path) =>
    commentsOf(path)
      .filter((comment) => match(comment.text))
      .map((comment) => comment.where),
  );
}

// 規則のグループ全体を黙らせる抑制の指示。
// `-all`と`-start`の形と、`/** ... */`の形も、Biomeは抑制として受け付ける。
const GROUP_SUPPRESSION =
  /biome-ignore(?:-all|-start)?\s+lint(?:\/nursery)?(?![\w/])/;

function readMaxSize(): number | null {
  const parsed: unknown = JSON.parse(
    readFileSync(join(ROOT, "biome.json"), "utf8"),
  );
  if (!isRecord(parsed) || !isRecord(parsed.files)) return null;
  const maxSize = parsed.files.maxSize;
  return typeof maxSize === "number" ? maxSize : null;
}

describe("biome rejects type assertions", () => {
  test.each([
    ["an `as` assertion", "export const y = x as Foo;"],
    ["an angle-bracket assertion", "export const y = <Foo>x;"],
    ["a widening `as` assertion", "export const t = s as string | number;"],
    ["a double `as` assertion", "export const y = x as unknown as Foo;"],
  ])("fails on %s", (_label, body) => {
    expect(lint(body, { onlyRule: true }).exitCode).not.toBe(0);
  });

  test("passes an `as const` assertion", () => {
    expect(
      lint("export const pair = [1, 2] as const;", { onlyRule: true }).exitCode,
    ).toBe(0);
  });

  test("reports the rule from biome.json without selecting it on the command line", () => {
    expect(
      lint("export const y = x as Foo;", { onlyRule: false }).output,
    ).toContain(`lint/nursery/${RULE}`);
  });
});

describe("biome checks every tracked TypeScript file", () => {
  test("no tracked file suppresses the rule with a biome-ignore comment", () => {
    expect(
      commentsMatching(
        (comment) => comment.includes("biome-ignore") && comment.includes(RULE),
      ),
    ).toEqual([]);
  });

  test("no tracked file suppresses the whole lint or nursery group with a biome-ignore comment", () => {
    expect(
      commentsMatching((comment) => GROUP_SUPPRESSION.test(comment)),
    ).toEqual([]);
  });

  test("biome.json sets files.maxSize explicitly", () => {
    expect(typeof readMaxSize()).toBe("number");
  });

  test("no tracked TypeScript file is larger than files.maxSize, which biome would skip", () => {
    const maxSize = readMaxSize() ?? DEFAULT_MAX_SIZE;
    expect(
      trackedTypeScriptFiles().filter(
        (path) => statSync(join(ROOT, path)).size > maxSize,
      ),
    ).toEqual([]);
  });
});
