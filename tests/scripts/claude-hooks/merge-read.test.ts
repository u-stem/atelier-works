import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildChildEnv,
  findMise,
  READ_TIMEOUT_MS,
  readDeployFreezes,
  readMergeHolds,
  rootOf,
  runChild,
} from "../../../scripts/claude-hooks/merge-read.ts";
import type {
  HoldPsqlRequest,
  HoldPsqlResult,
  HoldPsqlRun,
} from "../../../scripts/hold_psql.ts";

const ROOT = "/work/repo";
const MISE = "/opt/homebrew/bin/mise";

const NOW = new Date("2026-10-24T03:00:00.000Z");

function result(partial: Partial<HoldPsqlResult>): HoldPsqlResult {
  return {
    exitCode: 0,
    stdout: "[]\n",
    stderr: "",
    timedOut: false,
    ...partial,
  };
}

/** 起動の要求を記録し、決まった結果を返す実行役。 */
function recorder(reply: HoldPsqlResult | Error): {
  readonly run: HoldPsqlRun;
  readonly requests: HoldPsqlRequest[];
} {
  const requests: HoldPsqlRequest[] = [];
  return {
    requests,
    run: (request) => {
      requests.push(request);
      return reply instanceof Error
        ? Promise.reject(reply)
        : Promise.resolve(reply);
    },
  };
}

const HOLD_ROW = {
  id: 7,
  scope: "merge",
  target: "example/test-hold",
  reason: "check",
  holder_kind: "human",
  holder: "human",
  created_at: "2026-10-24T02:00:00.000Z",
  expires_at: "2026-10-24T04:00:00.000Z",
  released_at: null,
  released_by: null,
};

describe("readMergeHolds", () => {
  test("starts the child through mise exec in the repository root", async () => {
    const { run, requests } = recorder(result({}));

    await readMergeHolds({ root: ROOT, mise: MISE, run });

    expect(requests[0]?.argv.slice(0, 5)).toEqual([
      MISE,
      "exec",
      "-C",
      ROOT,
      "--",
    ]);
  });

  test("runs docker compose with the compose file of the root", async () => {
    const { run, requests } = recorder(result({}));

    await readMergeHolds({ root: ROOT, mise: MISE, run });

    expect(requests[0]?.argv.slice(5, 9)).toEqual([
      "docker",
      "compose",
      "-f",
      join(ROOT, "infra/docker-compose.yml"),
    ]);
  });

  test("connects to the datatable database", async () => {
    const { run, requests } = recorder(result({}));

    await readMergeHolds({ root: ROOT, mise: MISE, run });

    const argv = requests[0]?.argv ?? [];
    expect(argv[argv.indexOf("-d") + 1]).toBe("datatable_db");
  });

  test("connects read-only", async () => {
    const { run, requests } = recorder(result({}));

    await readMergeHolds({ root: ROOT, mise: MISE, run });

    expect(requests[0]?.argv.join(" ")).toContain(
      "default_transaction_read_only=on",
    );
  });

  test("limits the whole read to the read timeout", async () => {
    const { run, requests } = recorder(result({}));

    await readMergeHolds({ root: ROOT, mise: MISE, run });

    expect(requests[0]?.timeoutMs).toBe(READ_TIMEOUT_MS);
  });

  test("filters the statement to the merge scope", async () => {
    const { run, requests } = recorder(result({}));

    await readMergeHolds({ root: ROOT, mise: MISE, run });

    expect(requests[0]?.argv.join(" ")).toContain("=merge");
  });

  test("returns no holds for an empty array", async () => {
    const { run } = recorder(result({ stdout: "[]\n" }));

    const read = await readMergeHolds({ root: ROOT, mise: MISE, run });

    expect(read).toEqual({ ok: true, value: [] });
  });

  test("returns the rows of the active holds", async () => {
    const { run } = recorder(result({ stdout: JSON.stringify([HOLD_ROW]) }));

    const read = await readMergeHolds({ root: ROOT, mise: MISE, run });

    expect(read.ok && read.value.map((row) => row.target)).toEqual([
      "example/test-hold",
    ]);
  });

  test("fails when mise was not found", async () => {
    const { run } = recorder(result({}));

    const read = await readMergeHolds({ root: ROOT, mise: null, run });

    expect(read).toEqual({
      ok: false,
      kind: "read_failed",
      reason: expect.stringContaining("mise"),
    });
  });

  test("does not start a child when mise was not found", async () => {
    const { run, requests } = recorder(result({}));

    await readMergeHolds({ root: ROOT, mise: null, run });

    expect(requests).toEqual([]);
  });

  test("fails on a non-zero exit", async () => {
    const { run } = recorder(
      result({ exitCode: 1, stderr: "no such service" }),
    );

    const read = await readMergeHolds({ root: ROOT, mise: MISE, run });

    expect(read.ok === false && read.kind).toBe("read_failed");
  });

  test("fails on a timeout", async () => {
    const { run } = recorder(
      result({ exitCode: null, timedOut: true, stdout: "" }),
    );

    const read = await readMergeHolds({ root: ROOT, mise: MISE, run });

    expect(read.ok === false && read.reason).toContain("timed out");
  });

  test("fails on broken JSON", async () => {
    const { run } = recorder(result({ stdout: "not json" }));

    const read = await readMergeHolds({ root: ROOT, mise: MISE, run });

    expect(read.ok === false && read.kind).toBe("read_failed");
  });

  test("fails when the child cannot be started", async () => {
    const { run } = recorder(new Error("spawn mise ENOENT"));

    const read = await readMergeHolds({ root: ROOT, mise: MISE, run });

    expect(read.ok === false && read.reason).toContain("ENOENT");
  });

  test("reports a missing table as its own kind", async () => {
    const { run } = recorder(
      result({
        exitCode: 1,
        stderr: 'ERROR: relation "factory.holds" does not exist',
      }),
    );

    const read = await readMergeHolds({ root: ROOT, mise: MISE, run });

    expect(read.ok === false && read.kind).toBe("missing_table");
  });

  test("reports a malformed row as corrupt", async () => {
    const { run } = recorder(
      result({ stdout: JSON.stringify([{ ...HOLD_ROW, scope: "other" }]) }),
    );

    const read = await readMergeHolds({ root: ROOT, mise: MISE, run });

    expect(read.ok === false && read.kind).toBe("corrupt");
  });
});

