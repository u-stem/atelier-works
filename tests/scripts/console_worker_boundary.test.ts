import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORBIDDEN_EXACT_PATHS } from "../../f/factory/lib/protected_paths.ts";
import {
  codeOf,
  DISCORD_WEBHOOK_URL,
  datatableStringSql,
  envUses,
  escapeHatches,
  filesWithToolDependencies,
  GITHUB_TOKEN,
  mentions,
  nonLiteralVariableReads,
  relative,
  relativeImports,
  type SdkAllowance,
  scan,
  sdkFindings,
  sdkViolations,
  sdkViolationsReachableFrom,
  secretVariablePaths,
  sourcesReachableFrom,
  transpilerImports,
  unfollowableImports,
  yamlOf,
} from "./worker_boundary_scan.ts";

// Console用workerは、DBと`wmill.getVariable()`でsecret変数に届く。
// 境界を保つため、tag: consoleのscriptがどのsecret変数を読むかを、importをたどって数える。
// - github_tokenを読んでよいのは、approval_decideとretry_work_itemだけ。
// - その2つも、github_token以外のsecret変数は読まない。
// - audit_kickoff、notice_resolve、manual_intake_submit、console_holds、hold_release、freeze_release、
//   console_jobs、console_schedules、console_configは、どのsecret変数も読まない。
//   Consoleから押せる操作に、外向きの資格情報を持たせないためである。
// - console_jobs、console_schedules、console_configは、SDKの呼び出しも許可表に絞る。
//   `<X>Service.<method>`と`wmill.<member>`の使用を、importでたどれるファイルの和に当て、
//   別名、名前付きimport、fetch、WM_TOKEN、深いパスのimportを禁じる。走査は`worker_boundary_scan.ts`の`sdkFindings`にある。
//
// 走査の方法と限界:
// - 本文はBun.TranspilerでTypeScriptを落としたコードを調べる。コメントと型の中の文字列は数えない。
// - 相対importと、副作用だけのimport、再エクスポート、リテラルの動的importをたどる。
// - たどれない形が現れたら、走査の穴になるのでテストを落とす。
//   絶対パス(/f/...)とf/・u/で始まるimport、require、引数が単純な文字列リテラルでないimport()。
// - コード中のgetVariableとgetResourceの出現をすべて数え、`.name("literal")`の形の呼び出しで説明できる分を引く。
//   残りが1つでもあれば落とす。添字アクセス、分割代入、名前付きimport、別名への代入、
//   引数が変数や組み立てた文字列の呼び出し、注入された関数の呼び出しが残る。
//   文字列とテンプレートの文字部分、正規表現の中の言及は数えない。
//   例外は、呼び出し側が定数だけを渡すことを確かめた箇所で、下の許可リストに理由を書く。
// - script.yamlに$var:と$res:の参照があれば落とす。入力の既定値で変数を読めるためである。
// - 見ないもの: 文字列を組み立てて作ったsecretのパス、環境変数や DB を経由して受け取る名前、
//   実行時に書き換わるファイル、`Bun["env"]`のように添字で名前を組み立てる参照(`Bun[`の添字は禁じるが、
//   文字列の連結で作った名前は見ない)、割り算を正規表現リテラルと読み違えた箇所の中身(骨組みが
//   その間のコードを落とす)、`eval`と`Function`と`.constructor`を、字句の禁止で見つけられない書き方
//   (識別子を連結して呼ぶ形など)、第三者パッケージの中身。
//   これらはコードのレビューで見る。3つのscriptがimportでたどれるファイルは、すべて保護パスの中にあり、
//   変更は人がレビューする。下の「見ないもの」を確かめることが、レビューの観点になる。

const MAY_READ_GITHUB_TOKEN = [
  "f/factory/approval_decide",
  "f/factory/retry_work_item",
];
const READS_NO_SECRET = [
  "f/factory/audit_kickoff",
  "f/factory/notice_resolve",
  "f/factory/manual_intake_submit",
  "f/factory/console_holds",
  "f/factory/hold_release",
  "f/factory/freeze_release",
  "f/factory/console_jobs",
  "f/factory/console_schedules",
  "f/factory/console_config",
];

/**
 * SDKの呼び出しを、script別の許可表に絞るscript。
 * ジョブ、schedule、設定を読むscriptは、これ以外のSDKの呼び出しを持たない。
 * 許可表は、importでたどれるファイルの和に当てる。`datatable`は、失敗の保存済みの原因を読むために使う。
 * 別名、名前付きimport、`fetch`、`WM_TOKEN`、深いパスのimportなども、この3つには許さない。
 */
