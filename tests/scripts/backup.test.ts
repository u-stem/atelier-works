import { describe, expect, test } from "bun:test";
import {
  BackupError,
  type BackupIo,
  type BackupResult,
  runBackup,
} from "../../f/factory/backup.ts";
import { backupFailureMessage } from "../../f/factory/lib/backup_support.ts";
import { logger } from "../../f/factory/lib/log.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";
import type {
  CommandResult,
  CommandRunOptions,
} from "../../f/factory/lib/workspace.ts";
import { yamlOf } from "./worker_boundary_scan.ts";

const NOW = new Date("2026-11-03T17:30:00.000Z");
const GENERATION = "20261103T173000Z";
const ROOT = "/var/lib/factory-backups";
const PARTIAL = `${ROOT}/.partial-${GENERATION}`;
const PASSWORD = "s3cret-value";
const DB_URL = `postgres://postgres:${PASSWORD}@db/postgres`;
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SIZES: Readonly<Record<string, number>> = {
  "cluster.sql": 1000,
  "factory_state.tar": 2000,
  "factory_config.json": 300,
};
const RAW_CONFIG = {
  owners: [],
  discord: "$var:f/factory/discord_webhook_url",
  backup_keep_generations: 2,
};
const TAR_CHANGED = "tar: ./requirements/a.md: file changed as we read it";
const OK: CommandResult = {
  stdout: "",
  stderr: "",
  exitCode: 0,
  timedOut: false,
};

type Command = {
  readonly argv: readonly string[];
  readonly options: CommandRunOptions | undefined;
};

type Calls = {
  readonly commands: Command[];
  readonly written: Map<string, string>;
  readonly removed: string[];
  readonly renamed: (readonly [string, string])[];
  readonly chmodded: (readonly [string, number])[];
  readonly notices: NoticeRecord[];
  readonly logs: string[];
};

type Options = {
  /** 実行の前に置き場にある名前。 */
  readonly entries?: readonly string[];
  /** 失敗させるコマンドの名前(argv[0]の最後の要素)。 */
  readonly failing?: "pg_dumpall" | "tar";
  /** 失敗させるコマンドの終了コード。既定は2。 */
  readonly exitCode?: number;
  readonly stderr?: string;
  /** 補間しない`factory_config`の値。既定は`RAW_CONFIG`。 */
  readonly rawConfig?: unknown;
  readonly url?: string;
  /** `null`なら読み取りが例外になる。 */
  readonly deployedSha?: string | null;
  readonly noticeFails?: boolean;
};

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

// 置き場の中身を名前の集合で持つ偽の入出力。作成、改名、削除を集合に反映し、一覧はその時点の集合を返す。
function setup(options: Options): { io: BackupIo; calls: Calls } {
  const calls: Calls = {
    commands: [],
    written: new Map(),
    removed: [],
    renamed: [],
    chmodded: [],
    notices: [],
    logs: [],
  };
  const names = new Set(options.entries ?? []);
  const io: BackupIo = {
    now: () => NOW,
    path: "/usr/bin:/bin",
    run: async (argv, runOptions) => {
      calls.commands.push({ argv, options: runOptions });
      const failed = basename(argv[0] ?? "") === options.failing;
      return failed
        ? {
            ...OK,
            exitCode: options.exitCode ?? 2,
            stderr: options.stderr ?? "connection refused",
          }
        : OK;
    },
    listDir: async () => [...names],
    makeDir: async (path) => {
      if (path.startsWith(`${ROOT}/`)) names.add(basename(path));
    },
    chmod: async (path, mode) => {
      calls.chmodded.push([path, mode]);
    },
    writeTextFile: async (path, content) => {
      calls.written.set(path, content);
    },
    fileSize: async (path) => SIZES[basename(path)] ?? 0,
    rename: async (from, to) => {
      calls.renamed.push([from, to]);
      names.delete(basename(from));
      names.add(basename(to));
    },
    removePath: async (path) => {
      calls.removed.push(path);
      names.delete(basename(path));
    },
    getVariable: async (path) => {
      if (path === "f/factory/db_backup_url") return options.url ?? DB_URL;
      if (options.deployedSha === null) throw new Error("variable not found");
      return options.deployedSha ?? SHA;
    },
    getRawConfig: async () =>
      "rawConfig" in options ? options.rawConfig : RAW_CONFIG,
    addNotice: async (record) => {
      if (options.noticeFails === true) throw new Error("database is down");
      calls.notices.push(record);
      return 1;
    },
    log: logger("test", { sink: (line) => calls.logs.push(line) }),
  };
  return { io, calls };
}

