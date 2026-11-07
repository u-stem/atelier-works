import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "scripts",
  "test-db-queries.ts",
);
const source = readFileSync(SOURCE_PATH, "utf8");
const sourceLines = source.split("\n");

type Declaration = { readonly name: string; readonly body: string };

/**
 * 先頭の桁から始まる`function`、`async function`、`const <名前> = async`を、本体の範囲つきで集める。
 * `async`でない関数も、`execPsqlAsync`の約束を返すなら、呼び出しに`await`が要るので集める。
 * 本体は、宣言の行から、字下げされた行と閉じ括弧で始まる行を読み、閉じ括弧だけの行で終わる。
 */
function collectDeclarations(lines: readonly string[]): Declaration[] {
  const collected: Declaration[] = [];
  lines.forEach((line, index) => {
    const found =
      /^(?:async )?function (\w+)/.exec(line) ??
      /^const (\w+) = async\b/.exec(line);
    if (found === null || found[1] === undefined) return;
    const body = [line];
    for (let next = index + 1; next < lines.length; next += 1) {
      const nextLine = lines[next] ?? "";
      if (!/^[\s}\])]/.test(nextLine)) break;
      body.push(nextLine);
      if (/^[}\])]+;?$/.test(nextLine)) break;
    }
    collected.push({ name: found[1], body: body.join("\n") });
  });
  return collected;
}

/** `execPsqlAsync`を直接か間接に呼ぶ補助関数の名前。 */
function helperNames(lines: readonly string[]): Set<string> {
  const collected = collectDeclarations(lines);
  const names = new Set<string>(["execPsqlAsync"]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const declaration of collected) {
      if (names.has(declaration.name)) continue;
      const callsKnown = [...names].some((name) =>
        new RegExp(`(?<![\\w.])${name}\\(`).test(declaration.body),
      );
      if (callsKnown) {
        names.add(declaration.name);
        grew = true;
      }
    }
  }
  return names;
}

/** 呼び出しの前に`await`か`return`が無い行を、`行番号: 行の内容`で返す。 */
function callsWithoutAwait(
  lines: readonly string[],
  names: Set<string>,
): string[] {
  const violations: string[] = [];
  lines.forEach((line, index) => {
    for (const name of names) {
      const call = new RegExp(`(?<![\\w.])(?<!function\\s)${name}\\(`, "g");
      for (const match of line.matchAll(call)) {
        const before = line.slice(0, match.index);
        if (/(?:await|return)\s*\(?\s*$/.test(before)) continue;
        violations.push(`${String(index + 1)}: ${line.trim()}`);
      }
    }
  });
  return violations;
}

/** 状態を変える文の形。`text`に当たったものを返す。 */
function statefulPatternsIn(text: string): RegExp[] {
  const stateful = [
    /pg_advisory_\w+/i,
    /\bCREATE\s+(?:TEMP|TEMPORARY)\b/i,
    // 小文字にも当てるので、検査名の文に混ざる語(`reset`など)を拾わないよう、文の先頭に限る。
    /["'`;]\s*PREPARE\s+\w+/i,
    /["'`;]\s*(?:RESET|DISCARD|LISTEN)\s+\w+/i,
    /["'`;]\s*SET\s+(?!LOCAL\b)/,
    /set_config\([^)]*,\s*false\s*\)/i,
  ];
  return stateful.filter((pattern) => pattern.test(text));
}

describe("test-db-queries.ts", () => {
  test("finds the helpers that call execPsqlAsync", () => {
    const names = helperNames(sourceLines);

    expect(names).toContain("event");
    expect(names).toContain("auditReport");
    expect(names).toContain("recordDeploymentRow");
    expect(names).toContain("conflictNote");
  });

  test("awaits every call of execPsqlAsync and its helpers", () => {
    const violations = callsWithoutAwait(sourceLines, helperNames(sourceLines));

    expect(violations).toEqual([]);
  });

  test("does not import the synchronous psql helpers", () => {
    const imported = (
      /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"\.\/test-db-sql\.ts"/s
        .exec(source)?.[1]
        ?.split(",") ?? []
    ).map((name) => name.replace(/^\s*type\s+/, "").trim());

    expect(imported).not.toContain("execPsql");
    expect(imported).not.toContain("createPsqlClient");
  });

  test("sends no statement that changes the state of the session", () => {
    expect(statefulPatternsIn(source)).toEqual([]);
  });
});

describe("the detector of a missing await", () => {
  const withPlainHelper = [
    "function plainHelper() {",
    "  return execPsqlAsync(target, 'SELECT 1');",
    "}",
    "plainHelper();",
  ];

  test("finds a helper that is not async and returns execPsqlAsync", () => {
    const names = helperNames(withPlainHelper);

    expect(names).toContain("plainHelper");
  });

  test("reports a call of such a helper without await", () => {
    const violations = callsWithoutAwait(
      withPlainHelper,
      helperNames(withPlainHelper),
    );

    expect(violations).toEqual(["4: plainHelper();"]);
  });

  test("accepts a call of such a helper with await", () => {
    const awaited = [...withPlainHelper.slice(0, 3), "await plainHelper();"];

    const violations = callsWithoutAwait(awaited, helperNames(awaited));

    expect(violations).toEqual([]);
  });
});

describe("the detector of a statement that changes the session state", () => {
  test.each([
    ["create temp table x (a int)"],
    ["prepare stmt as select 1"],
    ["discard all"],
  ])("detects the lowercase statement %p", (statement) => {
    const found = statefulPatternsIn(`execPsqlAsync(target, "${statement}")`);

    expect(found).toHaveLength(1);
  });

  test("does not mistake a check name that contains reset for a statement", () => {
    const name =
      '"sums the OOM increases across a reset and a NULL row", ok(true)';

    expect(statefulPatternsIn(name)).toEqual([]);
  });
});
