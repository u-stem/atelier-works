import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PERIODIC_JOB_WAIT_SECONDS } from "../../f/factory/lib/periodic_worker.ts";
import {
  codeOf,
  DISCORD_WEBHOOK_URL,
  filesWithNonLiteralReads,
  filesWithTag,
  filesWithToolDependencies,
  filesWithUnfollowableImports,
  GITHUB_READ_TOKENS,
  GITHUB_TOKEN,
  hasInputReference,
  mentions,
  mentionsTag,
  nonLiteralVariableReads,
  parseYamlFile,
  scan,
  scriptTimeoutSeconds,
  secretsOutside,
  secretVariablePaths,
  toolDependencies,
  yamlOf,
} from "./worker_boundary_scan.ts";

// 定期ジョブ用workerは、上流のWindmillイメージで動く。
// 独自イメージの道具(claude、gh、git、gtr、検査の枠)も、defaultのworkerがマウントするファイルも、
// cgroupの計測の対象も無い。DBと`wmill.getVariable()`でsecret変数には、defaultのworkerと同じように届く。
// 境界を保つため、tag: periodicのscriptについて、次を固定する。
// - tag periodicへ振り分けるものは、下の一覧のscriptの定義だけである。
//   scriptの定義、スケジュール、フローのモジュールの`tag`と`tag_override`を、`f/`の下のYAMLすべてで調べる。
// - どれも、スケジュールが呼ぶscriptである。
// - 読んでよいsecret変数は、scriptごとの許可(下の`ALLOWED`)に限る。claudeのトークンやwmillのトークンには届かせない。
//   許可のキーは、この一覧のscriptと一致させる。
// - 各scriptについて、他のscriptのtimeoutの合計に余裕を足した秒数が、待ちの検知のしきい値を超えない。
//   このworkerの枠は1つなので、長く動くjobの後ろで待つ定期ジョブを、workerの不在と誤って知らせないためである。
// - defaultのworkerの停止を検知するscript(default_worker_watch)も、この一覧に入る。
//   defaultのworkerの中では、そのworkerが止まると動かないためである。
// - importでたどれるソースに、ファイル、サブプロセス、claudeへの依存が無い。
// - 走査でたどれない形(Console用workerの境界テストと同じ)が無い。
//
// 走査の方法と限界は、`console_worker_boundary.test.ts`の先頭にある。
// tagの走査が見ないもの: 式で組み立てたtag、フローの入力で渡すtag、Windmillの画面で付けたtag。
// 依存の走査が見ないもの: 文字列で組み立てた呼び出し、`eval`と`Function`、注入された関数の中身、
// 第三者パッケージ(execa、fs-extra、zxなど)の中身。
// コードがAPIで渡すtag(`JobService.run*`の`tag`)は、下の「コードが渡すtag」のテストが、現在の0件を保つ。
// resourceの中身で解決されるsecret(`getResource`が返す値の`$var:`)は、走査が見ない。
// これらはコードのレビューで見る。tag periodicを最初に付けるPRでは、そのscriptが読むresourceの中身も確かめる。

/**
 * tag: periodicを付けたscript。
 * 実行時にDB、WindmillのAPI、Discordだけを使うものに限る。
 */
const PERIODIC_SCRIPTS: readonly string[] = [
  "f/factory/notify_daily_summary",
  "f/factory/auto_retry_pr_review",
  "f/factory/collect_github",
  "f/factory/default_worker_watch",
  "f/factory/detect_schedule_failures",
];

