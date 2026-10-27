// 設計フローを起動する元を、このテストの中で完結して固定する。
// 設計フローを起動できるのは、再実行(`retry_work_item`)、要件定義の承認の反映(`steps/requirements_apply`)、
// 設計の承認の反映(`steps/design_apply`)の3つだけである。新しい起動元が足されると、ここが落ちる。
// このテストは保護パスに置く。実装フローの自動修正やPRの修正が許可の表を広げて、
// 黙って通るようになるのを防ぐためである。
//
// 起動の台帳(`scripts/launch-graph.ts`)と、その契約テストは、保護していないファイルなので、
// 緩められると黙って通る。そのため、保護していない入力に頼らず、`f/factory`のテスト以外のすべての`.ts`と、
// すべての`flow.yaml`、`*.schedule.yaml`を直接読む。`.ts`のコメントは`Bun.Transpiler`で落とす。
// 変換できないファイルは失敗として扱う(fail-closed)。
// 補助の関数は、保護していないファイルから読み込まない。台帳もモジュールとして読み込まず、テキストとして読んで辺を拾う。
// 引用符の形(`"`、`'`、バッククォート)には依らず、変換後の文面を数える。
//
// 文字列の照合で、追えない形がある。識別子を連結や別名で組み立てる起動は数えられない。
// `design_stage_closed.test.ts`の関数の観測と組み合わせて守る。
// 関数の宣言(`function 名前(`)は数えない。呼び出しだけを数える。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FACTORY_DIR = join(import.meta.dir, "../../f/factory");
const LAUNCH_GRAPH = join(import.meta.dir, "../../scripts/launch-graph.ts");
const transpiler = new Bun.Transpiler({ loader: "ts" });