const SDK_ALLOWED: Readonly<Record<string, SdkAllowance>> = {
  "f/factory/console_jobs": {
    services: [
      "JobService.getJob",
      "JobService.getJobLogs",
      "JobService.getCompletedJobResult",
      "JobService.listJobs",
      "JobService.listQueue",
    ],
    members: ["getWorkspace", "datatable"],
  },
  "f/factory/console_schedules": {
    services: [
      "ScheduleService.listSchedules",
      "ScheduleService.listSchedulesWithJobs",
      "JobService.listQueue",
    ],
    members: ["getWorkspace"],
  },
  "f/factory/console_config": {
    services: ["ResourceService.getResourceValue"],
    members: ["getWorkspace"],
  },
};

/**
 * 引数が文字列リテラルでないgetVariable()の呼び出しのうち、許すもの。
 * 呼び出し側が定数だけを渡すことを確かめた箇所に限り、理由を書く。
 */
const NON_LITERAL_VARIABLE_READS: Readonly<Record<string, string>> = {
  "f/factory/lib/config.ts":
    "loadConfigの引数getResource(注入された関数)。呼び出し側は、リテラルのwmill.getResource(...)を包んで渡す",
  "f/factory/steps/console_query.ts":
    "deployed_shaの読み取りの依存(deps.getVariable)。呼び出し側は定数DEPLOYED_SHA_VARIABLEだけを渡す",
  "f/factory/lib/freeze_apply.ts":
    "注入されたsdkの呼び出し(sdk.getVariable)。呼び出し側は定数FREEZE_VARIABLE_PATHだけを渡す。変数f/factory/freezesはsecretではない",
  "f/factory/console_config.ts":
    "getResourceValueの1回の呼び出し。引数をリテラルのf/factory/factory_configに固定することは、sdkFindingsが確かめる",
};

/**
 * `process.env`を読んでよいファイルと、読んでよいキー。
 * ジョブ、schedule、設定を読む3つのscriptと、importでたどれるファイルは、ここに無いキーを読まない。
 * 環境全体の列挙、添字の読み取り、`process`の別名は、表に関わらず禁じる。
 */
const ENV_ALLOWED: Readonly<Record<string, readonly string[]>> = {};

async function consoleScripts(): Promise<string[]> {
  const paths: string[] = [];
  for (const file of await scan("f/**/*.script.yaml")) {
    if ((await yamlOf(file)).tag === "console") {
      paths.push(file.replace(/\.script\.yaml$/, ""));
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
    expect(unfollowableImports("const m = await import(path);")).not.toEqual(
      [],
    );
  });

  test("flags a dynamic import built by concatenation", () => {
    expect(
      unfollowableImports('const m = await import("./a" + name);'),
    ).not.toEqual([]);
  });

  test("flags a dynamic import with a template", () => {
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 走査の入力にする文字列である
      unfollowableImports("const m = await import(`./a/${name}.ts`);"),
    ).not.toEqual([]);
  });

  test("flags require", () => {
    expect(unfollowableImports('const m = require("./x.js");')).not.toEqual([]);
  });

  test("flags an absolute import", () => {
    expect(
      unfollowableImports('import { x } from "/f/factory/lib/x.ts";'),
    ).not.toEqual([]);
  });

  test("flags an import that starts with f/", () => {
    expect(
      unfollowableImports('import { x } from "f/factory/lib/x.ts";'),
    ).not.toEqual([]);
  });

  test("does not flag a relative import", () => {
    expect(unfollowableImports('import { x } from "./x.ts";')).toEqual([]);
  });

  test("does not flag a dynamic import with a plain literal", () => {
    expect(unfollowableImports('const m = await import("./x.ts");')).toEqual(
      [],
    );
  });

  test("does not flag a comment that mentions import(", () => {
    expect(unfollowableImports("// import(path) is not used\n")).toEqual([]);
  });
});

