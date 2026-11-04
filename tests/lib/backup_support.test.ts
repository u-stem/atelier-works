import { describe, expect, test } from "bun:test";
import {
  BACKUP_FILES,
  backupFailureMessage,
  buildManifest,
  commandEnv,
  describeCommandFailure,
  generationName,
  isGenerationName,
  PG_DUMPALL_BIN,
  parsePgConnection,
  partialName,
  pgDumpallArgv,
  pgDumpallEnv,
  REDACTED,
  redactReferences,
  selectGenerationsToDelete,
  selectStalePartials,
  stateTarArgv,
} from "../../f/factory/lib/backup_support.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const CONNECTION = {
  host: "db",
  port: "5432",
  user: "postgres",
  password: "s3cret",
  database: "postgres",
};

describe("generationName", () => {
  test("formats the time as YYYYMMDDTHHMMSSZ in UTC", () => {
    expect(generationName(new Date("2026-11-03T17:30:05.123Z"))).toBe(
      "20261103T173005Z",
    );
  });
});

describe("isGenerationName", () => {
  test.each([
    ["20261103T173005Z", true],
    [".partial-20261103T173005Z", false],
    ["20261103T173005", false],
    ["lost+found", false],
  ])("judges %s as %s", (name, expected) => {
    expect(isGenerationName(name)).toBe(expected);
  });
});

describe("partialName", () => {
  test("prefixes the generation with .partial-", () => {
    expect(partialName("20261103T173005Z")).toBe(".partial-20261103T173005Z");
  });
});

describe("selectStalePartials", () => {
  test("returns the partial directories", () => {
    expect(
      selectStalePartials([
        ".partial-20261102T173000Z",
        "20261102T173000Z",
        "lost+found",
      ]),
    ).toEqual([".partial-20261102T173000Z"]);
  });
});

describe("selectGenerationsToDelete", () => {
  test("returns the oldest generations beyond keep", () => {
    expect(
      selectGenerationsToDelete(
        ["20261103T173000Z", "20261101T173000Z", "20261102T173000Z"],
        2,
      ),
    ).toEqual(["20261101T173000Z"]);
  });

  test("returns nothing while the generations fit in keep", () => {
    expect(
      selectGenerationsToDelete(["20261102T173000Z", "20261103T173000Z"], 2),
    ).toEqual([]);
  });

  test("ignores partial directories and other names", () => {
    expect(
      selectGenerationsToDelete(
        [".partial-20261101T173000Z", "lost+found", "20261103T173000Z"],
        1,
      ),
    ).toEqual([]);
  });

  test("returns the deleted generations from the oldest", () => {
    expect(
      selectGenerationsToDelete(
        ["20261104T173000Z", "20261102T173000Z", "20261101T173000Z"],
        1,
      ),
    ).toEqual(["20261101T173000Z", "20261102T173000Z"]);
  });
});

describe("redactReferences", () => {
  test("replaces a variable reference", () => {
    expect(redactReferences("$var:f/factory/github_token")).toBe(REDACTED);
  });

  test("replaces a resource reference", () => {
    expect(redactReferences("$res:f/factory/some_resource")).toBe(REDACTED);
  });

  test("keeps an ordinary string", () => {
    expect(redactReferences("factory")).toBe("factory");
  });

  test("keeps a string that only contains a reference after its start", () => {
    expect(redactReferences("see $var:f/factory/x")).toBe(
      "see $var:f/factory/x",
    );
  });

  test("replaces a reference inside an object", () => {
    expect(
      redactReferences({ owners: [], discord: "$var:f/factory/x" }),
    ).toEqual({ owners: [], discord: REDACTED });
  });

  test("replaces a reference inside an array", () => {
    expect(redactReferences(["a", "$res:f/factory/y"])).toEqual([
      "a",
      REDACTED,
    ]);
  });

  test("keeps numbers, booleans and null", () => {
    expect(redactReferences({ n: 7, b: true, z: null })).toEqual({
      n: 7,
      b: true,
      z: null,
    });
  });

  test("replaces a value nested beyond the depth it inspects", () => {
    const deep: unknown = JSON.parse(`${"[".repeat(40)}1${"]".repeat(40)}`);
    expect(JSON.stringify(redactReferences(deep))).toContain(REDACTED);
  });
});

