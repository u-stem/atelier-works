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
const lines = source.split("\n");

type Declaration = { readonly name: string; readonly body: string };

/**
 * 先頭の桁から始まる`async function`と`const <名前> = async`を、本体の範囲つきで集める。
 * 本体は、宣言の行から、字下げされた行と閉じ括弧で始まる行を読み、閉じ括弧だけの行で終わる。
 */
function asyncDeclarations(): Declaration[] {
  const declarations: Declaration[] = [];
  lines.forEach((line, index) => {
    const found =
      /^async function (\w+)/.exec(line) ?? /^const (\w+) = async\b/.exec(line);
    if (found === null || found[1] === undefined) return;
    const body = [line];
    for (let next = index + 1; next < lines.length; next += 1) {
      const nextLine = lines[next] ?? "";
      if (!/^[\s}\])]/.test(nextLine)) break;
      body.push(nextLine);
      if (/^[}\])]+;?$/.test(nextLine)) break;
    }
    declarations.push({ name: found[1], body: body.join("\n") });
  });
  return declarations;
}

/** `execPsqlAsync`を直接か間接に呼ぶ補助関数の名前。 */
function helperNames(): Set<string> {
  const declarations = asyncDeclarations();
  const names = new Set<string>(["execPsqlAsync"]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const declaration of declarations) {
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
function callsWithoutAwait(names: Set<string>): string[] {
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

describe("test-db-queries.ts", () => {
  test("finds the helpers that call execPsqlAsync", () => {
    const names = helperNames();

    expect(names).toContain("event");
    expect(names).toContain("auditReport");
    expect(names).toContain("recordDeploymentRow");
    expect(names).toContain("conflictNote");
  });

  test("awaits every call of execPsqlAsync and its helpers", () => {
    const violations = callsWithoutAwait(helperNames());

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
    const stateful = [
      /pg_advisory_\w+/i,
      /\bCREATE\s+(?:TEMP|TEMPORARY)\b/,
      /\bPREPARE\s+\w+/,
      /\b(?:RESET|DISCARD|LISTEN)\s+\w+/,
      /["'`;]\s*SET\s+(?!LOCAL\b)/,
      /set_config\([^)]*,\s*false\s*\)/i,
    ];

    const found = stateful.filter((pattern) => pattern.test(source));

    expect(found).toEqual([]);
  });
});
