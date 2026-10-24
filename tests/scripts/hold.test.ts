import { describe, expect, test } from "bun:test";
import {
  HOLD_ALREADY_ACTIVE,
  type HoldSqlClient,
  type HoldSqlRow,
} from "../../f/factory/lib/holds.ts";
import {
  type CliDeps,
  type Command,
  deriveActor,
  HOLD_DATABASE,
  holdClients,
  parseArgs,
  runCommand,
  WIRED_SCOPES,
} from "../../scripts/hold.ts";
import type { HoldPsqlRequest } from "../../scripts/hold_psql.ts";

// ---- 引数 ----

function parsed(argv: string[]): Command | null {
  const result = parseArgs(argv);
  return result.ok ? result.value : null;
}

const PLACE = [
  "place",
  "--scope",
  "merge",
  "--target",
  "acme/widgets",
  "--minutes",
  "60",
  "--reason",
  "checking the lockfile",
];

describe("parseArgs", () => {
  test("parses list", () => {
    expect(parsed(["list"])).toEqual({ kind: "list" });
  });

  test("rejects an argument after list", () => {
    expect(parseArgs(["list", "extra"]).ok).toBe(false);
  });

  test("parses release with an id", () => {
    expect(parsed(["release", "12"])).toEqual({ kind: "release", id: 12 });
  });

  test("rejects release without an id", () => {
    expect(parseArgs(["release"]).ok).toBe(false);
  });

  test("rejects an id that is not a number", () => {
    expect(parseArgs(["release", "abc"]).ok).toBe(false);
  });

  test("rejects a negative id", () => {
    expect(parseArgs(["release", "-1"]).ok).toBe(false);
  });

  test("rejects two ids", () => {
    expect(parseArgs(["release", "1", "2"]).ok).toBe(false);
  });

  test("parses place with all flags", () => {
    expect(parsed(PLACE)).toEqual({
      kind: "place",
      scope: "merge",
      target: "acme/widgets",
      minutes: 60,
      reason: "checking the lockfile",
    });
  });

  test("parses place with the flags in another order", () => {
    expect(
      parsed([
        "place",
        "--reason",
        "r",
        "--minutes",
        "5",
        "--target",
        "a/b",
        "--scope",
        "merge",
      ]),
    ).toEqual({
      kind: "place",
      scope: "merge",
      target: "a/b",
      minutes: 5,
      reason: "r",
    });
  });

  test("rejects place without a reason", () => {
    expect(parseArgs(PLACE.slice(0, -2)).ok).toBe(false);
  });

  test("rejects place without a scope", () => {
    expect(parseArgs(PLACE.slice(3)).ok).toBe(false);
  });

  test("rejects an unknown flag", () => {
    expect(parseArgs([...PLACE, "--database", "x"]).ok).toBe(false);
  });

  test("rejects a repeated flag", () => {
    expect(parseArgs([...PLACE, "--scope", "claim"]).ok).toBe(false);
  });

  test("rejects a flag without a value", () => {
    expect(parseArgs([...PLACE.slice(0, -1)]).ok).toBe(false);
  });

  test("rejects minutes that is not a number", () => {
    const argv = [...PLACE];
    argv[6] = "soon";

    expect(parseArgs(argv).ok).toBe(false);
  });

  test("rejects an unknown command", () => {
    expect(parseArgs(["reset"]).ok).toBe(false);
  });

  test("rejects no command and shows the usage", () => {
    const result = parseArgs([]);

    expect(!result.ok && result.reason).toContain("usage");
  });
});

// ---- 主体 ----

describe("deriveActor", () => {
  test("is a human without CLAUDECODE", () => {
    expect(deriveActor({}, "feat/x")).toEqual({
      kind: "human",
      holder: "human",
    });
  });

  test("is a human when CLAUDECODE is empty", () => {
    expect(deriveActor({ CLAUDECODE: "" }, "feat/x").kind).toBe("human");
  });

  test("is a session with CLAUDECODE", () => {
    expect(deriveActor({ CLAUDECODE: "1" }, "feat/x")).toEqual({
      kind: "session",
      holder: "session:feat/x",
    });
  });

  test("names a detached HEAD detached", () => {
    expect(deriveActor({ CLAUDECODE: "1" }, "HEAD").holder).toBe(
      "session:detached",
    );
  });

  test("names an empty branch detached", () => {
    expect(deriveActor({ CLAUDECODE: "1" }, "").holder).toBe(
      "session:detached",
    );
  });

  test("replaces characters outside the branch alphabet", () => {
    expect(deriveActor({ CLAUDECODE: "1" }, "feat/a b\nc").holder).toBe(
      "session:feat/a-b-c",
    );
  });

  test("cuts a long branch name at 100 characters", () => {
    expect(
      deriveActor({ CLAUDECODE: "1" }, "b".repeat(300)).holder.length,
    ).toBe(100);
  });
});