/**
 * scriptごとに、読んでよいsecret変数。
 * discord_webhook_urlは通知の送り先として要る。漏れたときの影響は、通知の偽装と停止に限られる。
 * github_read_tokensは、collect_githubだけが読む。所有者ごとの読み取り専用のトークンの対応表で、
 * 通信先は`https://api.github.com/graphql`に固定したクライアントだけである。
 * このworkerは、固定のレビュー済みscriptだけを動かす。
 * github_tokenは、対象のscriptが読まないので許可しない。使わない許可は残さない。
 * 別のscriptの許可を借りて読めるようにしないため、scriptごとに分ける。
 */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  "f/factory/notify_daily_summary": [DISCORD_WEBHOOK_URL],
  "f/factory/auto_retry_pr_review": [DISCORD_WEBHOOK_URL],
  "f/factory/collect_github": [GITHUB_READ_TOKENS],
  "f/factory/default_worker_watch": [DISCORD_WEBHOOK_URL],
  "f/factory/detect_schedule_failures": [DISCORD_WEBHOOK_URL],
};

/**
 * 待ちの検知のしきい値と、他のscriptのtimeoutの合計の間に残す秒数。
 * scriptの起動と、queueから拾うまでの遅れを見込む。
 *
 * このworkerの枠は1つなので、あるscriptが待たされる最悪は、他のscriptのtimeoutの合計である。
 * 下のテストは、各scriptについて「他のscriptのtimeoutの合計 + 余裕」を調べる。
 */
const WAIT_MARGIN_SECONDS = 300;

/**
 * 引数が文字列リテラルでないgetVariable()の呼び出しのうち、許すもの。
 * 呼び出し側が定数だけを渡すことを確かめた箇所に限り、理由を書く。
 */
const NON_LITERAL_VARIABLE_READS: Readonly<Record<string, string>> = {
  "f/factory/lib/config.ts":
    "loadConfigの引数getResource(注入された関数)。呼び出し側は、リテラルのwmill.getResource(...)を包んで渡す",
};

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

  test("flags a named import from bun", () => {
    expect(
      toolDependencies('import { spawn, file, $ } from "bun";'),
    ).not.toEqual([]);
  });

  test("flags a default import from bun", () => {
    expect(toolDependencies('import Bun from "bun";')).not.toEqual([]);
  });

  test("flags a destructuring of Bun", () => {
    expect(toolDependencies("const { spawn } = Bun;")).not.toEqual([]);
  });

  test("flags a bracket access on Bun", () => {
    expect(toolDependencies('Bun["spawn"](["gh"]);')).not.toEqual([]);
  });

  test("flags an alias of Bun", () => {
    expect(toolDependencies("const b = Bun; b.spawn(['gh']);")).not.toEqual([]);
  });

  test("flags a lookup through globalThis", () => {
    expect(toolDependencies('globalThis["Bun"].spawn(["gh"]);')).not.toEqual(
      [],
    );
  });

  test("flags process.getBuiltinModule", () => {
    expect(
      toolDependencies('process.getBuiltinModule("child_process");'),
    ).not.toEqual([]);
  });

  test("flags an import of node:module", () => {
    expect(
      toolDependencies('import { createRequire } from "node:module";'),
    ).not.toEqual([]);
  });

  test("flags an import of node:worker_threads", () => {
    expect(
      toolDependencies('import { Worker } from "node:worker_threads";'),
    ).not.toEqual([]);
  });

  test("flags an import of node:vm", () => {
    expect(toolDependencies('import vm from "node:vm";')).not.toEqual([]);
  });

  test("flags an import of vm without the node: prefix", () => {
    expect(toolDependencies('import vm from "vm";')).not.toEqual([]);
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

  test("does not flag Bun.sleep", () => {
    expect(toolDependencies("await Bun.sleep(10);")).toEqual([]);
  });

  test("does not flag a mention in a comment", () => {
    expect(
      toolDependencies('// import { readFile } from "node:fs/promises";\n'),
    ).toEqual([]);
  });
});

