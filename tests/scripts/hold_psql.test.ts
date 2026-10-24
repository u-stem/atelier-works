import { describe, expect, test } from "bun:test";
import {
  createHoldPsqlClient,
  HOLD_PSQL_TIMEOUT_MS,
  type HoldPsqlMode,
  type HoldPsqlRequest,
  type HoldPsqlResult,
  runHoldPsql,
} from "../../scripts/hold_psql.ts";

// psqlの経路は、値をSQLに埋め込まず、psqlの変数(`:'pN'`と`--set`)で束縛する。
// ここでは偽の実行関数に渡る引数と標準入力を確かめる。実DBでの束縛は`scripts/test-db-holds.ts`が確かめる。

const COMPOSE = "/repo/infra/docker-compose.yml";
const OK_ROWS: HoldPsqlResult = {
  exitCode: 0,
  stdout: "[]\n",
  stderr: "",
  timedOut: false,
};

type Harness = {
  readonly requests: HoldPsqlRequest[];
  readonly client: ReturnType<typeof createHoldPsqlClient>;
};

function harness(
  options: {
    readonly mode?: HoldPsqlMode;
    readonly database?: string;
    readonly result?: HoldPsqlResult;
    readonly timeoutMs?: number;
  } = {},
): Harness {
  const requests: HoldPsqlRequest[] = [];
  const client = createHoldPsqlClient({
    composeFile: COMPOSE,
    database: options.database ?? "datatable_db",
    mode: options.mode ?? "read",
    run: async (request) => {
      requests.push(request);
      return options.result ?? OK_ROWS;
    },
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  });
  return { requests, client };
}

function only(requests: readonly HoldPsqlRequest[]): HoldPsqlRequest {
  const [first] = requests;
  if (first === undefined) throw new Error("no request was made");
  return first;
}

/** 値の束縛より前の、固定の引数。 */
function fixedArgv(request: HoldPsqlRequest): string[] {
  return request.argv.filter((arg) => !arg.startsWith("--set="));
}

describe("createHoldPsqlClient argv", () => {
  test("runs psql in the db container through docker compose", async () => {
    const { requests, client } = harness();

    await client`SELECT 1`.fetch();

    expect(fixedArgv(only(requests))).toEqual([
      "docker",
      "compose",
      "-f",
      COMPOSE,
      "exec",
      "-T",
      "-e",
      "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000",
      "db",
      "psql",
      "-X",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "datatable_db",
      "-t",
      "-A",
    ]);
  });

  test("sets a lock timeout and no read-only mode in write mode", async () => {
    const { requests, client } = harness({ mode: "write" });

    await client`SELECT 1`.execute();

    expect(only(requests).argv).toContain(
      "PGOPTIONS=-c statement_timeout=10000 -c lock_timeout=5000",
    );
  });

  test("does not set read-only mode in write mode", async () => {
    const { requests, client } = harness({ mode: "write" });

    await client`SELECT 1`.execute();

    expect(only(requests).argv.join(" ")).not.toContain("read_only");
  });

  test("passes the database it is given to -d", async () => {
    const { requests, client } = harness({ database: "factory_test" });

    await client`SELECT 1`.fetch();

    const argv = only(requests).argv;
    expect(argv[argv.indexOf("-d") + 1]).toBe("factory_test");
  });

  test("passes the compose file it is given to -f", async () => {
    const { requests, client } = harness();

    await client`SELECT 1`.fetch();

    const argv = only(requests).argv;
    expect(argv[argv.indexOf("-f") + 1]).toBe(COMPOSE);
  });

  test("does not use -c, which would not expand the variables", async () => {
    const { requests, client } = harness();

    await client`SELECT 1`.fetch();

    expect(only(requests).argv).not.toContain("-c");
  });
});