// ---- 範囲とデータベース ----

describe("WIRED_SCOPES", () => {
  test("holds only merge, the one scope that has a reader", () => {
    expect([...WIRED_SCOPES]).toEqual(["merge"]);
  });
});

describe("the database the CLI writes to", () => {
  test("is datatable_db", () => {
    expect(HOLD_DATABASE).toBe("datatable_db");
  });

  test("is passed to psql by the read client", async () => {
    const requests: HoldPsqlRequest[] = [];
    const { read } = holdClients(async (request) => {
      requests.push(request);
      return { exitCode: 0, stdout: "[]", stderr: "", timedOut: false };
    });

    await read`SELECT 1 AS id`.fetch();

    const argv = requests[0]?.argv ?? [];
    expect(argv[argv.indexOf("-d") + 1]).toBe("datatable_db");
  });

  test("is passed to psql by the write client", async () => {
    const requests: HoldPsqlRequest[] = [];
    const { write } = holdClients(async (request) => {
      requests.push(request);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    });

    await write`SELECT 1`.execute();

    const argv = requests[0]?.argv ?? [];
    expect(argv[argv.indexOf("-d") + 1]).toBe("datatable_db");
  });

  test("makes the read client read-only", async () => {
    const requests: HoldPsqlRequest[] = [];
    const { read } = holdClients(async (request) => {
      requests.push(request);
      return { exitCode: 0, stdout: "[]", stderr: "", timedOut: false };
    });

    await read`SELECT 1 AS id`.fetch();

    expect(requests[0]?.argv.join(" ")).toContain(
      "default_transaction_read_only=on",
    );
  });

  test("leaves the write client writable", async () => {
    const requests: HoldPsqlRequest[] = [];
    const { write } = holdClients(async (request) => {
      requests.push(request);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    });

    await write`SELECT 1`.execute();

    expect(requests[0]?.argv.join(" ")).not.toContain("read_only");
  });

  test("finds the compose file of this repository", async () => {
    const requests: HoldPsqlRequest[] = [];
    const { read } = holdClients(async (request) => {
      requests.push(request);
      return { exitCode: 0, stdout: "[]", stderr: "", timedOut: false };
    });

    await read`SELECT 1 AS id`.fetch();

    const argv = requests[0]?.argv ?? [];
    expect(
      argv[argv.indexOf("-f") + 1]?.endsWith("/infra/docker-compose.yml"),
    ).toBe(true);
  });
});

// ---- 偽のデータベース ----

type Statement = { readonly text: string; readonly values: readonly unknown[] };

type Db = {
  /** 有効な保留を読む文に返す行。 */
  readonly active?: HoldSqlRow[];
  /** 無効な未解除の行を読む文に返す行。 */
  readonly invalid?: HoldSqlRow[];
  /** idで1件読む文に返す行。 */
  readonly byId?: HoldSqlRow[];
  /** 挿入が返す行。空配列は「既に有効な保留がある」。 */
  readonly inserted?: HoldSqlRow[];
  readonly failWith?: Error;
};

function holdRow(overrides: HoldSqlRow = {}): HoldSqlRow {
  return {
    id: 7,
    scope: "merge",
    target: "acme/widgets",
    reason: "checking the lockfile",
    holder_kind: "session",
    holder: "session:feat/x",
    created_at: "2026-10-24T01:00:00.000Z",
    expires_at: "2026-10-24T03:00:00.000Z",
    released_at: null,
    released_by: null,
    ...overrides,
  };
}

