import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  codeOf,
  GITHUB_TOKEN,
  nonLiteralVariableReads,
  relative,
  scan,
  scriptsWithTag,
  secretVariablePaths,
  sourcesReachableFrom,
  toolDependencies,
  unfollowableImports,
  yamlOf,
} from "./worker_boundary_scan.ts";

// 定期ジョブ用workerは、上流のWindmillイメージで動く。
// 独自イメージの道具(claude、gh、git、gtr、検査の枠)も、defaultのworkerがマウントするファイルも、
// cgroupの計測の対象も無い。DBと`wmill.getVariable()`でsecret変数には、defaultのworkerと同じように届く。
// 境界を保つため、tag: periodicのscriptについて、次を固定する。
// - tag: periodicを持つscriptは、下の一覧と一致する。足すときは、一覧と選んだ理由(docs/security.md)を同じ変更で直す。
// - どれも、スケジュールが呼ぶscriptである。
// - 読んでよいsecret変数は、github_tokenだけである。claudeのトークンやwmillのトークンには届かせない。
// - importでたどれるソースに、ファイル、サブプロセス、claudeへの依存が無い。
// - 走査でたどれない形(Console用workerの境界テストと同じ)が無い。
//
// 走査の方法と限界は、`console_worker_boundary.test.ts`の先頭にある。
// ファイルとサブプロセスの走査は、importと`Bun.`の呼び出しの形を見る。
// 文字列で組み立てた呼び出しや、注入された関数の中身は、コードのレビューで見る。

/**
 * tag: periodicを付けたscript。
 * 依存の無い定期ジョブが見つかるまでは、空である。
 */
const PERIODIC_SCRIPTS: readonly string[] = [];

/** 読んでよいsecret変数。 */
const MAY_READ_SECRET = [GITHUB_TOKEN];

/**
 * 引数が文字列リテラルでないgetVariable()の呼び出しのうち、許すもの。
 * 呼び出し側が定数だけを渡すことを確かめた箇所に限り、理由を書く。
 */
const NON_LITERAL_VARIABLE_READS: Readonly<Record<string, string>> = {
  "f/factory/lib/config.ts":
    "loadConfigの引数getResource(注入された関数)。呼び出し側は、リテラルのwmill.getResource(...)を包んで渡す",
};

/** `entry`がimportでたどれるソースに現れる、secret変数のパス。 */
async function reachedSecrets(entry: string): Promise<string[]> {
  const codes = [...sourcesReachableFrom(entry).values()].map(codeOf);
  return (await secretVariablePaths()).filter((secret) =>
    codes.some((code) => code.includes(secret)),
  );
}

/** `entry`がimportでたどれるソースのうち、道具への依存があるファイル。 */
function filesWithToolDependencies(entry: string): string[] {
  return [...sourcesReachableFrom(entry)]
    .filter(([, source]) => toolDependencies(source).length > 0)
    .map(([file]) => relative(file));
}

async function scheduledScripts(): Promise<string[]> {
  const paths: string[] = [];
  for (const file of await scan("f/factory/*.schedule.yaml")) {
    const path = (await yamlOf(file)).script_path;
    if (typeof path === "string") paths.push(path);
  }
  return paths;
}

describe("the tool dependency scan", () => {
  test("flags an import of node:child_process", () => {
    expect(
      toolDependencies('import { spawn } from "node:child_process";'),
    ).not.toEqual([]);
  });

  test("flags an import of child_process without the node: prefix", () => {
    expect(
      toolDependencies('import { spawn } from "child_process";'),
    ).not.toEqual([]);
  });

  test("flags an import of node:fs", () => {
    expect(
      toolDependencies('import { readFileSync } from "node:fs";'),
    ).not.toEqual([]);
  });

  test("flags an import of node:fs/promises", () => {
    expect(
      toolDependencies('import { readFile } from "node:fs/promises";'),
    ).not.toEqual([]);
  });

  test("flags an import of fs/promises without the node: prefix", () => {
    expect(
      toolDependencies('import { readFile } from "fs/promises";'),
    ).not.toEqual([]);
  });

  test("flags a relative import of claude.ts", () => {
    expect(
      toolDependencies('import { runClaude } from "./lib/claude.ts";'),
    ).not.toEqual([]);
  });

  test("flags a sibling import of claude.ts", () => {
    expect(
      toolDependencies('import { runClaude } from "./claude.ts";'),
    ).not.toEqual([]);
  });

  test("flags a call of Bun.spawn", () => {
    expect(toolDependencies('Bun.spawn(["gh", "api"]);')).not.toEqual([]);
  });

  test("flags a call of Bun.file", () => {
    expect(toolDependencies('await Bun.file("/x").text();')).not.toEqual([]);
  });

  test("flags a call of Bun.write", () => {
    expect(toolDependencies('await Bun.write("/x", "y");')).not.toEqual([]);
  });

  test("flags the Bun.$ shell", () => {
    expect(toolDependencies("await Bun.$`ls`;")).not.toEqual([]);
  });

  test("does not flag node:path", () => {
    expect(toolDependencies('import { join } from "node:path";')).toEqual([]);
  });

  test("does not flag the windmill client", () => {
    expect(
      toolDependencies('import * as wmill from "windmill-client@1.817.0";'),
    ).toEqual([]);
  });

  test("does not flag a module whose name only starts with claude", () => {
    expect(
      toolDependencies('import { x } from "./lib/claude_usage.ts";'),
    ).toEqual([]);
  });

  test("does not flag a mention in a comment", () => {
    expect(
      toolDependencies('// import { readFile } from "node:fs/promises";\n'),
    ).toEqual([]);
  });
});