describe("the tag scan", () => {
  test("finds a tag key in a schedule", () => {
    expect(
      mentionsTag(
        Bun.YAML.parse("script_path: f/factory/poll_issues\ntag: periodic\n"),
        "periodic",
      ),
    ).toBe(true);
  });

  test("finds a tag key next to the keys of a schedule", () => {
    expect(
      mentionsTag(
        Bun.YAML.parse(
          "script_path: f/factory/poll_issues\nschedule: 0 */5 * * * *\ntimezone: Asia/Tokyo\nenabled: true\ntag: periodic\n",
        ),
        "periodic",
      ),
    ).toBe(true);
  });

  test("finds a tag key in a flow module", () => {
    expect(
      mentionsTag(
        Bun.YAML.parse(
          "value:\n  modules:\n    - id: a\n      value:\n        type: rawscript\n        tag: periodic\n",
        ),
        "periodic",
      ),
    ).toBe(true);
  });

  test("finds a tag_override key in a flow module", () => {
    expect(
      mentionsTag(
        Bun.YAML.parse(
          "value:\n  modules:\n    - id: a\n      value:\n        type: script\n        path: f/x\n        tag_override: periodic\n",
        ),
        "periodic",
      ),
    ).toBe(true);
  });

  test("finds a tag key inside a branch of a flow", () => {
    expect(
      mentionsTag(
        Bun.YAML.parse(
          "value:\n  modules:\n    - id: a\n      value:\n        type: branchone\n        branches:\n          - modules:\n              - id: b\n                value:\n                  type: script\n                  tag_override: periodic\n",
        ),
        "periodic",
      ),
    ).toBe(true);
  });

  test("ignores another tag", () => {
    expect(mentionsTag(Bun.YAML.parse("tag: console\n"), "periodic")).toBe(
      false,
    );
  });

  test("ignores the word periodic in a value that is not a tag", () => {
    expect(mentionsTag(Bun.YAML.parse("summary: periodic\n"), "periodic")).toBe(
      false,
    );
  });

  test("the YAML glob includes a real schedule", async () => {
    expect(await scan("f/**/*.yaml")).toContain(
      "f/factory/poll_issues.schedule.yaml",
    );
  });

  test("the YAML glob includes a real flow", async () => {
    expect(await scan("f/**/*.yaml")).toContain(
      "f/factory/pr_review__flow/flow.yaml",
    );
  });

  test("a YAML that cannot be parsed fails with its file name", () => {
    expect(() =>
      parseYamlFile("f/factory/x.schedule.yaml", "a: b", () => {
        throw new Error("bad");
      }),
    ).toThrow("f/factory/x.schedule.yaml");
  });

  test("a YAML that can be parsed is returned", () => {
    expect(parseYamlFile("f/factory/x.yaml", "tag: periodic\n")).toEqual({
      tag: "periodic",
    });
  });

  test("sees the tag console of a real script definition", async () => {
    expect(await filesWithTag("console")).toContain(
      "f/factory/console_fetch_watch.script.yaml",
    );
  });
});

describe("the input reference scan", () => {
  test("flags a variable reference in an input default", () => {
    expect(hasInputReference("default: $var:f/factory/github_token\n")).toBe(
      true,
    );
  });

  test("flags a resource reference in an input default", () => {
    expect(hasInputReference("default: $res:f/factory/x\n")).toBe(true);
  });

  test("does not flag a definition without a reference", () => {
    expect(hasInputReference("summary: x\n")).toBe(false);
  });
});