type Outcome = {
  readonly calls: Calls;
  readonly result: BackupResult | undefined;
  readonly error: unknown;
};

async function backup(options: Options = {}): Promise<Outcome> {
  const { io, calls } = setup(options);
  try {
    return { calls, result: await runBackup(io), error: undefined };
  } catch (error) {
    return { calls, result: undefined, error };
  }
}

function argvOf(outcome: Outcome, index: number): readonly string[] {
  return outcome.calls.commands[index]?.argv ?? [];
}

function writtenJson(outcome: Outcome, name: string): unknown {
  return JSON.parse(outcome.calls.written.get(`${PARTIAL}/${name}`) ?? "null");
}

// 指定した水準のログ行を、改行でつないで返す。
function logged(outcome: Outcome, level: "warn" | "error"): string {
  return outcome.calls.logs
    .filter((line) => line.includes(`"level":"${level}"`))
    .join("\n");
}

function stageOf(error: unknown): string | null {
  return error instanceof BackupError ? error.stage : null;
}

describe("runBackup on success", () => {
  test("dumps the whole cluster into the partial directory", async () => {
    expect(argvOf(await backup(), 0)).toEqual([
      "/usr/lib/postgresql/18/bin/pg_dumpall",
      "--no-password",
      `--file=${PARTIAL}/cluster.sql`,
    ]);
  });

  test("keeps the password out of the pg_dumpall arguments", async () => {
    expect(argvOf(await backup(), 0).join(" ")).not.toContain(PASSWORD);
  });

  test("passes the connection to pg_dumpall in the environment", async () => {
    expect((await backup()).calls.commands[0]?.options?.env).toEqual({
      PATH: "/usr/bin:/bin",
      PGHOST: "db",
      PGPORT: "5432",
      PGUSER: "postgres",
      PGPASSWORD: PASSWORD,
      PGDATABASE: "postgres",
      PGCONNECT_TIMEOUT: "30",
    });
  });

  test("archives factory_state without the login and slot directories", async () => {
    expect(argvOf(await backup(), 1)).toEqual([
      "tar",
      "-C",
      "/var/lib/factory",
      "-cf",
      `${PARTIAL}/factory_state.tar`,
      "--exclude=./claude",
      "--exclude=./gh",
      "--exclude=./check-slots",
      ".",
    ]);
  });

  test("gives each command thirty minutes", async () => {
    expect(
      (await backup()).calls.commands.map((c) => c.options?.timeoutMs),
    ).toEqual([1_800_000, 1_800_000]);
  });

  test("writes factory_config with its references redacted", async () => {
    expect(writtenJson(await backup(), "factory_config.json")).toEqual({
      owners: [],
      discord: "<redacted>",
      backup_keep_generations: 2,
    });
  });

  test("writes the size of each file into the manifest", async () => {
    expect(writtenJson(await backup(), "manifest.json")).toMatchObject({
      files: SIZES,
    });
  });

  test("records the deployed sha in the manifest", async () => {
    expect(writtenJson(await backup(), "manifest.json")).toMatchObject({
      deployed_sha: SHA,
    });
  });

  test("records no deployed sha when the variable cannot be read", async () => {
    expect(
      writtenJson(await backup({ deployedSha: null }), "manifest.json"),
    ).toMatchObject({ deployed_sha: null });
  });

  test("records no deployed sha when the variable is empty", async () => {
    expect(
      writtenJson(await backup({ deployedSha: "" }), "manifest.json"),
    ).toMatchObject({ deployed_sha: null });
  });

  test("renames the partial directory to the generation last", async () => {
    expect((await backup()).calls.renamed).toEqual([
      [PARTIAL, `${ROOT}/${GENERATION}`],
    ]);
  });

  test("closes the backup root to everyone but root", async () => {
    expect((await backup()).calls.chmodded).toContainEqual([ROOT, 0o700]);
  });

  test("closes the partial directory to everyone but root", async () => {
    expect((await backup()).calls.chmodded).toContainEqual([PARTIAL, 0o700]);
  });

  test("removes a partial directory left by an earlier run", async () => {
    const outcome = await backup({ entries: [".partial-20261102T173000Z"] });
    expect(outcome.calls.removed).toContain(
      `${ROOT}/.partial-20261102T173000Z`,
    );
  });

  test("returns the generations beyond backup_keep_generations as deleted", async () => {
    const outcome = await backup({
      entries: ["20261101T173000Z", "20261102T173000Z"],
    });
    expect(outcome.result?.deleted).toEqual(["20261101T173000Z"]);
  });

  test("removes the deleted generations from the backup root", async () => {
    const outcome = await backup({
      entries: ["20261101T173000Z", "20261102T173000Z"],
    });
    expect(outcome.calls.removed).toContain(`${ROOT}/20261101T173000Z`);
  });

  test("keeps seven generations when backup_keep_generations is absent", async () => {
    const outcome = await backup({
      rawConfig: {},
      entries: [
        "20261027T173000Z",
        "20261028T173000Z",
        "20261029T173000Z",
        "20261030T173000Z",
        "20261031T173000Z",
        "20261101T173000Z",
        "20261102T173000Z",
      ],
    });
    expect(outcome.result?.deleted).toEqual(["20261027T173000Z"]);
  });

  test("leaves no notice", async () => {
    expect((await backup()).calls.notices).toEqual([]);
  });

  test("returns the generation", async () => {
    expect((await backup()).result?.generation).toBe(GENERATION);
  });
});

