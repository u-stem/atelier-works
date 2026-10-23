import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  codeOf,
  DISCORD_WEBHOOK_URL,
  GITHUB_TOKEN,
  mentions,
  nonLiteralVariableReads,
  relative,
  relativeImports,
  scan,
  secretVariablePaths,
  sourcesReachableFrom,
  unfollowableImports,
  yamlOf,
} from "./worker_boundary_scan.ts";

// Console用workerは、DBと`wmill.getVariable()`でsecret変数に届く。
// 境界を保つため、tag: consoleのscriptがどのsecret変数を読むかを、importをたどって数える。
// - github_tokenを読んでよいのは、approval_decideとretry_work_itemだけ。
// - その2つも、github_token以外のsecret変数は読まない。
// - audit_kickoff、notice_resolve、manual_intake_submitは、どのsecret変数も読まない。
//   Consoleから押せる操作に、外向きの資格情報を持たせないためである。
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
//   evalとFunction、実行時に書き換わるファイル。これらはコードのレビューで見る。

const MAY_READ_GITHUB_TOKEN = [
  "f/factory/approval_decide",
  "f/factory/retry_work_item",
];
const READS_NO_SECRET = [
  "f/factory/audit_kickoff",
  "f/factory/notice_resolve",
  "f/factory/manual_intake_submit",
];

/**
 * 引数が文字列リテラルでないgetVariable()の呼び出しのうち、許すもの。
 * 呼び出し側が定数だけを渡すことを確かめた箇所に限り、理由を書く。
 */
const NON_LITERAL_VARIABLE_READS: Readonly<Record<string, string>> = {
  "f/factory/lib/config.ts":
    "loadConfigの引数getResource(注入された関数)。呼び出し側は、リテラルのwmill.getResource(...)を包んで渡す",
  "f/factory/steps/console_query.ts":
    "deployed_shaの読み取りの依存(deps.getVariable)。呼び出し側は定数DEPLOYED_SHA_VARIABLEだけを渡す",
};

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

  test("flags an alias of getVariable that is not called", () => {
    expect(
      nonLiteralVariableReads("const read = wmill.getVariable; read(p);"),
    ).not.toEqual([]);
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