describe("the variable read scan", () => {
  test("accepts a plain string literal", () => {
    expect(
      nonLiteralVariableReads('await wmill.getVariable("f/factory/x");'),
    ).toEqual([]);
  });

  test("accepts getResource with a plain string literal", () => {
    expect(
      nonLiteralVariableReads('await wmill.getResource("f/factory/c");'),
    ).toEqual([]);
  });

  test("flags an identifier argument", () => {
    expect(
      nonLiteralVariableReads("await wmill.getVariable(path);"),
    ).not.toEqual([]);
  });

  test("flags a concatenated argument", () => {
    expect(
      nonLiteralVariableReads('await wmill.getVariable("f/factory/" + name);'),
    ).not.toEqual([]);
  });

  test("flags a template with a substitution", () => {
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 走査の入力にする文字列である
      nonLiteralVariableReads("await wmill.getVariable(`f/factory/${name}`);"),
    ).not.toEqual([]);
  });

  test("flags getResource with an identifier argument", () => {
    expect(
      nonLiteralVariableReads("await wmill.getResource(path);"),
    ).not.toEqual([]);
  });

  test("does not flag a mention in a comment", () => {
    expect(nonLiteralVariableReads("// getVariable(path)\n")).toEqual([]);
  });

  test("flags a named import of getVariable", () => {
    expect(
      nonLiteralVariableReads(
        'import { getVariable } from "windmill-client@1.817.0"; getVariable("x");',
      ),
    ).not.toEqual([]);
  });

  test("flags a destructuring of getVariable", () => {
    expect(
      nonLiteralVariableReads("const { getVariable } = wmill; getVariable(p);"),
    ).not.toEqual([]);
  });

  test("flags getVariableValue on a service", () => {
    expect(
      nonLiteralVariableReads(
        "await sdk.VariableService.getVariableValue({path:p});",
      ),
    ).not.toEqual([]);
  });

  test("flags getResourceValueInterpolated", () => {
    expect(
      nonLiteralVariableReads(
        "await sdk.ResourceService.getResourceValueInterpolated({path:p});",
      ),
    ).not.toEqual([]);
  });

  test("flags getResourceValue, so that every use is listed with a reason", () => {
    expect(
      nonLiteralVariableReads(
        'await sdk.ResourceService.getResourceValue({path:"f/factory/factory_config"});',
      ),
    ).not.toEqual([]);
  });

  test("flags an alias of getVariable that is not called", () => {
    expect(
      nonLiteralVariableReads("const read = wmill.getVariable; read(p);"),
    ).not.toEqual([]);
  });
});