describe("runBackup when pg_dumpall fails", () => {
  test("fails the job at the pg_dumpall stage", async () => {
    expect(stageOf((await backup({ failing: "pg_dumpall" })).error)).toBe(
      "pg_dumpall",
    );
  });

  test("records a backup_failed notice", async () => {
    const outcome = await backup({ failing: "pg_dumpall" });
    expect(outcome.calls.notices.map((n) => n.kind)).toEqual(["backup_failed"]);
  });

  test("puts only the stage into the notice", async () => {
    const outcome = await backup({ failing: "pg_dumpall" });
    expect(outcome.calls.notices[0]?.message).toBe(
      backupFailureMessage("pg_dumpall"),
    );
  });

  test("keeps the error output out of the notice", async () => {
    const outcome = await backup({ failing: "pg_dumpall" });
    expect(outcome.calls.notices[0]?.message).not.toContain(
      "connection refused",
    );
  });

  test("logs the error output", async () => {
    const outcome = await backup({ failing: "pg_dumpall" });
    expect(logged(outcome, "error")).toContain(
      "exited with 2: connection refused",
    );
  });

  test("keeps the password out of the log", async () => {
    const outcome = await backup({
      failing: "pg_dumpall",
      stderr: `password ${PASSWORD} was rejected`,
    });
    expect(outcome.calls.logs.join("\n")).not.toContain(PASSWORD);
  });

  test("fails the job even when pg_dumpall exits with 1", async () => {
    expect(
      stageOf((await backup({ failing: "pg_dumpall", exitCode: 1 })).error),
    ).toBe("pg_dumpall");
  });

  test("keeps the password out of the notice", async () => {
    const outcome = await backup({
      failing: "pg_dumpall",
      stderr: `password ${PASSWORD} was rejected`,
    });
    expect(outcome.calls.notices[0]?.message).not.toContain(PASSWORD);
  });

  test("removes the partial directory", async () => {
    expect((await backup({ failing: "pg_dumpall" })).calls.removed).toContain(
      PARTIAL,
    );
  });

  test("does not archive factory_state", async () => {
    expect(
      (await backup({ failing: "pg_dumpall" })).calls.commands,
    ).toHaveLength(1);
  });

  test("does not rename the partial directory", async () => {
    expect((await backup({ failing: "pg_dumpall" })).calls.renamed).toEqual([]);
  });

  test("keeps the earlier generations", async () => {
    const outcome = await backup({
      failing: "pg_dumpall",
      entries: ["20261101T173000Z", "20261102T173000Z"],
    });
    expect(
      outcome.calls.removed.filter((path) => path.startsWith(`${ROOT}/2`)),
    ).toEqual([]);
  });
});

