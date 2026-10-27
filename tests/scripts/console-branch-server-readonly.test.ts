// 検証用サーバーが既定で中継する5つのscriptが、読み取りだけであることを固定する。
// 入口のファイルだけでなく、相対importで辿れる範囲を調べる。
// 共有の部品(`lib/db.ts`、`lib/holds.ts`、`lib/freeze_apply.ts`)には書き込みの関数が同居するので、
// 本文の正規表現ではなく、5つが取り込む名前と、呼ぶ関数の本文で確かめる。

import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { READ_ONLY_SCRIPT_PATHS } from "../../scripts/console-branch-server.ts";

const ROOT = new URL("../../", import.meta.url).pathname;

// SQLの書き込みと、Windmillの書き込みや実行のAPIの呼び出し。
const WRITE =
  /\b(?:insert\s+into|update\s+[\w.]+\s+set|delete\s+from|truncate\s|drop\s+table|alter\s+table)\b|\b(?:createVariable|updateVariable|deleteVariable|setVariable|setResource|createJob|runScript|runScriptByPath|runScriptAsync|runScriptByPathAsync|runFlowByPath|runFlowAsync|cancelQueuedJob|cancelJob|forceCancelQueuedJob|resumeSuspendedJob|createSchedule|updateSchedule|deleteSchedule|setScheduleEnabled)\b/i;

// 書き込みと読み取りが同居する共有の部品。
const MIXED_LIBS = [
  "f/factory/lib/db.ts",
  "f/factory/lib/holds.ts",
  "f/factory/lib/freeze_apply.ts",
];

// 相対importの行き先と、取り込む名前。
const IMPORT =
  /(?:import|export)\s+(?:type\s+)?(?:\{([^}]*)\}|\*\s+as\s+\w+|\w+)\s*from\s*["'](\.{1,2}\/[^"']+)["']/g;

function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

type Closure = {
  /** 共有の部品を除いた、辿れたファイル。 */
  readonly files: readonly string[];
  /** 共有の部品ごとの、取り込まれる名前。 */
  readonly imported: ReadonlyMap<string, ReadonlySet<string>>;
};

async function closureOf(entries: readonly string[]): Promise<Closure> {
  const seen = new Set<string>();
  const queue = entries.map((entry) => resolve(ROOT, `${entry}.ts`));
  const imported = new Map<string, Set<string>>();
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    const source = await Bun.file(file).text();
    for (const match of codeOf(source).matchAll(IMPORT)) {
      const target = resolve(dirname(file), match[2] ?? "");
      if (!target.endsWith(".ts")) continue;
      const relative = target.slice(ROOT.length);
      if (MIXED_LIBS.includes(relative)) {
        const names = imported.get(relative) ?? new Set<string>();
        for (const part of (match[1] ?? "*").split(",")) {
          const name = part
            .trim()
            .replace(/^type\s+/, "")
            .split(/\s+as\s+/)[0];
          if (name !== undefined && name !== "") names.add(name);
        }
        imported.set(relative, names);
      } else {
        queue.push(target);
      }
    }
  }
  return {
    files: [...seen].map((file) => file.slice(ROOT.length)).sort(),
    imported,
  };
}

/** `export function name(`または`export async function name(`から、次の行頭の`}`まで。 */
function functionBody(source: string, name: string): string {
  const start = source.search(
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\s*\\(`),
  );
  if (start < 0) return "";
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end < 0 ? undefined : end + 2);
}

async function textOf(file: string): Promise<string> {
  return codeOf(await Bun.file(`${ROOT}${file}`).text());
}

const CLOSURE = await closureOf(READ_ONLY_SCRIPT_PATHS);

describe("the read-only scripts", () => {
  test("reach more than their own entry files", () => {
    expect(CLOSURE.files.length).toBeGreaterThan(READ_ONLY_SCRIPT_PATHS.length);
  });

  test("contain no write call in the files they import", async () => {
    const writers: string[] = [];
    for (const file of CLOSURE.files) {
      if (WRITE.test(await textOf(file))) writers.push(file);
    }

    expect(writers).toEqual([]);
  });

  test("import only read functions from the database library", () => {
    expect(
      [...(CLOSURE.imported.get("f/factory/lib/db.ts") ?? [])].sort(),
    ).toEqual([
      "CLEANUP_RESOLVER",
      "SqlClient",
      "SqlRow",
      "defaultSqlClient",
      "fetchDeploymentRows",
      "sumAgentCostSince",
    ]);
  });

  test("import only read functions from the holds library", () => {
    expect(
      [...(CLOSURE.imported.get("f/factory/lib/holds.ts") ?? [])].sort(),
    ).toEqual([
      "HoldReadFailureKind",
      "HoldReadOutcome",
      "HoldRow",
      "HoldScope",
      "HolderKind",
      "listActiveHolds",
    ]);
  });

  test("import only the port builder from the freeze library", () => {
    expect(
      [...(CLOSURE.imported.get("f/factory/lib/freeze_apply.ts") ?? [])].sort(),
    ).toEqual(["FreezePorts", "sdkFreezePorts"]);
  });

  test("call database functions that only read", async () => {
    const db = await textOf("f/factory/lib/db.ts");
    const bodies = ["fetchDeploymentRows", "sumAgentCostSince"].map((name) =>
      functionBody(db, name),
    );

    expect(bodies.filter((body) => body === "" || WRITE.test(body))).toEqual(
      [],
    );
  });

  test("call a holds function that only reads", async () => {
    const holds = await textOf("f/factory/lib/holds.ts");
    const body = functionBody(holds, "listActiveHolds");

    expect(body !== "" && !WRITE.test(body)).toBe(true);
  });

  test("read the freeze variable without calling the write port", async () => {
    const reader = functionBody(
      await textOf("f/factory/lib/console_holds_support.ts"),
      "readFreezeState",
    );

    expect(reader !== "" && !reader.includes("writeVariable")).toBe(true);
  });

  test("never name the write port in the holds script", async () => {
    expect(await textOf("f/factory/console_holds.ts")).not.toContain(
      "writeVariable",
    );
  });

  test("never name the write port in the files they import", async () => {
    const named: string[] = [];
    for (const file of CLOSURE.files) {
      if ((await textOf(file)).includes("writeVariable")) named.push(file);
    }

    expect(named).toEqual([]);
  });

  test("catch a write call that an imported file adds", () => {
    expect(WRITE.test("await wmill.setVariable(path, value)")).toBe(true);
  });

  test("catch an async run that an imported file adds", () => {
    expect(WRITE.test("await wmill.runScriptByPathAsync({ path })")).toBe(true);
  });
});