describe("the SDK use scan", () => {
  const ALLOWED = {
    services: ["JobService.getJob", "ResourceService.getResourceValue"],
    members: ["getWorkspace", "datatable"],
  };
  const JOB = 'import * as wmill from "windmill-client@1.817.0";\n';

  test("reads a service call through the namespace import", () => {
    expect(
      sdkFindings(`${JOB}await wmill.JobService.getJob({ id });`).used,
    ).toEqual(["JobService.getJob"]);
  });

  test("reads a function call through the default import", () => {
    expect(
      sdkFindings(
        'import wmillDefault, * as wmill from "windmill-client@1.817.0";\nwmillDefault.getWorkspace();',
      ).used,
    ).toEqual(["getWorkspace"]);
  });

  test("accepts an allowed service call", () => {
    expect(
      sdkViolations(`${JOB}await wmill.JobService.getJob({ id });`, ALLOWED),
    ).toEqual([]);
  });

  test("flags a service call that is not on the allowance", () => {
    expect(
      sdkViolations(
        `${JOB}await wmill.JobService.cancelQueuedJob({});`,
        ALLOWED,
      ),
    ).not.toEqual([]);
  });

  test("flags every VariableService call", () => {
    expect(
      sdkViolations(
        `${JOB}await wmill.VariableService.getVariable({ path: "x" });`,
        ALLOWED,
      ),
    ).not.toEqual([]);
  });

  test("flags a function that is not on the allowance", () => {
    expect(
      sdkViolations(`${JOB}await wmill.getVariable("f/factory/x");`, ALLOWED),
    ).not.toEqual([]);
  });

  test("flags the interpolating resource read", () => {
    expect(
      sdkViolations(
        `${JOB}await wmill.ResourceService.getResourceValueInterpolated({ path: "f/factory/factory_config" });`,
        ALLOWED,
      ),
    ).not.toEqual([]);
  });

  test("flags an alias of the namespace import", () => {
    expect(
      sdkFindings(`${JOB}const w = wmill;\nawait w.JobService.getJob({});`)
        .problems,
    ).not.toEqual([]);
  });

  test("flags a service kept in a variable", () => {
    expect(
      sdkFindings(`${JOB}const jobs = wmill.JobService;`).problems,
    ).not.toEqual([]);
  });

  test("flags a bracket access on the namespace", () => {
    expect(
      sdkFindings(`${JOB}await wmill["VariableService"].getVariable({});`)
        .problems,
    ).not.toEqual([]);
  });

  test("flags an optional chain on the namespace", () => {
    expect(
      sdkFindings(`${JOB}await wmill?.JobService.getJob({});`).problems,
    ).not.toEqual([]);
  });

  test("flags the namespace passed to another function", () => {
    expect(sdkFindings(`${JOB}ports(wmill);`).problems).not.toEqual([]);
  });

  test("flags a named import from the client", () => {
    expect(
      sdkFindings(
        'import { getVariable } from "windmill-client@1.817.0";\ngetVariable("x");',
      ).problems,
    ).not.toEqual([]);
  });

  test("flags a named import next to the default import", () => {
    expect(
      sdkFindings(
        'import wmillDefault, { JobService } from "windmill-client@1.817.0";\nJobService.getJob({});',
      ).problems,
    ).not.toEqual([]);
  });

  test("flags a deep path import of the client", () => {
    expect(
      sdkFindings(
        'import * as s from "windmill-client@1.817.0/dist/services.gen";',
      ).problems,
    ).not.toEqual([]);
  });

  test("flags an import of another package", () => {
    expect(
      sdkFindings('import { readFileSync } from "node:fs";').problems,
    ).not.toEqual([]);
  });

  test("accepts a relative import", () => {
    expect(sdkFindings('import { x } from "./lib/x.ts";').problems).toEqual([]);
  });

  test("flags a dynamic import of the client", () => {
    expect(
      sdkFindings('const m = await import("windmill-client@1.817.0");')
        .problems,
    ).not.toEqual([]);
  });

  test("flags a call to fetch", () => {
    expect(
      sdkFindings('const r = await fetch("http://x/api");').problems,
    ).not.toEqual([]);
  });

  test("flags fetch reached through globalThis", () => {
    expect(
      sdkFindings('const r = await globalThis.fetch("http://x");').problems,
    ).not.toEqual([]);
  });

  test("accepts the fetch method of a statement handle", () => {
    expect(
      sdkFindings("const rows = await statement.fetch();").problems,
    ).toEqual([]);
  });

  test("accepts a fetch property in an object literal", () => {
    expect(
      sdkFindings("const handle = { fetch: async () => [] };").problems,
    ).toEqual([]);
  });

  test("flags WM_TOKEN, even when it is only a string", () => {
    expect(
      sdkFindings('const t = process.env["WM_TOKEN"];').problems,
    ).not.toEqual([]);
  });

  test("flags BASE_INTERNAL_URL", () => {
    expect(
      sdkFindings("const u = process.env.BASE_INTERNAL_URL;").problems,
    ).not.toEqual([]);
  });

  test("flags BASE_URL", () => {
    expect(sdkFindings("const u = process.env.BASE_URL;").problems).not.toEqual(
      [],
    );
  });

  test("flags OpenAPI", () => {
    expect(sdkFindings("OpenAPI.TOKEN = 'x';").problems).not.toEqual([]);
  });

  test("accepts the literal config path for getResourceValue", () => {
    expect(
      sdkFindings(
        `${JOB}await wmill.ResourceService.getResourceValue({ workspace, path: "f/factory/factory_config" });`,
      ).problems,
    ).toEqual([]);
  });

  test("flags getResourceValue with another literal path", () => {
    expect(
      sdkFindings(
        `${JOB}await wmill.ResourceService.getResourceValue({ workspace, path: "f/factory/other" });`,
      ).problems,
    ).not.toEqual([]);
  });

  test("flags getResourceValue with a path in a variable", () => {
    expect(
      sdkFindings(
        `${JOB}await wmill.ResourceService.getResourceValue({ workspace, path });`,
      ).problems,
    ).not.toEqual([]);
  });

  test("flags updateResourceValue with a path in a variable", () => {
    expect(
      sdkFindings(
        `${JOB}await wmill.ResourceService.updateResourceValue({ workspace, path, requestBody: {} });`,
      ).problems,
    ).not.toEqual([]);
  });

  test("does not count a mention in a comment", () => {
    expect(
      sdkFindings(`${JOB}// wmill.VariableService.getVariable and fetch(url)\n`)
        .problems,
    ).toEqual([]);
  });

  test("does not count a mention in a string", () => {
    expect(
      sdkFindings(`${JOB}const s = "wmill.VariableService.getVariable";`).used,
    ).toEqual([]);
  });

  test("flags a namespace re-export of the client", () => {
    expect(
      sdkFindings('export * as sdk from "windmill-client@1.817.0";').problems,
    ).not.toEqual([]);
  });

  test("flags a star re-export of the client", () => {
    expect(
      sdkFindings('export * from "windmill-client@1.817.0";').problems,
    ).not.toEqual([]);
  });

  test("flags a named re-export of the client", () => {
    expect(
      sdkFindings('export { VariableService } from "windmill-client@1.817.0";')
        .problems,
    ).not.toEqual([]);
  });

  test("accepts one namespace import next to the allowed default import", () => {
    expect(
      sdkFindings(
        'import wmillDefault, * as wmill from "windmill-client@1.817.0";',
      ).problems,
    ).toEqual([]);
  });

  test("flags a named import that reaches the client through a re-exporting file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-reexport-"));
    try {
      writeFileSync(
        join(dir, "entry.ts"),
        'import { VariableService } from "./reexport.ts";\nVariableService.getVariable({});\n',
      );
      writeFileSync(
        join(dir, "reexport.ts"),
        'export * from "windmill-client@1.817.0";\n',
      );
      expect(
        sdkViolationsReachableFrom(join(dir, "entry"), {
          services: [],
          members: [],
        }),
      ).not.toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("flags global.fetch", () => {
    expect(sdkFindings('await global.fetch("x", {});').problems).not.toEqual(
      [],
    );
  });

  test("flags a fetch name that is built from pieces on global", () => {
    expect(
      sdkFindings('await global["fe" + "tch"]("x", {});').problems,
    ).not.toEqual([]);
  });

  test("flags self.fetch", () => {
    expect(sdkFindings('await self.fetch("x", {});').problems).not.toEqual([]);
  });

  test("flags window.fetch", () => {
    expect(sdkFindings('await window.fetch("x", {});').problems).not.toEqual(
      [],
    );
  });

  test("does not flag a property that is named self", () => {
    expect(sdkFindings("const a = job.self;").problems).toEqual([]);
  });

  test("flags require held in a variable", () => {
    expect(
      sdkFindings('const load = require; load("node:child_process");').problems,
    ).not.toEqual([]);
  });

  test("flags a call of require", () => {
    expect(sdkFindings('const fs = require("node:fs");').problems).not.toEqual(
      [],
    );
  });

  test("flags require taken from import.meta", () => {
    expect(
      sdkFindings("const { require: load } = import.meta;").problems,
    ).not.toEqual([]);
  });

  test("flags import.meta.env", () => {
    expect(sdkFindings("const t = import.meta.env.X;").problems).not.toEqual(
      [],
    );
  });

  test("flags import.meta by itself", () => {
    expect(sdkFindings("const m = import.meta;").problems).not.toEqual([]);
  });

  test("flags new Worker", () => {
    expect(sdkFindings('new Worker("w.js");').problems).not.toEqual([]);
  });

  test("does not flag a key that is named require", () => {
    expect(sdkFindings("const a = { require: 1 };").problems).toEqual([]);
  });

  test("does not flag a property that is named Worker", () => {
    expect(sdkFindings("const a = job.Worker;").problems).toEqual([]);
  });

  test("flags a spread that overrides the resource path", () => {
    expect(
      sdkFindings(
        `${JOB}await wmill.ResourceService.getResourceValue({ ...opts, workspace, path: "f/factory/factory_config" });`,
      ).problems,
    ).not.toEqual([]);
  });

  test("flags a spread after the resource path", () => {
    expect(
      sdkFindings(
        `${JOB}await wmill.ResourceService.getResourceValue({ workspace, path: "f/factory/factory_config", ...opts });`,
      ).problems,
    ).not.toEqual([]);
  });

  test("flags a second path key that overrides the first", () => {
    expect(
      sdkFindings(
        `${JOB}await wmill.ResourceService.getResourceValue({ path: "f/factory/factory_config", workspace, path: other });`,
      ).problems,
    ).not.toEqual([]);
  });

  test("flags a key the call does not need", () => {
    expect(
      sdkFindings(
        `${JOB}await wmill.ResourceService.getResourceValue({ workspace, path: "f/factory/factory_config", extra: 1 });`,
      ).problems,
    ).not.toEqual([]);
  });

  const GET = `${JOB}await wmill.ResourceService.getResourceValue(`;
  const UPDATE = `${JOB}await wmill.ResourceService.updateResourceValue(`;
  const CONFIG = '"f/factory/factory_config"';

  test("flags getResourceValue with a requestBody", () => {
    expect(
      sdkFindings(`${GET}{ workspace, path: ${CONFIG}, requestBody: {} });`)
        .problems,
    ).not.toEqual([]);
  });

  test("accepts updateResourceValue with the literal path and a requestBody", () => {
    expect(
      sdkFindings(
        `${UPDATE}{ workspace, path: ${CONFIG}, requestBody: { value: { a: 1, b: [2, 3] } } });`,
      ).problems,
    ).toEqual([]);
  });

  test("accepts a requestBody that has a path key of its own", () => {
    expect(
      sdkFindings(
        `${UPDATE}{ workspace, path: ${CONFIG}, requestBody: { value: { path: "x" } } });`,
      ).problems,
    ).toEqual([]);
  });

  test("accepts a requestBody with brackets and commas inside strings", () => {
    expect(
      sdkFindings(
        `${UPDATE}{ workspace, path: ${CONFIG}, requestBody: { value: "a, ) } (" } });`,
      ).problems,
    ).toEqual([]);
  });

  test("flags a path key after the requestBody", () => {
    expect(
      sdkFindings(
        `${UPDATE}{ workspace, path: ${CONFIG}, requestBody: { value: {} }, path: other });`,
      ).problems,
    ).not.toEqual([]);
  });

  test("flags a spread after the requestBody", () => {
    expect(
      sdkFindings(
        `${UPDATE}{ workspace, path: ${CONFIG}, requestBody: { value: {} }, ...opts });`,
      ).problems,
    ).not.toEqual([]);
  });

  test("flags a spread before the literal path of updateResourceValue", () => {
    expect(
      sdkFindings(
        `${UPDATE}{ ...opts, workspace, path: ${CONFIG}, requestBody: {} });`,
      ).problems,
    ).not.toEqual([]);
  });

  test("flags a second requestBody", () => {
    expect(
      sdkFindings(
        `${UPDATE}{ workspace, path: ${CONFIG}, requestBody: {}, requestBody: {} });`,
      ).problems,
    ).not.toEqual([]);
  });

  test("flags a computed key after the requestBody", () => {
    expect(
      sdkFindings(
        `${UPDATE}{ workspace, path: ${CONFIG}, requestBody: {}, [key]: other });`,
      ).problems,
    ).not.toEqual([]);
  });

  test("flags updateResourceValue with a second argument", () => {
    expect(
      sdkFindings(
        `${UPDATE}{ workspace, path: ${CONFIG}, requestBody: {} }, extra);`,
      ).problems,
    ).not.toEqual([]);
  });

  test("flags updateResourceValue without the workspace", () => {
    expect(
      sdkFindings(`${UPDATE}{ path: ${CONFIG}, requestBody: {} });`).problems,
    ).not.toEqual([]);
  });
});