function freezeJson(overrides: {
  readonly freezes?: unknown[];
  readonly deploy_freezes?: unknown[];
}): string {
  return JSON.stringify({
    version: 1,
    freezes: overrides.freezes ?? [],
    deploy_freezes: overrides.deploy_freezes ?? [],
  });
}

const DEPLOY_ENTRY = {
  id: "0123abcd",
  reason: "check",
  holder_kind: "human",
  holder: "human",
  created_at: "2026-10-24T02:30:00.000Z",
  expires_at: "2026-10-24T04:00:00.000Z",
  released_at: null,
};

const SCHEDULE_ENTRY = {
  ...DEPLOY_ENTRY,
  id: "89abcdef",
  target: "f/factory/poll_dependabot",
};

/** `wmill variable get`の出力(変数の値を包んだJSON)を返す実行役。 */
function variableReply(value: string): HoldPsqlResult {
  return result({ stdout: JSON.stringify({ value }) });
}

describe("readDeployFreezes", () => {
  test("reads the freeze variable through mise exec", async () => {
    const { run, requests } = recorder(variableReply(freezeJson({})));

    await readDeployFreezes({ root: ROOT, mise: MISE, run, now: () => NOW });

    expect(requests[0]?.argv).toEqual([
      MISE,
      "exec",
      "-C",
      ROOT,
      "--",
      "wmill",
      "variable",
      "get",
      "f/factory/freezes",
      "--json",
    ]);
  });

  test("returns nothing active for an empty state", async () => {
    const { run } = recorder(variableReply(freezeJson({})));

    const read = await readDeployFreezes({
      root: ROOT,
      mise: MISE,
      run,
      now: () => NOW,
    });

    expect(read).toEqual({ ok: true, deploy: [], schedule: 0 });
  });

  test("returns the id and the expiry of an active deploy freeze", async () => {
    const { run } = recorder(
      variableReply(freezeJson({ deploy_freezes: [DEPLOY_ENTRY] })),
    );

    const read = await readDeployFreezes({
      root: ROOT,
      mise: MISE,
      run,
      now: () => NOW,
    });

    expect(read.ok && read.deploy).toEqual([
      { id: "0123abcd", expires_at: "2026-10-24T04:00:00.000Z" },
    ]);
  });

  test("ignores a released deploy freeze", async () => {
    const released = {
      ...DEPLOY_ENTRY,
      released_at: "2026-10-24T02:45:00.000Z",
    };
    const { run } = recorder(
      variableReply(freezeJson({ deploy_freezes: [released] })),
    );

    const read = await readDeployFreezes({
      root: ROOT,
      mise: MISE,
      run,
      now: () => NOW,
    });

    expect(read.ok && read.deploy).toEqual([]);
  });

  test("ignores an expired deploy freeze", async () => {
    const expired = {
      ...DEPLOY_ENTRY,
      created_at: "2026-10-24T01:00:00.000Z",
      expires_at: "2026-10-24T02:00:00.000Z",
    };
    const { run } = recorder(
      variableReply(freezeJson({ deploy_freezes: [expired] })),
    );

    const read = await readDeployFreezes({
      root: ROOT,
      mise: MISE,
      run,
      now: () => NOW,
    });

    expect(read.ok && read.deploy).toEqual([]);
  });

  test("counts an active schedule freeze", async () => {
    const { run } = recorder(
      variableReply(freezeJson({ freezes: [SCHEDULE_ENTRY] })),
    );

    const read = await readDeployFreezes({
      root: ROOT,
      mise: MISE,
      run,
      now: () => NOW,
    });

    expect(read.ok && read.schedule).toBe(1);
  });

  test("fails on a variable that is not valid JSON", async () => {
    const { run } = recorder(variableReply("not json"));

    const read = await readDeployFreezes({
      root: ROOT,
      mise: MISE,
      run,
      now: () => NOW,
    });

    expect(read.ok === false && read.reason).toContain("not valid JSON");
  });

  test("fails when wmill cannot read the variable", async () => {
    const { run } = recorder(result({ exitCode: 1, stdout: "", stderr: "x" }));

    const read = await readDeployFreezes({
      root: ROOT,
      mise: MISE,
      run,
      now: () => NOW,
    });

    expect(read.ok).toBe(false);
  });

  test("fails when the child cannot be started", async () => {
    const { run } = recorder(new Error("spawn mise ENOENT"));

    const read = await readDeployFreezes({
      root: ROOT,
      mise: MISE,
      run,
      now: () => NOW,
    });

    expect(read.ok === false && read.reason).toContain("ENOENT");
  });

  test("fails on a timeout", async () => {
    const { run } = recorder(
      result({ exitCode: null, timedOut: true, stdout: "" }),
    );

    const read = await readDeployFreezes({
      root: ROOT,
      mise: MISE,
      run,
      now: () => NOW,
    });

    expect(read.ok === false && read.reason).toContain("timed out");
  });

  test("fails when mise was not found", async () => {
    const { run } = recorder(variableReply(freezeJson({})));

    const read = await readDeployFreezes({
      root: ROOT,
      mise: null,
      run,
      now: () => NOW,
    });

    expect(read.ok === false && read.reason).toContain("mise");
  });

  test("does not start a child when mise was not found", async () => {
    const { run, requests } = recorder(variableReply(freezeJson({})));

    await readDeployFreezes({ root: ROOT, mise: null, run, now: () => NOW });

    expect(requests).toEqual([]);
  });
});

