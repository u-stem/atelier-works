// 調査の入口を開ける門を固定する。
// 門は設定の値が真のときだけ開き、既定は閉じる。設定の読み込みは、門の結果だけから`investigate_enabled`を導く。
// このテストは保護パスに置く。門の条件や設定の読み込みを緩める変更が、このテストを書き換えて通らないようにするためである。
//
// 文字列の照合は`Bun.Transpiler`でコメントを落としてから行う。変換できないファイルは失敗として扱う(fail-closed)。
// 追えない形がある。識別子を連結や別名で組み立てる参照は数えられない。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFactoryConfig } from "../../f/factory/lib/config.ts";
import { isInvestigateEnabled } from "../../f/factory/lib/investigate_gate.ts";

const FACTORY_DIR = join(import.meta.dir, "../../f/factory");
const transpiler = new Bun.Transpiler({ loader: "ts" });

/** コメントを落としたJavaScript。変換できないときは例外を投げる。 */
function codeOf(path: string): string {
  return transpiler.transformSync(
    readFileSync(join(FACTORY_DIR, path), "utf8"),
  );
}

/** `f/factory`の下の、テストを除くすべての`.ts`の相対パス。 */
function productionSources(): string[] {
  return [...new Bun.Glob("**/*.ts").scanSync(FACTORY_DIR)]
    .filter((path) => !path.endsWith(".test.ts"))
    .sort();
}

/**
 * `investigate_enabled`の出現。キー、`.investigate_enabled`の読み、文字列、省略記法を区別せずに数える。
 * `investigate_enabled_x`のように識別子の続きになる綴りは数えない。
 */
const INVESTIGATE_ENABLED_TOKEN = /(?<![\w$])investigate_enabled(?![\w$])/g;

/**
 * `investigate_enabled`が出てよい本番のファイルと、出る数。
 * 型の宣言(`lib/types.ts`)は、変換で消える。
 * `lib/config.ts`の2つは、リソースの値を門へ渡す読みと、門の結果の導出のキーである。
 * 入口や実行のscriptが設定の値を読む呼び出しを足すときは、この表を同じ変更で直す。
 * 呼び出しの側で`{ ...config, investigate_enabled: ... }`と上書きする迂回は、ここで数が増えて見つかる。
 */
const ALLOWED_TOKENS: Readonly<Record<string, number>> = {
  "lib/config.ts": 2,
};

function scanCounts(pattern: RegExp): Record<string, number> {
  const found: Record<string, number> = {};
  for (const path of productionSources()) {
    const n = [...codeOf(path).matchAll(pattern)].length;
    if (n > 0) found[path] = n;
  }
  return found;
}

const RAW_CONFIG = {
  owners: [{ name: "octo-owner", kind: "user" }],
  trigger_label: "factory",
  allowed_labeler_associations: ["OWNER", "MEMBER", "COLLABORATOR"],
  model: "claude-opus-5-5",
  max_attempts: 3,
  max_turns: 40,
  max_budget_usd_per_run: 5,
  daily_budget_usd: 50,
  claude_timeout_sec: 1800,
  worktree_ttl_days: 7,
  factory_repo: "https://github.com/octo-owner/atelier-works",
  instance_name: "local",
  windmill_public_url: "http://127.0.0.1:8080",
};

describe("isInvestigateEnabled", () => {
  test("opens for the boolean true", () => {
    expect(isInvestigateEnabled(true)).toBe(true);
  });

  test("stays closed for the boolean false", () => {
    expect(isInvestigateEnabled(false)).toBe(false);
  });

  test("stays closed when the value is absent", () => {
    expect(isInvestigateEnabled(undefined)).toBe(false);
  });

  test.each([
    ["the string true", "true"],
    ["the number 1", 1],
    ["null", null],
    ["an object", { value: true }],
    ["an array", [true]],
    ["a reference to a variable", "$var:f/factory/x"],
  ])("stays closed for %s", (_name, value) => {
    expect(isInvestigateEnabled(value)).toBe(false);
  });
});