describe("the process environment scan", () => {
  test("lists a key that is read by name", () => {
    expect(envUses("const u = process.env.WM_USERNAME;").keys).toEqual([
      "WM_USERNAME",
    ]);
  });

  test("accepts a key that is read by name", () => {
    expect(envUses("const u = process.env.WM_USERNAME;").problems).toEqual([]);
  });

  test("flags the whole environment passed to a function", () => {
    expect(envUses("Object.values(process.env);").problems).not.toEqual([]);
  });

  test("flags a bracket access", () => {
    expect(envUses('const t = process.env["WM_TOKEN"];').problems).not.toEqual(
      [],
    );
  });

  test("flags an alias of process", () => {
    expect(envUses("const p = process; p.env.X;").problems).not.toEqual([]);
  });

  test("flags a destructuring of the environment", () => {
    expect(envUses("const { WM_TOKEN } = process.env;").problems).not.toEqual(
      [],
    );
  });

  test("flags Bun.env", () => {
    expect(envUses("const x = Bun.env.WM_TOKEN;").problems).not.toEqual([]);
  });

  test("does not count a mention in a comment", () => {
    expect(envUses("// process.env.X\nconst a = 1;")).toEqual({
      keys: [],
      problems: [],
    });
  });

  test("does not count a mention in a string", () => {
    expect(envUses('const s = "process.env.X";')).toEqual({
      keys: [],
      problems: [],
    });
  });
});