describe("findMise", () => {
  const executable = (...paths: string[]) => {
    const set = new Set(paths);
    return (path: string) => set.has(path);
  };

  test("prefers mise on PATH", () => {
    expect(
      findMise({ PATH: "/a:/b", HOME: "/home/u" }, executable("/b/mise", MISE)),
    ).toBe("/b/mise");
  });

  test("falls back to the Homebrew location", () => {
    expect(findMise({ PATH: "/a", HOME: "/home/u" }, executable(MISE))).toBe(
      MISE,
    );
  });

  test("falls back to the local bin of the home directory", () => {
    expect(
      findMise(
        { PATH: "/a", HOME: "/home/u" },
        executable("/home/u/.local/bin/mise", "/usr/local/bin/mise"),
      ),
    ).toBe("/home/u/.local/bin/mise");
  });

  test("falls back to /usr/local/bin", () => {
    expect(
      findMise(
        { PATH: "", HOME: "/home/u" },
        executable("/usr/local/bin/mise"),
      ),
    ).toBe("/usr/local/bin/mise");
  });

  test("returns null when mise is nowhere", () => {
    expect(findMise({ PATH: "/a" }, executable())).toBeNull();
  });

  test("skips the home fallback without HOME", () => {
    expect(findMise({ PATH: "" }, executable("/.local/bin/mise"))).toBeNull();
  });
});