describe("parsePgConnection", () => {
  test("reads the host, user, password and database", () => {
    expect(parsePgConnection("postgres://postgres:s3cret@db/postgres")).toEqual(
      CONNECTION,
    );
  });

  test("decodes a percent-encoded password", () => {
    expect(
      parsePgConnection("postgres://postgres:p%40ss%3Aw%2Frd@db/postgres")
        ?.password,
    ).toBe("p@ss:w/rd");
  });

  test("reads an explicit port", () => {
    expect(parsePgConnection("postgres://u:p@db:6543/postgres")?.port).toBe(
      "6543",
    );
  });

  test("accepts the postgresql scheme", () => {
    expect(parsePgConnection("postgresql://u:p@db/postgres")?.host).toBe("db");
  });

  test.each([
    ["not a url"],
    ["mysql://u:p@db/postgres"],
    ["postgres://db/postgres"],
    ["postgres://u:p@db/"],
    ["postgres://u:p@db/a/b"],
    ["postgres://u:%E0%A4%A@db/postgres"],
  ])("returns null for %s", (url) => {
    expect(parsePgConnection(url)).toBeNull();
  });
});

describe("commandEnv", () => {
  test("passes PATH when it is known", () => {
    expect(commandEnv("/usr/bin:/bin")).toEqual({ PATH: "/usr/bin:/bin" });
  });

  test("passes nothing when PATH is unknown", () => {
    expect(commandEnv(undefined)).toEqual({});
  });
});

describe("pgDumpallArgv", () => {
  test("writes to the file with the pinned pg_dumpall and never prompts", () => {
    expect(pgDumpallArgv("/b/.partial-x/cluster.sql")).toEqual([
      PG_DUMPALL_BIN,
      "--no-password",
      "--file=/b/.partial-x/cluster.sql",
    ]);
  });

  test("keeps the connection out of the arguments", () => {
    expect(pgDumpallArgv("/b/cluster.sql").join(" ")).not.toContain("s3cret");
  });
});

describe("pgDumpallEnv", () => {
  test("passes the connection in the libpq variables", () => {
    expect(pgDumpallEnv(CONNECTION, "/usr/bin")).toEqual({
      PATH: "/usr/bin",
      PGHOST: "db",
      PGPORT: "5432",
      PGUSER: "postgres",
      PGPASSWORD: "s3cret",
      PGDATABASE: "postgres",
      PGCONNECT_TIMEOUT: "30",
    });
  });
});

describe("stateTarArgv", () => {
  test("archives factory_state without the login and slot directories", () => {
    expect(stateTarArgv("/b/.partial-x/factory_state.tar")).toEqual([
      "tar",
      "-C",
      "/var/lib/factory",
      "-cf",
      "/b/.partial-x/factory_state.tar",
      "--exclude=./claude",
      "--exclude=./gh",
      "--exclude=./check-slots",
      ".",
    ]);
  });
});

describe("buildManifest", () => {
  test("records the time, the deployed sha and the size of each file", () => {
    expect(
      buildManifest({
        generation: "20261103T173000Z",
        createdAt: new Date("2026-11-03T17:30:00.000Z"),
        deployedSha: SHA,
        files: { [BACKUP_FILES.clusterSql]: 10 },
      }),
    ).toEqual({
      generation: "20261103T173000Z",
      created_at: "2026-11-03T17:30:00.000Z",
      deployed_sha: SHA,
      files: { "cluster.sql": 10 },
    });
  });
});

describe("describeCommandFailure", () => {
  test("names the exit code and the error output", () => {
    expect(
      describeCommandFailure({
        exitCode: 1,
        timedOut: false,
        stderr: "connection refused\n",
      }),
    ).toBe("exited with 1: connection refused");
  });

  test("says that the command timed out", () => {
    expect(
      describeCommandFailure({ exitCode: 143, timedOut: true, stderr: "" }),
    ).toBe("timed out");
  });
});

describe("backupFailureMessage", () => {
  test("names the stage", () => {
    expect(backupFailureMessage("tar", "exited with 2")).toContain("tar");
  });

  test("keeps the end of a long detail", () => {
    expect(
      backupFailureMessage("pg_dumpall", `${"a".repeat(600)}END`),
    ).toContain(`${"a".repeat(497)}END`);
  });

  test("keeps no more than 500 characters of the detail", () => {
    expect(
      backupFailureMessage("pg_dumpall", `${"a".repeat(600)}END`),
    ).not.toContain("a".repeat(498));
  });
});