/** 設計フローを起動する経路を示す識別子と、その数え方。 */
const ENTRY_PATTERNS = {
  DESIGN_FLOW_PATH: /\bDESIGN_FLOW_PATH\b/g,
  designFlowPathLiteral: /f\/factory\/design(?![\w/])/g,
  "startDesign(": /(?<!\bfunction\s+)\bstartDesign\(/g,
  "designFlowInput(": /(?<!\bfunction\s+)\bdesignFlowInput\(/g,
  "buildStartDesign(": /(?<!\bfunction\s+)\bbuildStartDesign\(/g,
} as const;

/** 状態`designing`を指す文字列の数え方。 */
const DESIGNING_PATTERN = /[`"']designing[`"']/g;

type Counts = Readonly<Record<string, number>>;

/**
 * 設計フローを参照するファイルと、参照ごとの出現の数。キーは`f/factory`からの相対パス。
 * 起動元は`retry_work_item.ts`、`steps/requirements_apply.ts`、`steps/design_apply.ts`の3つ。
 * 起動しない参照は、失敗ハンドラ(`on_error_flow.ts`)、ジョブの取消(`console_job_cancel.ts`)、
 * リースの定義(`lib/pipeline_lease.ts`)、Consoleの既知のpathの生成物(`lib/console_known_paths.ts`)、
 * 設計フロー自身の定義(`design__flow/flow.yaml`)である。
 */
const ALLOWED_REFERENCES: Readonly<Record<string, Counts>> = {
  "retry_work_item.ts": { DESIGN_FLOW_PATH: 3, "designFlowInput(": 1 },
  "steps/requirements_apply.ts": {
    DESIGN_FLOW_PATH: 3,
    "startDesign(": 1,
    "designFlowInput(": 1,
    "buildStartDesign(": 1,
  },
  "steps/design_apply.ts": { "startDesign(": 1, "buildStartDesign(": 1 },
  "on_error_flow.ts": { DESIGN_FLOW_PATH: 3 },
  "console_job_cancel.ts": { designFlowPathLiteral: 1 },
  "lib/pipeline_lease.ts": { DESIGN_FLOW_PATH: 1, designFlowPathLiteral: 1 },
  "lib/console_known_paths.ts": { designFlowPathLiteral: 2 },
  "design__flow/flow.yaml": { designFlowPathLiteral: 1 },
};

/**
 * 文字列`"designing"`(引用符の形は問わない)の出現の数。遷移先が`designing`の比較交換を呼ぶ箇所を、ファイルごとの数で固定する。
 * 数が合わないときは、新しい遷移が足されたか、減ったかである。起動元の確認と同じ重さで見直す。
 */
const ALLOWED_DESIGNING: Readonly<Record<string, number>> = {
  "lib/db.ts": 6,
  "lib/types.ts": 1,
  "retry_work_item.ts": 1,
  "steps/design_apply.ts": 1,
  "steps/design_generate.ts": 2,
  "steps/design_prepare.ts": 3,
  "steps/design_request_approval.ts": 2,
  "steps/requirements_apply.ts": 2,
};

/** `f/factory`の下の、テストを除くすべての`.ts`の相対パス。 */
function productionSources(): string[] {
  return [...new Bun.Glob("**/*.ts").scanSync(FACTORY_DIR)]
    .filter((path) => !path.endsWith(".test.ts"))
    .sort();
}

/** `f/factory`の下の、すべての`flow.yaml`と`*.schedule.yaml`の相対パス。 */
function productionYamls(): string[] {
  return [
    ...new Bun.Glob("**/{flow.yaml,*.schedule.yaml}").scanSync(FACTORY_DIR),
  ].sort();
}

/** コメントを落としたJavaScript。変換できないときは例外を投げる。 */
function transpile(source: string): string {
  return transpiler.transformSync(source);
}

function codeOf(path: string): string {
  return transpile(readFileSync(join(FACTORY_DIR, path), "utf8"));
}

/** YAMLの行コメント(行頭、または空白の後の`#`から行末まで)を落とした文面。 */
function stripYamlComments(source: string): string {
  return source.replace(/(^|\s)#.*$/gm, "$1");
}

function yamlOf(path: string): string {
  return stripYamlComments(readFileSync(join(FACTORY_DIR, path), "utf8"));
}

function countOf(code: string, pattern: RegExp): number {
  return [...code.matchAll(pattern)].length;
}

/** 変換後の文面にある、参照ごとの出現の数(0は含めない)。 */
function referenceCountsOf(code: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [name, pattern] of Object.entries(ENTRY_PATTERNS)) {
    const n = countOf(code, pattern);
    if (n > 0) counts[name] = n;
  }
  return counts;
}

/** 参照があるファイルごとの、参照ごとの出現の数。 */
function scanReferences(): Record<string, Counts> {
  const found: Record<string, Counts> = {};
  const codes: [string, string][] = [
    ...productionSources().map((path): [string, string] => [
      path,
      codeOf(path),
    ]),
    ...productionYamls().map((path): [string, string] => [path, yamlOf(path)]),
  ];
  for (const [path, code] of codes) {
    const counts = referenceCountsOf(code);
    if (Object.keys(counts).length > 0) found[path] = counts;
  }
  return found;
}

function scanDesigning(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const path of productionSources()) {
    const n = countOf(codeOf(path), DESIGNING_PATTERN);
    if (n > 0) found[path] = n;
  }
  return found;
}

/**
 * `export const LAUNCH_EDGES = [`から対応する閉じ括弧までの配列のテキスト。
 * 未配線の辺や差し戻しの辺など、ほかの配列に同じ形の辺があっても拾わないために、配列の範囲だけを返す。
 * 宣言が無いときは空文字列を返す。
 */
function launchEdgesBlock(code: string): string {
  const declaration = /export\s+const\s+LAUNCH_EDGES\b[^=]*=\s*\[/.exec(code);
  if (declaration === null) return "";
  const start = declaration.index + declaration[0].length;
  let depth = 1;
  for (let i = start; i < code.length; i += 1) {
    if (code[i] === "[") depth += 1;
    if (code[i] === "]") depth -= 1;
    if (depth === 0) return code.slice(start, i);
  }
  return code.slice(start);
}

/** 起動の台帳のテキストから、`to`が`target`の辺の起点を拾う。台帳はモジュールとして評価しない。 */
function launchOriginsTo(code: string, target: string): string[] {
  const pattern = new RegExp(
    `\\{\\s*from:\\s*["'\`]([^"'\`]+)["'\`],\\s*to:\\s*["'\`]${target}["'\`]`,
    "g",
  );
  return [...launchEdgesBlock(code).matchAll(pattern)]
    .flatMap((m) => m[1] ?? [])
    .sort();
}

/** 最上位の関数の本体。変換後のコードは、最上位の宣言が行頭にあり、閉じる括弧も行頭にある。 */
function bodyOf(code: string, name: string): string {
  const start = code.search(new RegExp(`(?:async )?function ${name}\\(`));
  if (start < 0) return "";
  const end = code.indexOf("\n}\n", start);
  return end < 0 ? code.slice(start) : code.slice(start, end + 2);
}

describe("the files that refer to the design flow", () => {
  test("reads every production file", () => {
    expect(productionSources().length).toBeGreaterThan(100);
  });

  test("reads every flow and schedule definition", () => {
    expect(productionYamls().length).toBeGreaterThan(20);
  });

  test("are exactly the files in the table", () => {
    expect(Object.keys(scanReferences()).sort()).toEqual(
      Object.keys(ALLOWED_REFERENCES).sort(),
    );
  });

  test.each(Object.entries(ALLOWED_REFERENCES))(
    "refer to it as many times as the table says in %s",
    (path, counts) => {
      expect(scanReferences()[path]).toEqual(counts);
    },
  );
});

describe("the files that name the design status", () => {
  test("are exactly the files in the table", () => {
    expect(Object.keys(scanDesigning()).sort()).toEqual(
      Object.keys(ALLOWED_DESIGNING).sort(),
    );
  });

  test.each(Object.entries(ALLOWED_DESIGNING))(
    "name it as many times as the table says in %s",
    (path, count) => {
      expect(scanDesigning()[path]).toBe(count);
    },
  );
});

describe("the way the references are counted", () => {
  test("counts the path in double quotes", () => {
    expect(
      referenceCountsOf(transpile('const p = "f/factory/design";')),
    ).toEqual({ designFlowPathLiteral: 1 });
  });

  test("counts the path in single quotes", () => {
    expect(
      referenceCountsOf(transpile("const p = 'f/factory/design';")),
    ).toEqual({ designFlowPathLiteral: 1 });
  });

  test("counts the path in a template literal", () => {
    expect(
      referenceCountsOf(transpile("const p = `f/factory/design`;")),
    ).toEqual({ designFlowPathLiteral: 1 });
  });

  test("counts the path at the head of a template literal with a substitution", () => {
    expect(
      referenceCountsOf(transpile("const p = `f/factory/design${suffix}`;")),
    ).toEqual({ designFlowPathLiteral: 1 });
  });

  test("does not count the path of a script that starts with the same word", () => {
    expect(
      referenceCountsOf(transpile("const p = `f/factory/design_apply`;")),
    ).toEqual({});
  });

  test("does not count the path of a file below the flow", () => {
    expect(
      referenceCountsOf(transpile('const p = "f/factory/design/x";')),
    ).toEqual({});
  });

  test("does not count the path in a comment", () => {
    expect(
      referenceCountsOf(transpile("// f/factory/design\nconst p = 1;")),
    ).toEqual({});
  });

  test("counts the status in double quotes", () => {
    expect(
      countOf(transpile('const s = "designing";'), DESIGNING_PATTERN),
    ).toBe(1);
  });

  test("counts the status in single quotes", () => {
    expect(
      countOf(transpile("const s = 'designing';"), DESIGNING_PATTERN),
    ).toBe(1);
  });

  test("counts the status in a template literal", () => {
    expect(
      countOf(transpile("const s = `designing`;"), DESIGNING_PATTERN),
    ).toBe(1);
  });

  test("does not count a longer word that contains the status", () => {
    expect(
      countOf(transpile('const s = "designing_x";'), DESIGNING_PATTERN),
    ).toBe(0);
  });

  test("counts the path in a flow definition", () => {
    expect(
      referenceCountsOf(stripYamlComments("value: f/factory/design\n")),
    ).toEqual({ designFlowPathLiteral: 1 });
  });

  test("does not count the path in a comment of a flow definition", () => {
    expect(
      referenceCountsOf(
        stripYamlComments("# f/factory/design\nvalue: x # f/factory/design\n"),
      ),
    ).toEqual({});
  });

  test("does not count the path of the flow directory", () => {
    expect(
      referenceCountsOf(stripYamlComments("path: f/factory/design__flow\n")),
    ).toEqual({});
  });

  test("reads the origins of the edges to a flow from the text of the ledger", () => {
    expect(
      launchOriginsTo(
        transpile(
          'export const LAUNCH_EDGES = [{ from: "b", to: "design", kind: "script" }, { from: "a", to: "design", kind: "script" }, { from: "c", to: "design_x", kind: "script" }];',
        ),
        "design",
      ),
    ).toEqual(["a", "b"]);
  });

  test("does not read the edges of the arrays other than LAUNCH_EDGES", () => {
    expect(
      launchOriginsTo(
        transpile(
          'export const LAUNCH_EDGES = [{ from: "a", to: "design", kind: "script" }];\nexport const UNWIRED_LAUNCH_EDGES = [{ from: "b", to: "design", kind: "script" }];\nexport const REWORK_LAUNCH_EDGES = [{ from: "c", to: "design" }];',
        ),
        "design",
      ),
    ).toEqual(["a"]);
  });

  test("does not read the edges of an array that comes before LAUNCH_EDGES", () => {
    expect(
      launchOriginsTo(
        transpile(
          'export const UNWIRED_LAUNCH_EDGES = [{ from: "b", to: "design", kind: "script" }];\nexport const LAUNCH_EDGES = [{ from: "a", to: "design", kind: "script" }];',
        ),
        "design",
      ),
    ).toEqual(["a"]);
  });

  test("reads no origin when the text has no LAUNCH_EDGES", () => {
    expect(
      launchOriginsTo(
        transpile(
          'export const UNWIRED_LAUNCH_EDGES = [{ from: "b", to: "design", kind: "script" }];',
        ),
        "design",
      ),
    ).toEqual([]);
  });
});

describe("the condition at each origin", () => {
  test("requirements_apply wires the design flow only under config.design_enabled", () => {
    expect(codeOf("steps/requirements_apply.ts")).toMatch(
      /\bconfig\.design_enabled\s*\?\s*buildStartDesign\(/,
    );
  });

  test("requirements_apply never wires the design flow without a condition", () => {
    expect(codeOf("steps/requirements_apply.ts")).not.toMatch(
      /\bstartDesign:\s*(?:null|buildStartDesign\()/,
    );
  });

  test("retry_work_item builds the input of the design flow only when the design is enabled", () => {
    expect(codeOf("retry_work_item.ts")).toMatch(
      /if\s*\(\s*context\.designEnabled\s*&&[^)]*\)\s*\{[^}]*designFlowInput\(/,
    );
  });

  test("design_apply builds the start of the design flow once, in applyDesignRejected", () => {
    const body = bodyOf(codeOf("steps/design_apply.ts"), "applyDesignRejected");
    expect(countOf(body, /\bbuildStartDesign\(/g)).toBe(1);
  });

  test("design_apply moves to designing before it builds the start of the design flow", () => {
    const body = bodyOf(codeOf("steps/design_apply.ts"), "applyDesignRejected");
    const move = body.indexOf("casToDesigning(");
    expect(move > -1 && move < body.indexOf("buildStartDesign(")).toBe(true);
  });

  test("design_apply moves to designing only from awaiting_design_approval, clearing the lease", () => {
    expect(codeOf("steps/design_apply.ts")).toMatch(
      /casToDesigning:\s*\(note\)\s*=>\s*updateStatusIfLeaseHolderClearingFlowJobId\(\s*workItem\.id,\s*"awaiting_design_approval",\s*"designing"/,
    );
  });
});

describe("the launch edges to the design flow", () => {
  test("start from the three origins", () => {
    const origins = launchOriginsTo(
      transpile(readFileSync(LAUNCH_GRAPH, "utf8")),
      "design",
    );
    expect(origins).toEqual([
      "retry_work_item",
      "steps/design_apply",
      "steps/requirements_apply",
    ]);
  });
});