describe("createHoldPsqlClient binding", () => {
  test("binds a string as a psql variable", async () => {
    const { requests, client } = harness();

    await client`SELECT ${"merge"}::text AS scope`.fetch();

    expect(only(requests).stdin).toContain("SELECT :'p1'::text AS scope");
  });

  test("passes the string value in --set", async () => {
    const { requests, client } = harness();

    await client`SELECT ${"merge"}::text`.fetch();

    expect(only(requests).argv).toContain("--set=p1=merge");
  });

  test("keeps a quote, a backslash, a colon name and = out of the sql", async () => {
    const { requests, client } = harness();
    const tricky = "it's a\\b :foo =x";

    await client`SELECT ${tricky}::text`.fetch();

    expect(only(requests).stdin).not.toContain("it's");
  });

  test("passes a tricky string to --set as one word", async () => {
    const { requests, client } = harness();
    const tricky = "it's a\\b :foo =x";

    await client`SELECT ${tricky}::text`.fetch();

    expect(only(requests).argv).toContain(`--set=p1=${tricky}`);
  });

  test("binds a number as a psql variable", async () => {
    const { requests, client } = harness();

    await client`SELECT ${5}::integer`.fetch();

    expect(only(requests).stdin).toContain("SELECT :'p1'::integer");
  });

  test("passes the number in --set", async () => {
    const { requests, client } = harness();

    await client`SELECT ${5}::integer`.fetch();

    expect(only(requests).argv).toContain("--set=p1=5");
  });

  test("writes null as NULL in the sql", async () => {
    const { requests, client } = harness();

    await client`SELECT ${null}::text IS NULL`.fetch();

    expect(only(requests).stdin).toContain("SELECT NULL::text IS NULL");
  });

  test("writes undefined as NULL in the sql", async () => {
    const { requests, client } = harness();

    await client`SELECT ${undefined}::text IS NULL`.fetch();

    expect(only(requests).stdin).toContain("SELECT NULL::text IS NULL");
  });

  test("passes no variable for null", async () => {
    const { requests, client } = harness();

    await client`SELECT ${null}::text`.fetch();

    expect(only(requests).argv.some((arg) => arg.startsWith("--set="))).toBe(
      false,
    );
  });

  test("numbers the variables by the position of the value", async () => {
    const { requests, client } = harness();

    await client`SELECT ${null}::text, ${"a"}::text, ${3}::integer`.fetch();

    expect(
      only(requests).argv.filter((arg) => arg.startsWith("--set=")),
    ).toEqual(["--set=p2=a", "--set=p3=3"]);
  });

  test("uses the numbered names in the sql", async () => {
    const { requests, client } = harness();

    await client`SELECT ${null}::text, ${"a"}::text, ${3}::integer`.fetch();

    expect(only(requests).stdin).toContain(
      "SELECT NULL::text, :'p2'::text, :'p3'::integer",
    );
  });

  test("passes the variables in the order of the values", async () => {
    const { requests, client } = harness();

    await client`SELECT ${"a"}::text, ${"b"}::text`.fetch();

    expect(
      only(requests).argv.filter((arg) => arg.startsWith("--set=")),
    ).toEqual(["--set=p1=a", "--set=p2=b"]);
  });

  test("rejects a string with a NUL character", async () => {
    const { client } = harness();

    await expect(client`SELECT ${"a\u0000b"}::text`.fetch()).rejects.toThrow(
      "NUL",
    );
  });

  test("does not run psql for a string with a NUL character", async () => {
    const { requests, client } = harness();

    await client`SELECT ${"a\u0000b"}::text`.fetch().catch(() => undefined);

    expect(requests).toEqual([]);
  });

  test.each([
    ["a boolean", true],
    ["a Date", new Date(0)],
    ["an array", ["a"]],
    ["a bigint", 1n],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["an object", { a: 1 }],
  ])("rejects %s", async (_label, value) => {
    const { client } = harness();

    await expect(client`SELECT ${value}`.fetch()).rejects.toThrow(
      "unsupported",
    );
  });
});

describe("createHoldPsqlClient fetch", () => {
  test("wraps the statement so that psql prints the rows as JSON", async () => {
    const { requests, client } = harness();

    await client`SELECT id FROM t WHERE id = ${1}::bigint`.fetch();

    expect(only(requests).stdin).toBe(
      "WITH q AS (SELECT id FROM t WHERE id = :'p1'::bigint) SELECT coalesce(json_agg(q ORDER BY q.id), '[]'::json) FROM q;\n",
    );
  });

  test("removes the trailing semicolon and spaces before wrapping", async () => {
    const { requests, client } = harness();

    await client`  SELECT 1 AS id ; `.fetch();

    expect(only(requests).stdin).toBe(
      "WITH q AS (SELECT 1 AS id) SELECT coalesce(json_agg(q ORDER BY q.id), '[]'::json) FROM q;\n",
    );
  });

  test("parses the JSON array of rows", async () => {
    const { client } = harness({
      result: {
        ...OK_ROWS,
        stdout: '[{"id":1,"reason":"a"},{"id":2,"reason":"b"}]\n',
      },
    });

    expect(await client`SELECT 1`.fetch()).toEqual([
      { id: 1, reason: "a" },
      { id: 2, reason: "b" },
    ]);
  });

  test("rejects output that is not a JSON array", async () => {
    const { client } = harness({ result: { ...OK_ROWS, stdout: "{}\n" } });

    await expect(client`SELECT 1`.fetch()).rejects.toThrow("JSON array");
  });

  test("rejects an array that holds something other than rows", async () => {
    const { client } = harness({ result: { ...OK_ROWS, stdout: "[1]\n" } });

    await expect(client`SELECT 1`.fetch()).rejects.toThrow("row");
  });

  test("rejects empty output", async () => {
    const { client } = harness({ result: { ...OK_ROWS, stdout: "" } });

    await expect(client`SELECT 1`.fetch()).rejects.toThrow();
  });
});

