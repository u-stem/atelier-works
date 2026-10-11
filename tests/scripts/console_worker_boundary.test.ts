import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Glob } from "bun";

// Console用workerは、DBと`wmill.getVariable()`でsecret変数に届く。
// 境界を保つため、tag: consoleのscriptがどのsecret変数を読むかを、importをたどって数える。
// - github_tokenを読んでよいのは、approval_decideとretry_work_itemだけ。
// - その2つも、github_token以外のsecret変数は読まない。
// - audit_kickoffとnotice_resolveは、どのsecret変数も読まない。
//   Consoleから押せる操作に、外向きの資格情報を持たせないためである。
// 走査はimportをたどる。副作用だけのimport、再エクスポート、リテラルの動的importは拾う。
// 拾えない形(importの引数が変数、require)が現れたら、走査の穴になるのでテストを落とす。

const GITHUB_TOKEN = "f/factory/github_token";
const DISCORD_WEBHOOK_URL = "f/factory/discord_webhook_url";

const MAY_READ_GITHUB_TOKEN = [
  "f/factory/approval_decide",
  "f/factory/retry_work_item",
];
const READS_NO_SECRET = ["f/factory/audit_kickoff", "f/factory/notice_resolve"];

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** importの引数が変数のとき、または`require`を使うとき。走査がたどれない。 */
const UNFOLLOWABLE_IMPORT = /\brequire\s*\(|\bimport\s*\(\s*[^"'`\s]/;

function withoutComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join("\n");
}

/** `source`が相対パスで読み込む先。副作用だけのimport、再エクスポート、リテラルの動的importを含む。 */
export function relativeImports(source: string): string[] {
  return transpiler
    .scanImports(source)
    .map((entry) => entry.path)
    .filter((path) => path.startsWith("."));
}

export function hasUnfollowableImport(source: string): boolean {
  return UNFOLLOWABLE_IMPORT.test(withoutComments(source));
}

/** `entry`のTypeScriptと、そこから相対importでたどれるファイルすべての本文。 */
function sourcesReachableFrom(entry: string): Map<string, string> {
  const sources = new Map<string, string>();
  const pending = [resolve(`${entry}.ts`)];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (sources.has(file)) continue;
    const source = readFileSync(file, "utf8");
    sources.set(file, source);
    for (const path of relativeImports(source)) {
      pending.push(resolve(dirname(file), path));
    }
  }
  return sources;
}

function mentions(entry: string, variablePath: string): boolean {
  return [...sourcesReachableFrom(entry).values()].some((source) =>
    withoutComments(source).includes(variablePath),
  );
}

async function scan(pattern: string): Promise<string[]> {
  const found: string[] = [];
  for await (const file of new Glob(pattern).scan(".")) found.push(file);
  return found.sort();
}

async function consoleScripts(): Promise<string[]> {
  const paths: string[] = [];
  for (const file of await scan("f/**/*.script.yaml")) {
    if (/^tag: console$/m.test(await Bun.file(file).text())) {
      paths.push(file.replace(/\.script\.yaml$/, ""));
    }
  }
  return paths;
}

async function secretVariablePaths(): Promise<string[]> {
  const paths: string[] = [];
  for (const file of await scan("f/factory/*.variable.yaml")) {
    if (/^is_secret: true$/m.test(await Bun.file(file).text())) {
      paths.push(file.replace(/\.variable\.yaml$/, ""));
    }
  }
  return paths;
}

describe("the import scan", () => {
  test("follows a side-effect import", () => {
    expect(relativeImports('import "./side.ts";')).toEqual(["./side.ts"]);
  });

  test("follows a re-export", () => {
    expect(relativeImports('export * from "./re.ts";')).toEqual(["./re.ts"]);
  });

  test("follows a dynamic import with a literal", () => {
    expect(relativeImports('const m = await import("./dyn.ts");')).toEqual([
      "./dyn.ts",
    ]);
  });

  test("ignores a package import", () => {
    expect(relativeImports('import * as fs from "node:fs";')).toEqual([]);
  });

  test("flags a dynamic import whose argument is a variable", () => {
    expect(hasUnfollowableImport("const m = await import(path);")).toBe(true);
  });

  test("flags require", () => {
    expect(hasUnfollowableImport('const m = require("./x.js");')).toBe(true);
  });

  test("does not flag a dynamic import with a literal", () => {
    expect(hasUnfollowableImport('const m = await import("./x.ts");')).toBe(
      false,
    );
  });

  test("does not flag a comment that mentions import(", () => {
    expect(hasUnfollowableImport("// import(path) is not used")).toBe(false);
  });

  test("no file a console script reaches has an import the scan cannot follow", async () => {
    const offenders = new Set<string>();
    for (const path of await consoleScripts()) {
      for (const [file, source] of sourcesReachableFrom(path)) {
        if (hasUnfollowableImport(source)) offenders.add(file);
      }
    }
    expect([...offenders]).toEqual([]);
  });
});

describe("console worker boundary", () => {
  test("the scan sees the secret variables the boundary is about", async () => {
    expect(await secretVariablePaths()).toEqual(
      expect.arrayContaining([GITHUB_TOKEN, DISCORD_WEBHOOK_URL]),
    );
  });

  test("the scan follows imports far enough to see retry_work_item read github_token", () => {
    expect(mentions("f/factory/retry_work_item", GITHUB_TOKEN)).toBe(true);
  });

  test("the scan sees approval_decide read github_token", () => {
    expect(mentions("f/factory/approval_decide", GITHUB_TOKEN)).toBe(true);
  });

  test("only approval_decide and retry_work_item may read github_token", async () => {
    const readers = (await consoleScripts()).filter((path) =>
      mentions(path, GITHUB_TOKEN),
    );
    expect(
      readers.filter((path) => !MAY_READ_GITHUB_TOKEN.includes(path)),
    ).toEqual([]);
  });

  test.each(MAY_READ_GITHUB_TOKEN)(
    "%s reads no secret variable but github_token",
    async (path) => {
      const secrets = await secretVariablePaths();
      expect(
        secrets.filter(
          (secret) => secret !== GITHUB_TOKEN && mentions(path, secret),
        ),
      ).toEqual([]);
    },
  );

  test.each(READS_NO_SECRET)("%s does not read github_token", (path) => {
    expect(mentions(path, GITHUB_TOKEN)).toBe(false);
  });

  test.each(READS_NO_SECRET)("%s does not read discord_webhook_url", (path) => {
    expect(mentions(path, DISCORD_WEBHOOK_URL)).toBe(false);
  });

  test.each(READS_NO_SECRET)("%s reads no secret variable", async (path) => {
    const secrets = await secretVariablePaths();
    expect(secrets.filter((secret) => mentions(path, secret))).toEqual([]);
  });

  test.each([...MAY_READ_GITHUB_TOKEN, ...READS_NO_SECRET])(
    "%s is a console script",
    async (path) => {
      expect(await consoleScripts()).toContain(path);
    },
  );
});