describe("the escape hatch scan", () => {
  test("flags a constructor access", () => {
    expect(escapeHatches("const f = x.constructor;")).not.toEqual([]);
  });

  test("flags a constructor access by a string key", () => {
    expect(escapeHatches('const f = x["constructor"];')).not.toEqual([]);
  });

  test("flags eval", () => {
    expect(escapeHatches('eval("1");')).not.toEqual([]);
  });

  test("flags an indirect eval", () => {
    expect(escapeHatches('(0, eval)("1");')).not.toEqual([]);
  });

  test("flags new Function", () => {
    expect(escapeHatches('new Function("return 1");')).not.toEqual([]);
  });

  test("flags a call of Function", () => {
    expect(escapeHatches('Function("return 1")();')).not.toEqual([]);
  });

  test("flags a subscript of Bun", () => {
    expect(escapeHatches('const e = Bun["env"];')).not.toEqual([]);
  });

  test("does not flag an identifier that only contains eval", () => {
    expect(escapeHatches("const evaluate = 1; retrieval(2);")).toEqual([]);
  });

  test("does not count a mention in a comment", () => {
    expect(escapeHatches("// eval( and .constructor\nconst a = 1;")).toEqual(
      [],
    );
  });

  test("does not flag a property that is named Function", () => {
    expect(escapeHatches("const f = job.Function;")).toEqual([]);
  });

  test("does not flag the word Function in a string", () => {
    expect(escapeHatches('const s = "a Function";')).toEqual([]);
  });

  test("does not flag a type named Function", () => {
    expect(escapeHatches("const f: Function = () => 1;")).toEqual([]);
  });
});