describe("periodic scripts", () => {
  test("the files that route to tag periodic are the designed ones", async () => {
    expect((await filesWithTag("periodic")).sort()).toEqual(
      PERIODIC_SCRIPTS.map((path) => `${path}.script.yaml`).sort(),
    );
  });

  test("the schedule list includes a real scheduled script", async () => {
    expect(await scheduledScripts()).toContain("f/factory/poll_issues");
  });

  test("the timeout of a real script can be read", async () => {
    expect(await scriptTimeoutSeconds("f/factory/self_update")).toBeGreaterThan(
      0,
    );
  });

  test("a script definition without a timeout reads as null", async () => {
    expect(await scriptTimeoutSeconds("f/factory/poll_issues")).toBeNull();
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
      const timeout = await scriptTimeoutSeconds(path);
      if (timeout === null || timeout <= 0) missing.push(path);
    }
    expect(missing).toEqual([]);
  });

  test("no file a periodic script reaches has an import the scan cannot follow", () => {
    expect(filesWithUnfollowableImports(PERIODIC_SCRIPTS)).toEqual([]);
  });

  test("every variable read in a reached file has a literal argument, except the listed ones", () => {
    expect(
      filesWithNonLiteralReads(PERIODIC_SCRIPTS, NON_LITERAL_VARIABLE_READS),
    ).toEqual([]);
  });

  test("the listed non-literal reads still exist", () => {
    const stale = Object.keys(NON_LITERAL_VARIABLE_READS).filter(
      (file) =>
        nonLiteralVariableReads(readFileSync(file, "utf8")).length === 0,
    );
    expect(stale).toEqual([]);
  });

  test("the timeouts of the other scripts plus the margin do not exceed the wait threshold of any script", async () => {
    const timeouts = new Map<string, number>();
    for (const path of PERIODIC_SCRIPTS) {
      timeouts.set(path, (await scriptTimeoutSeconds(path)) ?? 0);
    }
    const total = [...timeouts.values()].reduce((sum, t) => sum + t, 0);
    const worstWait = Math.max(
      ...[...timeouts.values()].map((own) => total - own),
    );
    expect(worstWait + WAIT_MARGIN_SECONDS).toBeLessThanOrEqual(
      PERIODIC_JOB_WAIT_SECONDS,
    );
  });

  test("collect_github times out in 120 seconds", async () => {
    expect(await scriptTimeoutSeconds("f/factory/collect_github")).toBe(120);
  });

  test("notify_daily_summary times out in 120 seconds", async () => {
    expect(await scriptTimeoutSeconds("f/factory/notify_daily_summary")).toBe(
      120,
    );
  });

  test("auto_retry_pr_review times out in 120 seconds", async () => {
    expect(await scriptTimeoutSeconds("f/factory/auto_retry_pr_review")).toBe(
      120,
    );
  });

  test("detect_schedule_failures times out in 60 seconds", async () => {
    expect(
      await scriptTimeoutSeconds("f/factory/detect_schedule_failures"),
    ).toBe(60);
  });

  test("the worst wait of a periodic script is 480 seconds", async () => {
    const timeouts: number[] = [];
    for (const path of PERIODIC_SCRIPTS) {
      timeouts.push((await scriptTimeoutSeconds(path)) ?? 0);
    }
    const total = timeouts.reduce((sum, t) => sum + t, 0);
    expect(Math.max(...timeouts.map((own) => total - own))).toBe(480);
  });

  test("no periodic script declares a variable or resource reference in its inputs", async () => {
    const referencing: string[] = [];
    for (const path of PERIODIC_SCRIPTS) {
      if (hasInputReference(await Bun.file(`${path}.script.yaml`).text())) {
        referencing.push(path);
      }
    }
    expect(referencing).toEqual([]);
  });

  test("no file a periodic script reaches depends on files, subprocesses, or claude", () => {
    expect(filesWithToolDependencies(PERIODIC_SCRIPTS)).toEqual([]);
  });

  test("the scan sees the secret variables the boundary is about", async () => {
    expect(await secretVariablePaths()).toEqual(
      expect.arrayContaining([
        GITHUB_TOKEN,
        GITHUB_READ_TOKENS,
        "f/factory/claude_oauth_token",
        "f/factory/wmill_token",
      ]),
    );
  });

  test("the scripts with a permission are exactly the periodic scripts", () => {
    expect(Object.keys(ALLOWED).sort()).toEqual([...PERIODIC_SCRIPTS].sort());
  });

  test.each([...PERIODIC_SCRIPTS])(
    "%s reads no secret variable but its allowed ones",
    async (path) => {
      expect(await secretsOutside([path], ALLOWED[path] ?? [])).toEqual([]);
    },
  );

  test.each([...PERIODIC_SCRIPTS])(
    "%s reads every secret variable it is allowed to",
    (path) => {
      expect(
        (ALLOWED[path] ?? []).filter((secret) => !mentions(path, secret)),
      ).toEqual([]);
    },
  );

  test("collect_github reads the read-only token variable", () => {
    expect(mentions("f/factory/collect_github", GITHUB_READ_TOKENS)).toBe(true);
  });

  test("collect_github does not read the github_token that can write", () => {
    expect(mentions("f/factory/collect_github", GITHUB_TOKEN)).toBe(false);
  });

  test("the daily summary may not read the read-only tokens", async () => {
    expect(
      await secretsOutside(
        ["f/factory/collect_github"],
        ALLOWED["f/factory/notify_daily_summary"] ?? [],
      ),
    ).toEqual([GITHUB_READ_TOKENS]);
  });

  test("collect_github may not read the discord webhook", async () => {
    expect(
      await secretsOutside(
        ["f/factory/notify_daily_summary"],
        ALLOWED["f/factory/collect_github"] ?? [],
      ),
    ).toEqual([DISCORD_WEBHOOK_URL]);
  });
});