function fakeSql(db: Db): { sql: HoldSqlClient; statements: Statement[] } {
  const statements: Statement[] = [];
  const sql: HoldSqlClient = (strings, ...values) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    statements.push({ text, values });
    const rows = (): HoldSqlRow[] => {
      if (db.failWith !== undefined) throw db.failWith;
      if (text.includes("NOT (created_at")) return db.invalid ?? [];
      if (text.startsWith("INSERT INTO factory.holds")) {
        return db.inserted ?? [{ id: 5 }];
      }
      if (
        text.startsWith(
          "UPDATE factory.holds SET released_at = now(), released_by = ?",
        )
      ) {
        return [{ id: Number(values[1]) }];
      }
      if (text.includes("WHERE id = ")) return db.byId ?? [];
      if (text.includes("FROM factory.holds")) return db.active ?? [];
      return [];
    };
    return {
      fetch: async () => rows(),
      execute: async () => {
        rows();
      },
    };
  };
  return { sql, statements };
}

type Options = {
  readonly db?: Db;
  readonly env?: Record<string, string | undefined>;
  readonly branch?: string;
  readonly confirm?: boolean;
  readonly freezes?: { schedule: number; deploy: number } | Error;
};

async function run(
  command: Command,
  options: Options = {},
): Promise<{
  code: number;
  lines: string[];
  read: Statement[];
  write: Statement[];
  confirmations: string[];
}> {
  const read = fakeSql(options.db ?? {});
  const write = fakeSql(options.db ?? {});
  const lines: string[] = [];
  const confirmations: string[] = [];
  const freezes = options.freezes ?? { schedule: 0, deploy: 0 };
  const deps: CliDeps = {
    read: read.sql,
    write: write.sql,
    branch: async () => options.branch ?? "feat/x",
    env: options.env ?? {},
    confirm: async (message) => {
      confirmations.push(message);
      return options.confirm ?? true;
    },
    print: (line) => {
      lines.push(line);
    },
    activeFreezeCounts: async () => {
      if (freezes instanceof Error) throw freezes;
      return freezes;
    },
  };
  const code = await runCommand(command, deps);
  return {
    code,
    lines,
    read: read.statements,
    write: write.statements,
    confirmations,
  };
}

const SESSION = { CLAUDECODE: "1" };

const PLACE_COMMAND: Command = {
  kind: "place",
  scope: "merge",
  target: "Acme/Widgets",
  minutes: 60,
  reason: "checking the lockfile",
};

// ---- list ----