describe("the SQL given as a string", () => {
  test("flags sql.query with a string", () => {
    expect(
      datatableStringSql(
        'const sql = wmill.datatable(); sql.query("select 1");',
      ),
    ).not.toEqual([]);
  });

  test("flags sql.raw", () => {
    expect(
      datatableStringSql("const q = sql`select ${sql.raw(x)}`;"),
    ).not.toEqual([]);
  });

  test("accepts the tagged template", () => {
    expect(
      datatableStringSql(
        "const rows = await sql`select 1 where a = ${a}`.fetch();",
      ),
    ).toEqual([]);
  });

  test("does not count a mention in a string", () => {
    expect(datatableStringSql('const s = "sql.query(x)";')).toEqual([]);
  });
});

describe("the comment handling", () => {
  test("does not count a name that only appears in a block comment", () => {
    expect(
      codeOf('/* "f/factory/github_token" */ const y = 1;').includes(
        GITHUB_TOKEN,
      ),
    ).toBe(false);
  });

  test("does not count a name that only appears in a line comment", () => {
    expect(
      codeOf('const y = 1; // "f/factory/github_token"').includes(GITHUB_TOKEN),
    ).toBe(false);
  });

  test("counts code that follows a block comment on the same line", () => {
    expect(
      codeOf(
        '/* note */ export const leak = "f/factory/github_token";',
      ).includes(GITHUB_TOKEN),
    ).toBe(true);
  });

  test("counts code that follows a doc comment on its last line", () => {
    expect(
      codeOf(
        '/**\n * doc\n */ export const leak = "f/factory/github_token";',
      ).includes(GITHUB_TOKEN),
    ).toBe(true);
  });
});