describe("runBackup when tar fails", () => {
  test("fails the job at the tar stage when tar exits with 2", async () => {
    expect(stageOf((await backup({ failing: "tar", exitCode: 2 })).error)).toBe(
      "tar",
    );
  });
});

describe("runBackup when tar sees files change while it reads them", () => {
  test("still writes the generation", async () => {
    const outcome = await backup({
      failing: "tar",
      exitCode: 1,
      stderr: TAR_CHANGED,
    });
    expect(outcome.result?.generation).toBe(GENERATION);
  });

  test("logs a warning with the tar output", async () => {
    const outcome = await backup({
      failing: "tar",
      exitCode: 1,
      stderr: TAR_CHANGED,
    });
    expect(logged(outcome, "warn")).toContain("file changed as we read it");
  });
});

describe("runBackup with an unrelated invalid field in factory_config", () => {
  test("still writes the generation", async () => {
    const outcome = await backup({
      rawConfig: { ...RAW_CONFIG, max_turns: "many" },
    });
    expect(outcome.result?.generation).toBe(GENERATION);
  });
});

describe("runBackup with an invalid backup_keep_generations", () => {
  test("fails the job at the prune stage", async () => {
    const outcome = await backup({
      rawConfig: { ...RAW_CONFIG, backup_keep_generations: 0 },
    });
    expect(stageOf(outcome.error)).toBe("prune");
  });

  test("keeps the generation it wrote", async () => {
    const outcome = await backup({
      rawConfig: { ...RAW_CONFIG, backup_keep_generations: 0 },
    });
    expect(outcome.calls.renamed).toEqual([[PARTIAL, `${ROOT}/${GENERATION}`]]);
  });
});

describe("runBackup with a db_backup_url that is not a postgres URL", () => {
  test("fails the job at the prepare stage", async () => {
    expect(stageOf((await backup({ url: "mysql://u:p@db/x" })).error)).toBe(
      "prepare",
    );
  });

  test("runs no command", async () => {
    expect((await backup({ url: "mysql://u:p@db/x" })).calls.commands).toEqual(
      [],
    );
  });
});

describe("runBackup when the notice cannot be recorded", () => {
  test("still fails the job with the original stage", async () => {
    const outcome = await backup({ failing: "pg_dumpall", noticeFails: true });
    expect(stageOf(outcome.error)).toBe("pg_dumpall");
  });
});

describe("the backup script definition", () => {
  test("runs on the default worker", async () => {
    expect("tag" in (await yamlOf("f/factory/backup.script.yaml"))).toBe(false);
  });

  test("leaves headroom past the two thirty-minute commands", async () => {
    expect((await yamlOf("f/factory/backup.script.yaml")).timeout).toBe(3900);
  });
});