describe("list", () => {
  test("prints an active hold with its id, scope, target, holder and reason", async () => {
    const { lines } = await run(
      { kind: "list" },
      { db: { active: [holdRow()] } },
    );

    const line = lines.find((l) => l.startsWith("7")) ?? "";
    expect(
      [
        "merge",
        "acme/widgets",
        "session:feat/x",
        "checking the lockfile",
      ].every((part) => line.includes(part)),
    ).toBe(true);
  });

  test("marks an active hold active", async () => {
    const { lines } = await run(
      { kind: "list" },
      { db: { active: [holdRow()] } },
    );

    expect(lines.some((l) => l.startsWith("7") && l.includes("active"))).toBe(
      true,
    );
  });

  test("shows the end of a hold in JST", async () => {
    const { lines } = await run(
      { kind: "list" },
      { db: { active: [holdRow()] } },
    );

    expect(lines.some((l) => l.includes("2026-10-24 12:00 JST"))).toBe(true);
  });

  test("marks an unreleased row that is not valid as invalid", async () => {
    const { lines } = await run(
      { kind: "list" },
      {
        db: {
          invalid: [holdRow({ id: 9, expires_at: "2026-10-24T00:30:00.000Z" })],
        },
      },
    );

    expect(lines.some((l) => l.startsWith("9") && l.includes("invalid"))).toBe(
      true,
    );
  });

  test("says there are no holds when the table has no open row", async () => {
    const { lines } = await run({ kind: "list" });

    expect(lines).toContain("no holds");
  });

  test("exits 0", async () => {
    const { code } = await run({ kind: "list" });

    expect(code).toBe(0);
  });

  test("turns control and format characters of the text into spaces", async () => {
    const { lines } = await run(
      { kind: "list" },
      {
        db: {
          active: [
            holdRow({
              reason: "a\u001b[31mred\u202eevil",
              holder: "session:x\u2028y",
            }),
          ],
        },
      },
    );

    const forbidden = ["\u001b", "\u202e", "\u2028"];

    expect(forbidden.some((char) => lines.join("\n").includes(char))).toBe(
      false,
    );
  });

  test("keeps the text of a hold readable after the replacement", async () => {
    const { lines } = await run(
      { kind: "list" },
      { db: { active: [holdRow({ reason: "a\u001b[31mred" })] } },
    );

    expect(lines.join("\n")).toContain("a [31mred");
  });

  test("prints the number of active schedule freezes and deploy freezes", async () => {
    const { lines } = await run(
      { kind: "list" },
      { freezes: { schedule: 2, deploy: 1 } },
    );

    expect(lines).toContain(
      "active freezes: schedule 2, deploy 1 (see mise run freeze:list)",
    );
  });

  test("prints zero for both kinds of freeze", async () => {
    const { lines } = await run({ kind: "list" });

    expect(lines).toContain(
      "active freezes: schedule 0, deploy 0 (see mise run freeze:list)",
    );
  });

  test("warns and still exits 0 when the freezes cannot be read", async () => {
    const result = await run(
      { kind: "list" },
      { freezes: new Error("no wmill") },
    );

    expect([
      result.code,
      result.lines.some(
        (l) => l.startsWith("warning:") && l.includes("freeze"),
      ),
    ]).toEqual([0, true]);
  });

  test("says which route a merge hold protects", async () => {
    const { lines } = await run({ kind: "list" });

    const note =
      lines.find((l) => l.includes("dependabot_merge_enabled")) ?? "";
    expect(note).toContain("gh pr merge");
  });

  test("reads through the read client only", async () => {
    const { write } = await run({ kind: "list" });

    expect(write).toEqual([]);
  });

  test("works the same for a session", async () => {
    const { code } = await run({ kind: "list" }, { env: SESSION });

    expect(code).toBe(0);
  });

  test("fails with the reason when the table is missing", async () => {
    const result = await run(
      { kind: "list" },
      {
        db: { failWith: new Error('relation "factory.holds" does not exist') },
      },
    );

    expect([
      result.code,
      result.lines.some((l) => l.includes("migration is not applied")),
    ]).toEqual([1, true]);
  });

  test("fails when the database cannot be reached", async () => {
    const { code } = await run(
      { kind: "list" },
      { db: { failWith: new Error("psql failed (exit 2)") } },
    );

    expect(code).toBe(1);
  });

  test("shows the recovery steps for a malformed row", async () => {
    const result = await run(
      { kind: "list" },
      { db: { active: [holdRow({ scope: "config" })] } },
    );

    expect([
      result.code,
      result.lines.some((l) => l.includes("inspect factory.holds with psql")),
    ]).toEqual([1, true]);
  });

  test("turns an escape sequence in the target into spaces, so that a row cannot forge a line", async () => {
    const { lines } = await run(
      { kind: "list" },
      {
        db: {
          active: [holdRow({ target: "acme/wid\u001b[2Kgets" })],
        },
      },
    );

    expect(lines.join("\n")).not.toContain("\u001b");
  });

  test("turns a newline in the target into a space, so that it stays one line", async () => {
    const { lines } = await run(
      { kind: "list" },
      {
        db: {
          invalid: [holdRow({ id: 9, target: "acme/a\n99  active  merge  x" })],
        },
      },
    );

    expect(lines.filter((line) => line.startsWith("9"))).toHaveLength(1);
  });

  test("shows the active holds before it reports that the invalid rows cannot be read", async () => {
    const base = fakeSql({ active: [holdRow()] });
    const read: HoldSqlClient = (strings, ...values) => {
      if (strings.join("?").includes("NOT (created_at")) {
        return {
          fetch: async () => {
            throw new Error("boom");
          },
          execute: async () => {},
        };
      }
      return base.sql(strings, ...values);
    };
    const lines: string[] = [];
    const code = await runCommand(
      { kind: "list" },
      {
        read,
        write: base.sql,
        branch: async () => "feat/x",
        env: {},
        confirm: async () => true,
        print: (line) => {
          lines.push(line);
        },
        activeFreezeCounts: async () => ({ schedule: 0, deploy: 0 }),
      },
    );

    expect([
      code,
      lines.findIndex((line) => line.startsWith("7")) <
        lines.findIndex((line) => line.startsWith("failed:")),
      lines.some((line) => line.startsWith("7")),
    ]).toEqual([1, true, true]);
  });

  test("says in the note that a dry run still makes the poll wait", async () => {
    const { lines } = await run({ kind: "list" });

    expect(lines.find((l) => l.startsWith("note:"))).toContain("dry run");
  });

  test("fails when the invalid rows cannot be read", async () => {
    let calls = 0;
    const base = fakeSql({});
    const read: HoldSqlClient = (strings, ...values) => {
      const text = strings.join("?");
      if (text.includes("NOT (created_at")) {
        calls += 1;
        return {
          fetch: async () => {
            throw new Error("boom");
          },
          execute: async () => {},
        };
      }
      return base.sql(strings, ...values);
    };
    const lines: string[] = [];
    const code = await runCommand(
      { kind: "list" },
      {
        read,
        write: base.sql,
        branch: async () => "feat/x",
        env: {},
        confirm: async () => true,
        print: (line) => {
          lines.push(line);
        },
        activeFreezeCounts: async () => ({ schedule: 0, deploy: 0 }),
      },
    );

    expect([code, calls]).toEqual([1, 1]);
  });
});