// 検査が空回りしないよう、defaultのworkerに残すscriptを渡して、違反が返ることを確かめる。
describe("the checks on scripts that stay on the default worker", () => {
  test("flags the file dependency behind watch_pr_ci", () => {
    expect(filesWithToolDependencies(["f/factory/watch_pr_ci"])).toContain(
      "f/factory/lib/check_sandbox.ts",
    );
  });

  test("flags the claude dependency behind poll_issues", () => {
    expect(filesWithToolDependencies(["f/factory/poll_issues"])).toContain(
      "f/factory/lib/claude.ts",
    );
  });

  test("flags the file dependency behind cleanup_workspaces", () => {
    expect(
      filesWithToolDependencies(["f/factory/cleanup_workspaces"]),
    ).toContain("f/factory/cleanup_workspaces.ts");
  });

  test("flags the secrets self_update reads, even with the permission of collect_github", async () => {
    expect(
      await secretsOutside(
        ["f/factory/self_update"],
        ALLOWED["f/factory/collect_github"] ?? [],
      ),
    ).toContain("f/factory/wmill_token");
  });

  test("flags the discord webhook when it is not allowed", async () => {
    expect(
      await secretsOutside(["f/factory/notify_daily_summary"], []),
    ).toEqual([DISCORD_WEBHOOK_URL]);
  });

  test("does not flag the discord webhook when it is allowed", async () => {
    expect(
      await secretsOutside(
        ["f/factory/notify_daily_summary"],
        ALLOWED["f/factory/notify_daily_summary"] ?? [],
      ),
    ).toEqual([]);
  });

  test("flags github_token, which poll_issues reads, because it is not allowed", async () => {
    expect(
      await secretsOutside(
        ["f/factory/poll_issues"],
        ALLOWED["f/factory/collect_github"] ?? [],
      ),
    ).toContain(GITHUB_TOKEN);
  });

  test("flags a non-literal read that is not listed", () => {
    expect(
      filesWithNonLiteralReads(["f/factory/steps/console_query"], {}),
    ).toContain("f/factory/steps/console_query.ts");
  });

  test("does not flag a non-literal read that is listed", () => {
    expect(
      filesWithNonLiteralReads(["f/factory/steps/console_query"], {
        ...NON_LITERAL_VARIABLE_READS,
        "f/factory/steps/console_query.ts": "テストの許可",
      }),
    ).toEqual([]);
  });
});

describe("the tag passed by code", () => {
  test("no TypeScript under f/ runs a job through JobService or sets a literal tag", async () => {
    const offenders: string[] = [];
    for (const file of await scan("f/**/*.ts")) {
      const code = codeOf(readFileSync(file, "utf8"));
      if (
        // `"!console"`だけは、一覧のAPIの絞り込み(Console自身のジョブを除く)で、ジョブの振り分け先ではない。
        /\bJobService\s*\.\s*run\w*|\btag_override\b|\btag\s*:\s*["'`](?!!console["'`])/.test(
          code,
        )
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
