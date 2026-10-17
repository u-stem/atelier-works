import { describe, expect, test } from "bun:test";
import {
  classifyDryRuns,
  composeBaseArgs,
  DRYRUN_EXCLUDED_SERVICES,
  dryRunArgs,
  parseDryRun,
} from "../../scripts/host_apply/dryrun.ts";

// `docker compose up --dry-run`をパイプで受けたときの出力の形(Docker Compose v5.5.0で実測)。
// 各行は「先頭の空白、資源の種類、名前、状態、末尾の空白」で、`DRY-RUN MODE`の前置きは付かない。
// `Running`と`Recreate`の行は、同じ3列の形で、実測の表(収束済みはRunning、設定を変えたものはRecreate)に従う。
function lines(...rows: string[]): string {
  return `${rows.map((row) => ` ${row} `).join("\n")}\n`;
}

const RUNNING = lines("Container infra-db-1 Running");
const RECREATE = lines("Container infra-windmill_worker-1 Recreate");
const RECREATE_AND_START = lines(
  "Container infra-windmill_worker-1 Recreate",
  "Container infra-windmill_worker-1 Recreated",
  "Container infra-windmill_worker-1 Starting",
  "Container infra-windmill_worker-1 Started",
);
const CREATE_ONLY = lines(
  "Container infra-factory_state_init-1 Creating",
  "Container infra-factory_state_init-1 Created",
  "Container infra-factory_state_init-1 Starting",
  "Container infra-factory_state_init-1 Started",
);
const STOPPED = lines(
  "Container infra-windmill_worker_native-1 Recreate",
  "Container infra-windmill_worker_native-1 Starting",
);
const PULL_THEN_RECREATE = lines(
  "Image ghcr.io/windmill-labs/windmill:1.817.0 Pulling",
  "Image ghcr.io/windmill-labs/windmill:1.817.0 Pulled",
  "Container infra-windmill_worker_console-1 Recreate",
);
const NEW_NETWORK = lines(
  "Network infra_default Creating",
  "Network infra_default Created",
  "Container infra-db-1 Creating",
  "Container infra-db-1 Created",
  "Container infra-db-1 Starting",
  "Container infra-db-1 Started",
);

describe("composeBaseArgs and dryRunArgs", () => {
  const input = { stagingInfraDir: "/state/staging/abc/infra" };

  test("always sets the project name infra", () => {
    expect(composeBaseArgs(input).slice(0, 3)).toEqual([
      "compose",
      "-p",
      "infra",
    ]);
  });

  test("always sets the project directory to the staging infra directory", () => {
    const args = composeBaseArgs(input);
    expect(args[args.indexOf("--project-directory") + 1]).toBe(
      "/state/staging/abc/infra",
    );
  });

  test("points the compose file into the staging directory", () => {
    const args = composeBaseArgs(input);
    expect(args[args.indexOf("-f") + 1]).toBe(
      "/state/staging/abc/infra/docker-compose.yml",
    );
  });

  test("adds --pull never to the dry run", () => {
    expect(dryRunArgs(input, "windmill_worker").join(" ")).toContain(
      "--pull never",
    );
  });

  test("adds --no-build to the dry run", () => {
    expect(dryRunArgs(input, "windmill_worker")).toContain("--no-build");
  });

  test("adds --no-deps to the dry run", () => {
    expect(dryRunArgs(input, "windmill_worker")).toContain("--no-deps");
  });

  test("adds --dry-run and ends with the service name", () => {
    const args = dryRunArgs(input, "windmill_worker");
    expect([args.includes("--dry-run"), args[args.length - 1]]).toEqual([
      true,
      "windmill_worker",
    ]);
  });

  test("never builds the service name into a shell string", () => {
    expect(dryRunArgs(input, "a b; id")).toContain("a b; id");
  });
});

describe("parseDryRun", () => {
  test("reads a converged service as running", () => {
    expect(parseDryRun(RUNNING, "db")).toEqual({ kind: "running" });
  });

  test("reads Recreate as needing a recreate", () => {
    expect(parseDryRun(RECREATE, "windmill_worker").kind).toBe("recreate");
  });

  test("keeps the states it saw", () => {
    expect(parseDryRun(RECREATE_AND_START, "windmill_worker")).toEqual({
      kind: "recreate",
      states: ["Recreate", "Recreated", "Starting", "Started"],
    });
  });

  test("reads a service whose container is gone as needing a recreate", () => {
    expect(parseDryRun(CREATE_ONLY, "factory_state_init").kind).toBe(
      "recreate",
    );
  });

  test("reads a stopped service as needing a recreate", () => {
    expect(parseDryRun(STOPPED, "windmill_worker_native").kind).toBe(
      "recreate",
    );
  });

  test("ignores image lines", () => {
    expect(
      parseDryRun(PULL_THEN_RECREATE, "windmill_worker_console").kind,
    ).toBe("recreate");
  });

  test("ignores network lines for the service decision", () => {
    expect(parseDryRun(NEW_NETWORK, "db").kind).toBe("recreate");
  });

  test("fails on empty output", () => {
    expect(parseDryRun("", "db").kind).toBe("failed");
  });

  test("fails on output in a format it does not know", () => {
    expect(parseDryRun("DRY-RUN MODE - something changed\n", "db").kind).toBe(
      "failed",
    );
  });

  test("fails when a line has an unknown resource kind", () => {
    expect(parseDryRun(lines("Widget infra-db-1 Running"), "db").kind).toBe(
      "failed",
    );
  });

  test("fails when no container of the service appears", () => {
    expect(parseDryRun(RUNNING, "windmill_worker").kind).toBe("failed");
  });

  test("does not mix up a service whose name is a prefix of another", () => {
    expect(
      parseDryRun(
        lines("Container infra-windmill_worker_native-1 Recreate"),
        "windmill_worker",
      ).kind,
    ).toBe("failed");
  });

  test("fails on a warning mixed into the output", () => {
    const output = `time="x" level=warning msg="oops"\n${RUNNING}`;
    expect(parseDryRun(output, "db").kind).toBe("failed");
  });
});

describe("classifyDryRuns", () => {
  test("lists the services that need a recreate", () => {
    expect(
      classifyDryRuns({
        db: RUNNING,
        windmill_worker: RECREATE,
      }),
    ).toEqual({ recreate: ["windmill_worker"], failed: [] });
  });

  test("leaves factory_state_init out of the detection", () => {
    expect(
      classifyDryRuns({ db: RUNNING, factory_state_init: CREATE_ONLY })
        .recreate,
    ).toEqual([]);
  });

  test("leaves caddy out of the detection", () => {
    expect(
      classifyDryRuns({
        db: RUNNING,
        caddy: lines("Container infra-caddy-1 Recreate"),
      }).recreate,
    ).toEqual([]);
  });

  test("excludes exactly caddy and factory_state_init", () => {
    expect([...DRYRUN_EXCLUDED_SERVICES].sort()).toEqual([
      "caddy",
      "factory_state_init",
    ]);
  });

  test("reports a service whose output could not be read", () => {
    expect(classifyDryRuns({ db: "garbage\n" }).failed).toEqual(["db"]);
  });

  test("does not report an excluded service whose output could not be read", () => {
    expect(classifyDryRuns({ caddy: "garbage\n" }).failed).toEqual([]);
  });
});