describe("createHoldPsqlClient execute", () => {
  test("sends the statement as it is, without wrapping", async () => {
    const { requests, client } = harness({ mode: "write" });

    await client`UPDATE t SET a = ${"x"}::text`.execute();

    expect(only(requests).stdin).toBe("UPDATE t SET a = :'p1'::text;\n");
  });

  test("sends one statement per call", async () => {
    const { requests, client } = harness({ mode: "write" });

    await client`UPDATE t SET a = 1`.execute();
    await client`UPDATE t SET a = 2`.execute();

    expect(requests).toHaveLength(2);
  });

  test("does not open a transaction around the statement", async () => {
    const { requests, client } = harness({ mode: "write" });

    await client`UPDATE t SET a = 1`.execute();

    expect(only(requests).stdin).not.toMatch(/\bBEGIN\b/i);
  });
});

describe("createHoldPsqlClient failures", () => {
  const FAILED: HoldPsqlResult = {
    exitCode: 3,
    stdout: "",
    stderr: 'psql:<stdin>:1: ERROR:  relation "factory.holds" does not exist\n',
    timedOut: false,
  };

  test("rejects when psql exits with a nonzero code", async () => {
    const { client } = harness({ result: FAILED });

    await expect(client`SELECT 1`.fetch()).rejects.toThrow("exit 3");
  });

  test("carries the psql error text, so that a missing table is recognized", async () => {
    const { client } = harness({ result: FAILED });

    await expect(client`SELECT 1`.fetch()).rejects.toThrow(
      'relation "factory.holds" does not exist',
    );
  });

  test("rejects an execute with a nonzero code", async () => {
    const { client } = harness({ mode: "write", result: FAILED });

    await expect(client`UPDATE t SET a = 1`.execute()).rejects.toThrow(
      "exit 3",
    );
  });

  test("cuts the error text at 200 characters", async () => {
    const { client } = harness({
      result: { ...FAILED, stderr: "x".repeat(500) },
    });

    const error = await client`SELECT 1`.fetch().catch((e: unknown) => e);

    expect(error instanceof Error && error.message.length < 300).toBe(true);
  });

  test("turns control characters in the error text into spaces", async () => {
    const { client } = harness({
      result: { ...FAILED, stderr: "bad\u001b[31m\nline" },
    });

    const error = await client`SELECT 1`.fetch().catch((e: unknown) => e);

    expect(error instanceof Error && error.message).toContain("bad [31m line");
  });

  test("says a timed out read timed out", async () => {
    const { client } = harness({
      result: { exitCode: null, stdout: "", stderr: "", timedOut: true },
    });

    await expect(client`SELECT 1`.fetch()).rejects.toThrow("timed out");
  });

  test("says the result of a timed out write is unknown", async () => {
    const { client } = harness({
      mode: "write",
      result: { exitCode: null, stdout: "", stderr: "", timedOut: true },
    });

    await expect(client`UPDATE t SET a = 1`.execute()).rejects.toThrow(
      "result is unknown",
    );
  });

  test("points a timed out write at hold:list", async () => {
    const { client } = harness({
      mode: "write",
      result: { exitCode: null, stdout: "", stderr: "", timedOut: true },
    });

    await expect(client`UPDATE t SET a = 1`.execute()).rejects.toThrow(
      "hold:list",
    );
  });
});

describe("createHoldPsqlClient time limit", () => {
  test("gives the run function 20 seconds by default", async () => {
    const { requests, client } = harness();

    await client`SELECT 1`.fetch();

    expect(only(requests).timeoutMs).toBe(20_000);
  });

  test("exports the default limit", () => {
    expect(HOLD_PSQL_TIMEOUT_MS).toBe(20_000);
  });

  test("passes a limit it is given", async () => {
    const { requests, client } = harness({ timeoutMs: 1_500 });

    await client`SELECT 1`.fetch();

    expect(only(requests).timeoutMs).toBe(1_500);
  });
});

describe("runHoldPsql", () => {
  test("passes the standard input to the process", async () => {
    const result = await runHoldPsql({
      argv: ["cat"],
      stdin: "hello",
      timeoutMs: 5_000,
    });

    expect(result.stdout).toBe("hello");
  });

  test("returns the exit code", async () => {
    const result = await runHoldPsql({
      argv: ["sh", "-c", "exit 3"],
      stdin: "",
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(3);
  });

  test("returns the standard error", async () => {
    const result = await runHoldPsql({
      argv: ["sh", "-c", "echo oops >&2"],
      stdin: "",
      timeoutMs: 5_000,
    });

    expect(result.stderr).toBe("oops\n");
  });

  test("stops a process that outlives the limit", async () => {
    const result = await runHoldPsql({
      argv: ["sleep", "5"],
      stdin: "",
      timeoutMs: 200,
    });

    expect(result.timedOut).toBe(true);
  });

  test("does not mark a process that finished in time", async () => {
    const result = await runHoldPsql({
      argv: ["true"],
      stdin: "",
      timeoutMs: 5_000,
    });

    expect(result.timedOut).toBe(false);
  });
});
