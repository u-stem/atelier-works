import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Glob } from "bun";

// Console用workerは、DBと`wmill.getVariable()`でsecret変数に届く。
// 境界を保つため、tag: consoleのscriptがどのsecret変数を読むかを、importをたどって数える。
// - github_tokenを読んでよいのは、approval_decideとretry_work_itemだけ。
// - audit_kickoffとnotice_resolveは、どのsecret変数も読まない。
//   Consoleから押せる操作に、外向きの資格情報を持たせないためである。

const GITHUB_TOKEN = "f/factory/github_token";
const DISCORD_WEBHOOK_URL = "f/factory/discord_webhook_url";

const MAY_READ_GITHUB_TOKEN = [
  "f/factory/approval_decide",
  "f/factory/retry_work_item",
];
const READS_NO_SECRET = ["f/factory/audit_kickoff", "f/factory/notice_resolve"];

const LOCAL_IMPORT = /from\s+"(\.{1,2}\/[^"]+)"/g;

/** `entry`のTypeScriptと、そこから相対importでたどれるファイルすべての本文。 */
function sourcesReachableFrom(entry: string): Map<string, string> {
  const sources = new Map<string, string>();
  const pending = [resolve(`${entry}.ts`)];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (sources.has(file)) continue;
    const source = readFileSync(file, "utf8");
    sources.set(file, source);
    for (const match of source.matchAll(LOCAL_IMPORT)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        pending.push(resolve(dirname(file), specifier));
      }
    }
  }
  return sources;
}

function mentions(entry: string, variablePath: string): boolean {
  return [...sourcesReachableFrom(entry).values()].some((source) =>
    source.includes(variablePath),
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

describe("console worker boundary", () => {
  test("the scan sees the secret variables the boundary is about", async () => {
    expect(await secretVariablePaths()).toEqual(
      expect.arrayContaining([GITHUB_TOKEN, DISCORD_WEBHOOK_URL]),
    );
  });

  test("the scan follows imports far enough to see retry_work_item read github_token", () => {
    expect(mentions("f/factory/retry_work_item", GITHUB_TOKEN)).toBe(true);
  });

  test("only approval_decide and retry_work_item may read github_token", async () => {
    const readers = (await consoleScripts()).filter((path) =>
      mentions(path, GITHUB_TOKEN),
    );
    expect(
      readers.filter((path) => !MAY_READ_GITHUB_TOKEN.includes(path)),
    ).toEqual([]);
  });

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

  test.each(READS_NO_SECRET)("%s is a console script", async (path) => {
    expect(await consoleScripts()).toContain(path);
  });
});