describe("periodic scripts", () => {
  test("the scripts with tag periodic are the designed ones", async () => {
    expect((await scriptsWithTag("periodic")).sort()).toEqual(
      [...PERIODIC_SCRIPTS].sort(),
    );
  });

  test("every periodic script is called by a schedule", async () => {
    const scheduled = await scheduledScripts();
    expect(
      PERIODIC_SCRIPTS.filter((path) => !scheduled.includes(path)),
    ).toEqual([]);
  });

  test("every periodic script has a timeout", async () => {
    const missing: string[] = [];
    for (const path of PERIODIC_SCRIPTS) {
      const timeout = (await yamlOf(`${path}.script.yaml`)).timeout;
      if (typeof timeout !== "number" || timeout <= 0) missing.push(path);
    }
    expect(missing).toEqual([]);
  });

  test("no file a periodic script reaches has an import the scan cannot follow", () => {
    const offenders = new Set<string>();
    for (const path of PERIODIC_SCRIPTS) {
      for (const [file, source] of sourcesReachableFrom(path)) {
        if (unfollowableImports(source).length > 0) {
          offenders.add(relative(file));
        }
      }
    }
    expect([...offenders]).toEqual([]);
  });

  test("every variable read in a reached file has a literal argument, except the listed ones", () => {
    const offenders = new Set<string>();
    for (const path of PERIODIC_SCRIPTS) {
      for (const [file, source] of sourcesReachableFrom(path)) {
        if (
          nonLiteralVariableReads(source).length > 0 &&
          !(relative(file) in NON_LITERAL_VARIABLE_READS)
        ) {
          offenders.add(relative(file));
        }
      }
    }
    expect([...offenders]).toEqual([]);
  });

  test("the listed non-literal reads still exist", () => {
    const stale = Object.keys(NON_LITERAL_VARIABLE_READS).filter(
      (file) =>
        nonLiteralVariableReads(readFileSync(file, "utf8")).length === 0,
    );
    expect(stale).toEqual([]);
  });

  test("no periodic script declares a variable or resource reference in its inputs", async () => {
    const referencing: string[] = [];
    for (const path of PERIODIC_SCRIPTS) {
      const yaml = await Bun.file(`${path}.script.yaml`).text();
      if (/\$(?:var|res):/.test(yaml)) referencing.push(path);
    }
    expect(referencing).toEqual([]);
  });

  test("no file a periodic script reaches depends on files, subprocesses, or claude", () => {
    const offenders = new Set<string>();
    for (const path of PERIODIC_SCRIPTS) {
      for (const file of filesWithToolDependencies(path)) offenders.add(file);
    }
    expect([...offenders]).toEqual([]);
  });

  test("the scan sees the secret variables the boundary is about", async () => {
    expect(await secretVariablePaths()).toEqual(
      expect.arrayContaining([
        GITHUB_TOKEN,
        "f/factory/claude_oauth_token",
        "f/factory/wmill_token",
      ]),
    );
  });

  test("a periodic script reads no secret variable but the allowed ones", async () => {
    const offenders: string[] = [];
    for (const path of PERIODIC_SCRIPTS) {
      for (const secret of await reachedSecrets(path)) {
        if (!MAY_READ_SECRET.includes(secret)) {
          offenders.push(`${path}: ${secret}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the scan on scripts that stay on the default worker", () => {
  test("sees the file dependency behind watch_pr_ci", () => {
    expect(filesWithToolDependencies("f/factory/watch_pr_ci")).toContain(
      "f/factory/lib/check_sandbox.ts",
    );
  });

  test("sees the claude dependency behind poll_issues", () => {
    expect(filesWithToolDependencies("f/factory/poll_issues")).toContain(
      "f/factory/lib/claude.ts",
    );
  });

  test("sees self_update read wmill_token", async () => {
    expect(await reachedSecrets("f/factory/self_update")).toContain(
      "f/factory/wmill_token",
    );
  });
});
