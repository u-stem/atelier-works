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

const GITHUB_TOKEN = "f/factory/github_token";
const DISCORD_WEBHOOK_URL = "f/factory/discord_webhook_url";

const MAY_READ_GITHUB_TOKEN = [
  "f/factory/approval_decide",
  "f/factory/retry_work_item",
];
const READS_NO_SECRET = ["f/factory/audit_kickoff", "f/factory/notice_resolve"];

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

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** コメントと型を落としたJavaScript。コメントの中の文字列で誤検知せず、行頭のブロックコメントの後ろのコードも残す。 */
function codeOf(source: string): string {
  return transpiler.transformSync(source);
}

/** `source`が相対パスで読み込む先。副作用だけのimport、再エクスポート、リテラルの動的importを含む。 */
function relativeImports(source: string): string[] {
  return transpiler
    .scanImports(source)
    .map((entry) => entry.path)
    .filter((path) => path.startsWith("."));
}

const SIMPLE_DYNAMIC_IMPORT = /^import\s*\(\s*(?:"[^"\\]*"|'[^'\\]*')\s*\)/;

/** 走査がたどれないimportの形。たどれない理由を返す。 */
function unfollowableImports(source: string): string[] {
  const found: string[] = [];
  for (const entry of transpiler.scanImports(source)) {
    if (entry.path.startsWith("/") || /^[fu]\//.test(entry.path)) {
      found.push(`non-relative import of ${entry.path}`);
    }
  }
  const code = codeOf(source);
  if (/\brequire\s*\(/.test(code)) found.push("require");
  for (const match of code.matchAll(/\bimport\s*\(/g)) {
    if (!SIMPLE_DYNAMIC_IMPORT.test(code.slice(match.index))) {
      found.push("dynamic import with a non-literal argument");
    }
  }
  return found;
}

const VARIABLE_NAME = /\b(?:getVariable|getResource)\b/g;
const LITERAL_CALL =
  /\.\s*(?:getVariable|getResource)\s*\(\s*(?:""|``)\s*[,)]/g;
const NAME_ONLY_STRING = /^["'](?:getVariable|getResource)["']$/;
const REGEX_PRECEDER =
  /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|in|of))\s*$/;

/**
 * 変換後のコードから、文字列、テンプレートの文字部分、正規表現リテラルの中身を落とした骨組み。
 * 文字列は`""`に、テンプレートは`` ` ` ``に置き換える。テンプレートの`${}`の中のコードは残す。
 * 名前だけの文字列(`"getVariable"`)は、添字アクセスに使えるので残す。
 * 文字列の中のgetVariableの言及(ログの文など)を、読み取りと数えないための前処理である。
 */
function codeSkeleton(code: string): string {
  let out = "";
  let i = 0;
  let braces = 0;
  const resume: number[] = [];

  const readTemplate = (): void => {
    while (i < code.length) {
      const ch = code[i];
      if (ch === "\\") {
        i += 2;
      } else if (ch === "`") {
        i += 1;
        out += "``";
        return;
      } else if (ch === "$" && code[i + 1] === "{") {
        i += 2;
        resume.push(braces);
        braces += 1;
        out += " ";
        return;
      } else {
        i += 1;
      }
    }
  };

  const skipQuoted = (quote: string): string => {
    const start = i;
    i += 1;
    while (i < code.length && code[i] !== quote) {
      i += code[i] === "\\" ? 2 : 1;
    }
    i += 1;
    return code.slice(start, i);
  };

  const skipRegex = (): void => {
    i += 1;
    let inClass = false;
    while (i < code.length) {
      const ch = code[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "[") inClass = true;
      else if (ch === "]") inClass = false;
      else if (ch === "/" && !inClass) break;
      i += 1;
    }
    i += 1;
    out += "//";
  };

  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'") {
      const literal = skipQuoted(ch);
      out += NAME_ONLY_STRING.test(literal) ? literal : '""';
    } else if (ch === "`") {
      i += 1;
      readTemplate();
    } else if (ch === "{") {
      braces += 1;
      out += ch;
      i += 1;
    } else if (ch === "}") {
      braces -= 1;
      i += 1;
      if (resume.length > 0 && resume[resume.length - 1] === braces) {
        resume.pop();
        readTemplate();
      } else {
        out += ch;
      }
    } else if (ch === "/" && REGEX_PRECEDER.test(out)) {
      skipRegex();
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/**
 * getVariable()かgetResource()の名前の出現のうち、`.name("literal")`の形の呼び出しで説明できないもの。
 * コード中の出現をすべて数え、説明できるものを引く。残りは、読み取りの対象を静的に決められない。
 * 添字アクセス(`w["getVariable"](p)`)、分割代入、名前付きimport、別名への代入、
 * 引数が変数や組み立てた文字列の呼び出し、注入された関数の呼び出しが残る。
 */
function nonLiteralVariableReads(source: string): string[] {
  const skeleton = codeSkeleton(codeOf(source));
  const unexplained =
    [...skeleton.matchAll(VARIABLE_NAME)].length -
    [...skeleton.matchAll(LITERAL_CALL)].length;
  return unexplained > 0 ? [`${String(unexplained)} unexplained`] : [];
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
    codeOf(source).includes(variablePath),
  );
}

async function scan(pattern: string): Promise<string[]> {
  const found: string[] = [];
  for await (const file of new Glob(pattern).scan(".")) found.push(file);
  return found.sort();
}

async function yamlOf(file: string): Promise<Record<string, unknown>> {
  const parsed: unknown = Bun.YAML.parse(await Bun.file(file).text());
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file}: not a YAML mapping`);
  }
  return Object.fromEntries(Object.entries(parsed));
}

async function consoleScripts(): Promise<string[]> {
  const paths: string[] = [];
  for (const file of await scan("f/**/*.script.yaml")) {
    if ((await yamlOf(file)).tag === "console") {
      paths.push(file.replace(/\.script\.yaml$/, ""));
    }
  }
  return paths;
}

async function secretVariablePaths(): Promise<string[]> {
  const paths: string[] = [];
  for (const file of await scan("f/factory/*.variable.yaml")) {
    if ((await yamlOf(file)).is_secret === true) {
      paths.push(file.replace(/\.variable\.yaml$/, ""));
    }
  }
  return paths;
}

const relative = (file: string) => file.replace(`${process.cwd()}/`, "");

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