describe("the gate in lib/investigate_gate.ts", () => {
  const gate = codeOf("lib/investigate_gate.ts");

  test("imports nothing", () => {
    expect(gate).not.toMatch(/\bimport\b/);
  });

  test.each(["process.env", "Bun.env", "import.meta.env", "Date.now"])(
    "does not read %s",
    (reader) => {
      expect(gate.includes(reader)).toBe(false);
    },
  );
});

describe("the configuration that is read", () => {
  test("keeps the investigation closed when the resource does not say", () => {
    expect(parseFactoryConfig(RAW_CONFIG).investigate_enabled).toBe(false);
  });

  test("opens when the resource says true", () => {
    const config = parseFactoryConfig({
      ...RAW_CONFIG,
      investigate_enabled: true,
    });
    expect(config.investigate_enabled).toBe(true);
  });

  test("stays closed when the resource says false", () => {
    const config = parseFactoryConfig({
      ...RAW_CONFIG,
      investigate_enabled: false,
    });
    expect(config.investigate_enabled).toBe(false);
  });

  test("stays closed, without an exception, when the value is not a boolean", () => {
    const config = parseFactoryConfig({
      ...RAW_CONFIG,
      investigate_enabled: "true",
    });
    expect(config.investigate_enabled).toBe(false);
  });
});

describe("the gate in config.ts", () => {
  const config = codeOf("lib/config.ts");

  test("derives investigate_enabled from the gate only", () => {
    expect([
      ...config.matchAll(
        /\binvestigate_enabled:\s*isInvestigateEnabled\(\s*raw\.investigate_enabled\s*,?\s*\)\s*,/g,
      ),
    ]).toHaveLength(1);
  });

  test("calls the gate nowhere else in the file", () => {
    expect([...config.matchAll(/\bisInvestigateEnabled\(/g)]).toHaveLength(1);
  });

  test("mentions investigate_enabled in that derivation only", () => {
    expect([...config.matchAll(INVESTIGATE_ENABLED_TOKEN)]).toHaveLength(2);
  });

  test("does not declare a default for investigate_enabled", () => {
    expect(config).not.toMatch(/\bDEFAULTS\.investigate_enabled\b/);
  });

  test("imports the gate from lib/investigate_gate.ts", () => {
    expect(config).toMatch(
      /import\s*\{[^}]*\bisInvestigateEnabled\b[^}]*\}\s*from\s*"\.\/investigate_gate\.ts"/,
    );
  });

  test.each(["process.env", "Bun.env", "import.meta.env"])(
    "does not read %s",
    (reader) => {
      expect(config.includes(reader)).toBe(false);
    },
  );
});

describe("the files that mention investigate_enabled", () => {
  test("are the files of the table, with their counts", () => {
    expect(scanCounts(INVESTIGATE_ENABLED_TOKEN)).toEqual(ALLOWED_TOKENS);
  });

  test("counts a plain read of the setting", () => {
    const code = transpiler.transformSync(
      "const on = config.investigate_enabled;",
    );
    expect([...code.matchAll(INVESTIGATE_ENABLED_TOKEN)]).toHaveLength(1);
  });

  test("counts a quoted key", () => {
    const code = transpiler.transformSync(
      'const on = { "investigate_enabled": true };',
    );
    expect([...code.matchAll(INVESTIGATE_ENABLED_TOKEN)]).toHaveLength(1);
  });

  test("does not count a longer name", () => {
    const code = transpiler.transformSync("const x = investigate_enabled_x;");
    expect([...code.matchAll(INVESTIGATE_ENABLED_TOKEN)]).toHaveLength(0);
  });
});

describe("the resource type", () => {
  const yaml = readFileSync(
    join(import.meta.dir, "../../c_factory_config.resource-type.yaml"),
    "utf8",
  );
  const types = readFileSync(join(import.meta.dir, "../../rt.d.ts"), "utf8");

  test("orders investigate_enabled", () => {
    expect(yaml).toMatch(/^ {4}- investigate_enabled$/m);
  });

  test("defaults investigate_enabled to false", () => {
    expect(yaml).toMatch(
      /^ {4}investigate_enabled:\n {6}type: boolean\n {6}description: >-\n.*\n {6}default: false$/m,
    );
  });

  test("declares investigate_enabled in the generated types", () => {
    expect(types).toMatch(/^ {4}investigate_enabled: boolean,$/m);
  });
});