// ---- place ----

describe("place", () => {
  test("refuses a claim hold, because nothing reads it yet", async () => {
    const result = await run({
      ...PLACE_COMMAND,
      scope: "claim",
      target: "a/b#1",
    });

    expect([result.code, result.lines.join("\n")]).toEqual([
      1,
      expect.stringContaining("claim"),
    ]);
  });

  test("does not touch the database for a claim hold", async () => {
    const result = await run({
      ...PLACE_COMMAND,
      scope: "claim",
      target: "a/b#1",
    });

    expect([result.read, result.write]).toEqual([[], []]);
  });

  test("does not ask a human to confirm a claim hold", async () => {
    const { confirmations } = await run({
      ...PLACE_COMMAND,
      scope: "claim",
      target: "a/b#1",
    });

    expect(confirmations).toEqual([]);
  });

  test("refuses an unknown scope without touching the database", async () => {
    const result = await run({ ...PLACE_COMMAND, scope: "config" });

    expect([result.code, result.read, result.write]).toEqual([1, [], []]);
  });

  test("asks a human to confirm and shows the hold", async () => {
    const { confirmations } = await run(PLACE_COMMAND);

    expect(confirmations).toEqual([
      'hold merge acme/widgets for 60 minutes, reason "checking the lockfile"',
    ]);
  });

  test("stops when a human does not confirm", async () => {
    const result = await run(PLACE_COMMAND, { confirm: false });

    expect([result.code, result.write]).toEqual([1, []]);
  });

  test("says a human must confirm", async () => {
    const { lines } = await run(PLACE_COMMAND, { confirm: false });

    expect(lines.some((l) => l.includes("must confirm"))).toBe(true);
  });

  test("does not ask a session to confirm", async () => {
    const { confirmations } = await run(PLACE_COMMAND, { env: SESSION });

    expect(confirmations).toEqual([]);
  });

  test("places the hold with the session as the holder", async () => {
    const { write } = await run(PLACE_COMMAND, { env: SESSION });

    const insert = write.find((s) => s.text.startsWith("INSERT"));
    expect(insert?.values).toEqual([
      "merge",
      "acme/widgets",
      "checking the lockfile",
      "session",
      "session:feat/x",
      60,
    ]);
  });

  test("places the hold with a human as the holder", async () => {
    const { write } = await run(PLACE_COMMAND);

    const insert = write.find((s) => s.text.startsWith("INSERT"));
    expect(insert?.values.slice(3, 5)).toEqual(["human", "human"]);
  });

  test("writes through the write client only", async () => {
    const { read } = await run(PLACE_COMMAND);

    expect(read).toEqual([]);
  });

  test("reports the id and exits 0", async () => {
    const result = await run(PLACE_COMMAND);

    expect([
      result.code,
      result.lines.some((l) => l.startsWith("placed 5")),
    ]).toEqual([0, true]);
  });

  test("says which route a merge hold protects", async () => {
    const { lines } = await run(PLACE_COMMAND);

    const note =
      lines.find((l) => l.includes("dependabot_merge_enabled")) ?? "";
    expect(note).toContain("gh pr merge");
  });

  test("refuses when an active hold of the holder already exists", async () => {
    const result = await run(PLACE_COMMAND, { db: { inserted: [] } });

    expect([result.code, result.lines.join("\n")]).toEqual([
      1,
      expect.stringContaining(HOLD_ALREADY_ACTIVE),
    ]);
  });

  test("refuses a target that is not owner/repo, without a statement", async () => {
    const result = await run({ ...PLACE_COMMAND, target: "widgets" });

    expect([result.code, result.write]).toEqual([1, []]);
  });

  test("refuses minutes out of range, without a statement", async () => {
    const result = await run({ ...PLACE_COMMAND, minutes: 1441 });

    expect([result.code, result.write]).toEqual([1, []]);
  });

  test("fails when the database write fails", async () => {
    const { code } = await run(PLACE_COMMAND, {
      db: { failWith: new Error("boom") },
    });

    expect(code).toBe(1);
  });

  test("refuses a reason with control characters, without asking a human", async () => {
    const result = await run({ ...PLACE_COMMAND, reason: "a\u001b[31mb" });

    expect([result.code, result.confirmations, result.write]).toEqual([
      1,
      [],
      [],
    ]);
  });

  test("does not echo the rejected reason", async () => {
    const { lines } = await run({ ...PLACE_COMMAND, reason: "a\u202eb" });

    expect(lines.join("\n")).not.toContain("\u202e");
  });
});

