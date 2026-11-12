import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { isRecord } from "../../f/factory/lib/types.ts";

// 型アサーションを止めるBiomeの規則が、設定どおりに効き続けることを固定する。
// 規則はBiomeのnurseryにあり、版を上げると挙動が変わりうるため、実物のBiomeで確かめる。

const ROOT = join(import.meta.dir, "..", "..");
const SELF = relative(ROOT, import.meta.path);
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
    ["git", "ls-files", "-z", "--", "*.ts", "*.tsx"],
    { cwd: ROOT, env: { PATH: process.env.PATH ?? "" } },
  );
  if (result.exitCode !== 0) throw new Error("git ls-files failed");
  return result.stdout
    .toString()
    .split("\0")
    .filter((path) => path !== "" && path !== SELF);
}

// 条件に合う行を`path:line`の形で返す。
function linesMatching(match: (line: string) => boolean): string[] {
  const found: string[] = [];
  for (const path of trackedTypeScriptFiles()) {
    const lines = readFileSync(join(ROOT, path), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (match(line)) found.push(`${path}:${index + 1}`);
    });
  }
  return found;
}

// 規則のグループ全体(`lint`と`lint/nursery`)を黙らせるコメントの行。
// 文字列の中の同じ並びを拾わないよう、行頭がコメントのものだけを見る。
const GROUP_SUPPRESSION =
  /^\s*(?:\{\s*)?(?:\/\/|\/\*)\s*biome-ignore(?:-all|-start)?\s+lint(?:\/nursery)?(?=[\s:(]|$)/;

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
      linesMatching(
        (line) => line.includes("biome-ignore") && line.includes(RULE),
      ),
    ).toEqual([]);
  });

  test("no tracked file suppresses the whole lint or nursery group with a biome-ignore comment", () => {
    expect(linesMatching((line) => GROUP_SUPPRESSION.test(line))).toEqual([]);
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