describe("buildChildEnv", () => {
  test("keeps the existing PATH first", () => {
    expect(buildChildEnv({ PATH: "/a:/b" }).PATH?.startsWith("/a:/b")).toBe(
      true,
    );
  });

  test.each([
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/Applications/Docker.app/Contents/Resources/bin",
  ])("adds %s to PATH", (dir) => {
    expect(buildChildEnv({ PATH: "/a" }).PATH?.split(":")).toContain(dir);
  });

  test("builds a PATH even when there is none", () => {
    expect(buildChildEnv({}).PATH?.split(":")).toContain("/usr/local/bin");
  });

  test("does not repeat a directory that PATH already has", () => {
    const parts = buildChildEnv({ PATH: "/usr/local/bin" }).PATH?.split(":");
    expect(parts?.filter((dir) => dir === "/usr/local/bin")).toHaveLength(1);
  });

  test.each([
    "MISE_AUTO_INSTALL",
    "MISE_EXEC_AUTO_INSTALL",
    "MISE_NOT_FOUND_AUTO_INSTALL",
    "MISE_TASK_RUN_AUTO_INSTALL",
  ])("turns off %s so that the read never installs a tool", (name) => {
    expect(buildChildEnv({ [name]: "1" })[name]).toBe("0");
  });

  test("keeps other variables", () => {
    expect(buildChildEnv({ HOME: "/home/u" }).HOME).toBe("/home/u");
  });
});

describe("rootOf", () => {
  test("returns the repository root from the URL of a hook module", () => {
    const url = pathToFileURL(
      join(ROOT, "scripts/claude-hooks/merge-read.ts"),
    ).href;
    expect(rootOf(url)).toBe(ROOT);
  });
});

describe("runChild", () => {
  test("passes the standard input to the child", async () => {
    const finished = await runChild({
      argv: ["/bin/cat"],
      stdin: "hello",
      timeoutMs: 5000,
    });
    expect(finished.stdout).toBe("hello");
  });

  test("returns the exit code", async () => {
    const finished = await runChild({
      argv: ["/bin/sh", "-c", "exit 3"],
      stdin: "",
      timeoutMs: 5000,
    });
    expect(finished.exitCode).toBe(3);
  });

  test("returns the standard error", async () => {
    const finished = await runChild({
      argv: ["/bin/sh", "-c", "echo oops >&2"],
      stdin: "",
      timeoutMs: 5000,
    });
    expect(finished.stderr).toBe("oops\n");
  });

  test("masks a token in the standard error", async () => {
    const token = `ghp_${"a".repeat(30)}`;
    const finished = await runChild({
      argv: ["/bin/sh", "-c", `echo ${token} >&2`],
      stdin: "",
      timeoutMs: 5000,
    });
    expect(finished.stderr).not.toContain(token);
  });

  test("rejects when the program does not exist", async () => {
    await expect(
      runChild({ argv: ["/nonexistent/program"], stdin: "", timeoutMs: 5000 }),
    ).rejects.toThrow(/ENOENT/);
  });

  test("runs in the given directory", async () => {
    const finished = await runChild({
      argv: ["/bin/pwd"],
      stdin: "",
      timeoutMs: 5000,
      cwd: "/",
    });
    expect(finished.stdout).toBe("/\n");
  });

  test("uses the given environment", async () => {
    const finished = await runChild({
      argv: ["/usr/bin/env"],
      stdin: "",
      timeoutMs: 5000,
      env: { ONLY_THIS: "1" },
    });
    expect(finished.stdout).toBe("ONLY_THIS=1\n");
  });

  test("reports a timeout", async () => {
    const finished = await runChild({
      argv: ["/bin/sleep", "30"],
      stdin: "",
      timeoutMs: 200,
    });
    expect(finished).toMatchObject({ timedOut: true, exitCode: null });
  });

  test("returns soon after a timeout even if a grandchild holds the output open", async () => {
    const started = Date.now();
    await runChild({
      argv: ["/bin/sh", "-c", "sleep 30 & wait"],
      stdin: "",
      timeoutMs: 300,
    });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("kills the grandchild at a timeout", async () => {
    const finished = await runChild({
      argv: ["/bin/sh", "-c", "sleep 31 & echo $!; wait"],
      stdin: "",
      timeoutMs: 400,
    });
    const pid = Number(finished.stdout.trim());
    await Bun.sleep(300);
    expect(isAlive(pid)).toBe(false);
  });

  test("returns when the child exits even if a grandchild holds the output open", async () => {
    const started = Date.now();
    const finished = await runChild({
      argv: ["/bin/sh", "-c", "sleep 32 & echo done"],
      stdin: "",
      timeoutMs: 5000,
    });
    expect({
      stdout: finished.stdout,
      exitCode: finished.exitCode,
      quick: Date.now() - started < 3000,
    }).toEqual({ stdout: "done\n", exitCode: 0, quick: true });
  });

  test("kills a grandchild that outlives the child", async () => {
    const finished = await runChild({
      argv: ["/bin/sh", "-c", "sleep 33 & echo $!"],
      stdin: "",
      timeoutMs: 5000,
    });
    const pid = Number(finished.stdout.trim());
    await Bun.sleep(300);
    expect(isAlive(pid)).toBe(false);
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