// ---- release ----

describe("release", () => {
  const OTHERS = holdRow({ holder: "session:other", holder_kind: "session" });

  test("asks a human to confirm", async () => {
    const { confirmations } = await run(
      { kind: "release", id: 7 },
      { db: { byId: [OTHERS] } },
    );

    expect(confirmations).toEqual(["release hold 7"]);
  });

  test("stops when a human does not confirm", async () => {
    const result = await run(
      { kind: "release", id: 7 },
      { db: { byId: [OTHERS] }, confirm: false },
    );

    expect([result.code, result.write]).toEqual([1, []]);
  });

  test("lets a human release a hold of another holder", async () => {
    const result = await run(
      { kind: "release", id: 7 },
      { db: { byId: [OTHERS] } },
    );

    expect([result.code, result.lines]).toEqual([0, ["released 7"]]);
  });

  test("records the human as the one who released it", async () => {
    const { write } = await run(
      { kind: "release", id: 7 },
      { db: { byId: [OTHERS] } },
    );

    const update = write.find((s) => s.text.startsWith("UPDATE"));
    expect(update?.values[0]).toBe("human");
  });

  test("lets a session release its own hold without a confirmation", async () => {
    const result = await run(
      { kind: "release", id: 7 },
      { db: { byId: [holdRow()] }, env: SESSION },
    );

    expect([result.code, result.confirmations]).toEqual([0, []]);
  });

  test("refuses a session that releases a hold of another holder", async () => {
    const result = await run(
      { kind: "release", id: 7 },
      { db: { byId: [OTHERS] }, env: SESSION },
    );

    expect([result.code, result.lines.join("\n")]).toEqual([
      1,
      expect.stringContaining("only its own hold"),
    ]);
  });

  test("sends no update when a session is refused", async () => {
    const { write } = await run(
      { kind: "release", id: 7 },
      { db: { byId: [OTHERS] }, env: SESSION },
    );

    expect(write.some((s) => s.text.startsWith("UPDATE"))).toBe(false);
  });

  test("refuses an id that has no hold", async () => {
    const result = await run({ kind: "release", id: 99 });

    expect([result.code, result.lines.join("\n")]).toEqual([
      1,
      expect.stringContaining("no hold has that id"),
    ]);
  });

  test("releases a claim hold too, so that none is left behind", async () => {
    const result = await run(
      { kind: "release", id: 7 },
      {
        db: {
          byId: [holdRow({ scope: "claim", target: "acme/widgets#1" })],
        },
        env: SESSION,
      },
    );

    expect(result.code).toBe(0);
  });

  test("reads and writes through the write client", async () => {
    const result = await run(
      { kind: "release", id: 7 },
      { db: { byId: [OTHERS] } },
    );

    expect(result.read).toEqual([]);
  });
});
