import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

// Console用workerは`tag: console`のjobだけを受ける。Consoleが呼ぶscriptにだけ付け、
// 1件が止まってもConsole用workerの1枠を塞ぎ続けないよう`timeout`(秒)を付ける。
// 他のscriptに付けると、defaultのworkerが受けない仕事がqueueに溜まる。

const CONSOLE_SCRIPTS: Readonly<Record<string, number>> = {
  "f/factory/steps/console_query": 60,
  "f/factory/notice_resolve": 30,
  "f/factory/approval_decide": 120,
  "f/factory/retry_work_item": 120,
  "f/factory/audit_kickoff": 120,
  "f/factory/console_fetch_watch": 60,
};

async function scriptYaml(path: string): Promise<string> {
  return Bun.file(`${path}.script.yaml`).text();
}

async function allScriptYamlPaths(): Promise<string[]> {
  const glob = new Glob("f/**/*.script.yaml");
  const found: string[] = [];
  for await (const file of glob.scan(".")) {
    found.push(file.replace(/\.script\.yaml$/, ""));
  }
  return found;
}

describe("console scripts", () => {
  test("each console script has tag: console", async () => {
    const missing: string[] = [];
    for (const path of Object.keys(CONSOLE_SCRIPTS)) {
      if (!/^tag: console$/m.test(await scriptYaml(path))) missing.push(path);
    }
    expect(missing).toEqual([]);
  });

  test("each console script has its timeout", async () => {
    const wrong: string[] = [];
    for (const [path, seconds] of Object.entries(CONSOLE_SCRIPTS)) {
      const match = (await scriptYaml(path)).match(/^timeout: (\d+)$/m);
      if (match?.[1] !== String(seconds)) wrong.push(path);
    }
    expect(wrong).toEqual([]);
  });

  test("no other script has tag: console", async () => {
    const others: string[] = [];
    for (const path of await allScriptYamlPaths()) {
      if (path in CONSOLE_SCRIPTS) continue;
      if (/^tag: console$/m.test(await scriptYaml(path))) others.push(path);
    }
    expect(others).toEqual([]);
  });

  test("no other script has a tag at all", async () => {
    const others: string[] = [];
    for (const path of await allScriptYamlPaths()) {
      if (path in CONSOLE_SCRIPTS) continue;
      if (/^tag:/m.test(await scriptYaml(path))) others.push(path);
    }
    expect(others).toEqual([]);
  });

  test("the six console scripts exist", async () => {
    const paths = await allScriptYamlPaths();
    expect(
      Object.keys(CONSOLE_SCRIPTS).filter((path) => !paths.includes(path)),
    ).toEqual([]);
  });
});