describe("what the console scripts reach", () => {
  test("no file a console script reaches has an import the scan cannot follow", async () => {
    const offenders = new Set<string>();
    for (const path of await consoleScripts()) {
      for (const [file, source] of sourcesReachableFrom(path)) {
        if (unfollowableImports(source).length > 0) {
          offenders.add(relative(file));
        }
      }
    }
    expect([...offenders]).toEqual([]);
  });

  test("every variable read in a reached file has a literal argument, except the listed ones", async () => {
    const offenders = new Set<string>();
    for (const path of await consoleScripts()) {
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

  test("no console script declares a variable or resource reference in its inputs", async () => {
    const referencing: string[] = [];
    for (const path of await consoleScripts()) {
      const yaml = await Bun.file(`${path}.script.yaml`).text();
      if (/\$(?:var|res):/.test(yaml)) referencing.push(path);
    }
    expect(referencing).toEqual([]);
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

describe("the scripts restricted to an SDK allowance", () => {
  const RESTRICTED = Object.keys(SDK_ALLOWED);

  test.each(RESTRICTED)(
    "%s calls nothing of the SDK outside its allowance",
    (path) => {
      const allowed = SDK_ALLOWED[path];
      expect(
        allowed === undefined
          ? ["no allowance"]
          : sdkViolationsReachableFrom(path, allowed),
      ).toEqual([]);
    },
  );

  test.each(RESTRICTED)("%s uses every entry of its allowance", (path) => {
    const allowed = SDK_ALLOWED[path];
    const used = new Set<string>();
    for (const source of sourcesReachableFrom(path).values()) {
      for (const use of sdkFindings(source).used) used.add(use);
    }
    const unused = [
      ...(allowed?.services ?? []),
      ...(allowed?.members ?? []),
    ].filter((entry) => !used.has(entry));
    expect(unused).toEqual([]);
  });

  test.each(RESTRICTED)(
    "%s reaches only files that are protected paths",
    (path) => {
      const unprotected = [...sourcesReachableFrom(path).keys()]
        .map(relative)
        .filter((file) => !FORBIDDEN_EXACT_PATHS.includes(file));
      expect(unprotected).toEqual([]);
    },
  );

  test("the reached files import nothing outside the protected set and the client", () => {
    const outside: string[] = [];
    for (const path of RESTRICTED) {
      for (const [file, source] of sourcesReachableFrom(path)) {
        for (const spec of transpilerImports(source)) {
          if (
            !spec.startsWith(".") &&
            !/^windmill-client(?:@[\w.+-]+)?$/.test(spec)
          ) {
            outside.push(`${relative(file)}: ${spec}`);
          }
        }
      }
    }
    expect(outside).toEqual([]);
  });

  test("the restricted scripts reach no file or process tool", () => {
    expect(filesWithToolDependencies(RESTRICTED)).toEqual([]);
  });

  test.each(RESTRICTED)("%s reaches no escape hatch", (path) => {
    const offenders: string[] = [];
    for (const [file, source] of sourcesReachableFrom(path)) {
      for (const found of escapeHatches(source)) {
        offenders.push(`${relative(file)}: ${found}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test.each(RESTRICTED)(
    "%s gives no SQL to the datatable as a string",
    (path) => {
      const offenders: string[] = [];
      for (const [file, source] of sourcesReachableFrom(path)) {
        for (const found of datatableStringSql(source)) {
          offenders.push(`${relative(file)}: ${found}`);
        }
      }
      expect(offenders).toEqual([]);
    },
  );

  test("every restricted script is on the list of scripts that read no secret", () => {
    expect(
      RESTRICTED.filter((path) => !READS_NO_SECRET.includes(path)),
    ).toEqual([]);
  });

  test("the config script names its resource path as a literal", () => {
    const source = readFileSync("f/factory/console_config.ts", "utf8");
    expect(sdkFindings(source).problems).toEqual([]);
  });

  test("the config script does not read the config with the interpolating call", () => {
    const source = readFileSync("f/factory/console_config.ts", "utf8");
    expect(codeOf(source)).not.toContain("getResourceValueInterpolated");
  });

  test("the only read of the config script that the name scan cannot explain is its fixed getResourceValue", () => {
    const source = readFileSync("f/factory/console_config.ts", "utf8");
    expect(nonLiteralVariableReads(source)).toEqual(["1 unexplained"]);
  });

  test.each(RESTRICTED)(
    "%s reads no process environment but the listed keys",
    (path) => {
      const offenders: string[] = [];
      for (const [file, source] of sourcesReachableFrom(path)) {
        const found = envUses(source);
        const allowed = ENV_ALLOWED[relative(file)] ?? [];
        for (const problem of found.problems) {
          offenders.push(`${relative(file)}: ${problem}`);
        }
        for (const key of found.keys) {
          if (!allowed.includes(key))
            offenders.push(`${relative(file)}: ${key}`);
        }
      }
      expect(offenders).toEqual([]);
    },
  );

  test.each(RESTRICTED)(
    "%s reaches no SQL that writes or changes the schema",
    (path) => {
      // 検査はテンプレートリテラルだけを見る。文字列で渡すSQL(`sql.query(...)`、`sql.raw(...)`)は、
      // 上の`datatableStringSql`が別に禁じる。
      // 大文字のSQLの語は単独で、小文字でも書ける形は語の組で数える。文章中の英単語を数えないため。
      const upper =
        /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|COPY|CALL|GRANT)\b/;
      const phrases =
        /\b(?:insert\s+into|delete\s+from|drop\s+(?:table|index|view|schema)|alter\s+table|create\s+(?:table|index|view|schema|function)|update\s+[\w."]+\s+set)\b/i;
      const writes = {
        test: (text: string) => upper.test(text) || phrases.test(text),
      };
      const offenders: string[] = [];
      for (const [file, source] of sourcesReachableFrom(path)) {
        const templates = [
          ...codeOf(source).matchAll(/`((?:[^`\\]|\\.)*)`/g),
        ].map((match) => match[1] ?? "");
        for (const text of templates) {
          if (writes.test(text)) offenders.push(relative(file));
        }
      }
      expect([...new Set(offenders)]).toEqual([]);
    },
  );
});
