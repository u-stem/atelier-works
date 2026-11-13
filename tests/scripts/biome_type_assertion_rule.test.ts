import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../f/factory/lib/types.ts";

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
// 一時ディレクトリは根の下に作る。根の外のファイルを渡すと、Biomeが.gitignoreの処理で異常終了することがあるため。
function lint(
  body: string,
  options: { readonly onlyRule: boolean },
): { readonly exitCode: number; readonly output: string } {
  const dir = mkdtempSync(join(ROOT, ".biome-probe-"));
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

// 規則を名指しで黙らせる抑制の指示。
// このテスト自身の本文が当たらないよう、規則名は定数から組み立て、指示の直後に空白を置かない。
const RULE_SUPPRESSION = new RegExp(
  `biome-ignore(?:-all|-start)?\\s+[^\\s:]*${RULE}`,
  "g",
);

// 規則のグループ全体を黙らせる抑制の指示。
// `-all`と`-start`の形と、`/** ... */`の形も、Biomeは抑制として受け付ける。
const GROUP_SUPPRESSION =
  /biome-ignore(?:-all|-start)?\s+lint(?:\/nursery)?(?![\w/])/g;

// 抑制の指示と同じ並びを、文字列のデータとして持つ既知の箇所。
// `snippet`は、当たった並びを囲む本文で、その範囲の中の当たりだけを外す。
// 載せる前に、本当に文字列のデータであることを読んで確かめる。
// `snippet`の指示の直後の空白は`SPACE`から組み立て、このテスト自身の本文が当たらないようにする。
const SPACE = " ";
const ALLOWED_DATA: readonly {
  readonly path: string;
  readonly snippet: string;
}[] = [
  // 修正の差分の検査が、抑制のコメントを足す行を止めることを確かめるテストの入力の文字列。
  {
    path: "tests/lib/conflict_fix_round.test.ts",
    snippet: `withNewLine("// biome-ignore${SPACE}lint: x")`,
  },
];

// 本文で`pattern`に当たる箇所を、許可の一覧で外したうえで`path:line`の形で返す。
// コメントかどうかは見分けない。トークンの読み違いでコメントを取りこぼさないため。
function suppressionsMatching(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const path of trackedTypeScriptFiles()) {
    const text = readFileSync(join(ROOT, path), "utf8");
    const allowed = ALLOWED_DATA.filter((entry) => entry.path === path);
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      const isData = allowed.some((entry) => {
        const at = text.indexOf(entry.snippet);
        return at !== -1 && at <= start && end <= at + entry.snippet.length;
      });
      if (isData) continue;
      const line = text.slice(0, start).split("\n").length;
      found.push(`${path}:${line}`);
    }
  }
  return found;
}

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
  ])("fails on %s with the rule reported", (_label, body) => {
    // 設定の誤りや起動の失敗でも終了コードは0でなくなるので、規則が当たったことを出力でも確かめる。
    const result = lint(body, { onlyRule: true });
    expect({
      failed: result.exitCode !== 0,
      reported: result.output.includes(`lint/nursery/${RULE}`),
    }).toEqual({ failed: true, reported: true });
  });

  test("passes an `as const` assertion without reporting the rule", () => {
    const result = lint("export const pair = [1, 2] as const;", {
      onlyRule: true,
    });
    expect({
      exitCode: result.exitCode,
      reported: result.output.includes(`lint/nursery/${RULE}`),
    }).toEqual({ exitCode: 0, reported: false });
  });

  test("reports the rule from biome.json without selecting it on the command line", () => {
    expect(
      lint("export const y = x as Foo;", { onlyRule: false }).output,
    ).toContain(`lint/nursery/${RULE}`);
  });
});

describe("biome checks every tracked TypeScript file", () => {
  test("no tracked file suppresses the rule with a biome-ignore comment", () => {
    expect(suppressionsMatching(RULE_SUPPRESSION)).toEqual([]);
  });

  test("no tracked file suppresses the whole lint or nursery group with a biome-ignore comment", () => {
    expect(suppressionsMatching(GROUP_SUPPRESSION)).toEqual([]);
  });

  test("every entry of the allowed data still appears in its file", () => {
    expect(
      ALLOWED_DATA.filter(
        (entry) =>
          !readFileSync(join(ROOT, entry.path), "utf8").includes(entry.snippet),
      ),
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
