import { afterAll, describe, expect, test } from "bun:test";
import { isIssued } from "../../scripts/host_apply/command.ts";
import { COMMAND_TIMEOUT_MS } from "../../scripts/host_apply/constants.ts";
import { GIT_BIN } from "../../scripts/host_apply/exec_paths.ts";
import {
  approveGitEnv,
  diffNameStatusArgs,
  fetchArgs,
  resolveHeadArgs,
  showBlobArgs,
} from "../../scripts/host_apply/git.ts";
import { gitReadSpec } from "../../scripts/host_apply/run_git.ts";
import { createRunner } from "../../scripts/host_apply/spawn_runner.ts";
import {
  createFixtureRepo,
  type FixtureRepo,
} from "../fixtures/host_apply_repo.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("gitReadSpec", () => {
  const spec = gitReadSpec(showBlobArgs(SHA, "a"), { cwd: "/srv/repo" });

  test("is an issued specification", () => {
    expect(isIssued(spec)).toBe(true);
  });

  test("is the git_read kind", () => {
    expect(spec.kind).toBe("git_read");
  });

  test("runs the absolute path of git", () => {
    expect(spec.bin).toBe(GIT_BIN);
  });

  test("passes the arguments as they are", () => {
    expect([...spec.args]).toEqual(showBlobArgs(SHA, "a"));
  });

  test("uses the fixed git environment", () => {
    expect({ ...spec.env }).toEqual(approveGitEnv());
  });

  test("runs in the given directory", () => {
    expect(spec.cwd).toBe("/srv/repo");
  });

  test("takes the timeout from the table", () => {
    expect(spec.timeoutMs).toBe(COMMAND_TIMEOUT_MS.git_read);
  });

  test("defaults the output limit to 64 MiB", () => {
    expect(spec.maxStdoutBytes).toBe(64 * 1024 * 1024);
  });

  test("lowers the output limit when asked", () => {
    expect(
      gitReadSpec(showBlobArgs(SHA, "a"), { cwd: "/r", maxStdoutBytes: 100 })
        .maxStdoutBytes,
    ).toBe(100);
  });

  test("kills the process when the output is over the limit", () => {
    expect(spec.overflow).toBe("kill");
  });

  test("refuses a subcommand outside the grammar", () => {
    expect(() => gitReadSpec(["fetch", "origin"], { cwd: "/r" })).toThrow(
      "invalid command spec",
    );
  });

  test("refuses the arguments of a fetch", () => {
    expect(() =>
      gitReadSpec(fetchArgs("https://github.com/example/repo.git"), {
        cwd: "/r",
      }),
    ).toThrow("invalid command spec");
  });

  test("refuses a relative working directory", () => {
    expect(() => gitReadSpec(showBlobArgs(SHA, "a"), { cwd: "repo" })).toThrow(
      "invalid command spec",
    );
  });
});

describe("gitReadSpec against a real repository", () => {
  const repos: FixtureRepo[] = [];
  afterAll(() => {
    for (const repo of repos) repo.cleanup();
  });
  const run = createRunner();

  function setup() {
    const repo = createFixtureRepo();
    repos.push(repo);
    const base = repo.commit({ "a.txt": "one\n" }, "base");
    const target = repo.commit({ "a.txt": "two\n", "b.txt": "x\n" }, "next");
    return { repo, base, target };
  }

  test("resolves HEAD to the commit", async () => {
    const { repo, target } = setup();
    const result = await run(gitReadSpec(resolveHeadArgs(), { cwd: repo.dir }));
    expect(result).toMatchObject({
      kind: "done",
      code: 0,
      stdout: `${target}\n`,
    });
  });

  test("lists the files that changed between two commits", async () => {
    const { repo, base, target } = setup();
    const result = await run(
      gitReadSpec(diffNameStatusArgs(base, target), { cwd: repo.dir }),
    );
    expect(result).toMatchObject({ stdout: "M\0a.txt\0A\0b.txt\0" });
  });

  test("reads a blob of a commit", async () => {
    const { repo, target } = setup();
    const result = await run(
      gitReadSpec(showBlobArgs(target, "a.txt"), { cwd: repo.dir }),
    );
    expect(result).toMatchObject({ stdout: "two\n" });
  });

  test("returns a failing exit code as a result", async () => {
    const { repo } = setup();
    const result = await run(
      gitReadSpec(showBlobArgs("f".repeat(40), "a.txt"), { cwd: repo.dir }),
    );
    expect(result).toMatchObject({ kind: "done", code: 128 });
  });

  test("stops a read whose output is over the limit", async () => {
    const { repo, target } = setup();
    const result = await run(
      gitReadSpec(showBlobArgs(target, "a.txt"), {
        cwd: repo.dir,
        maxStdoutBytes: 3,
      }),
    );
    expect(result.kind).toBe("truncated");
  });

  test("passes output of exactly the limit", async () => {
    const { repo, target } = setup();
    const result = await run(
      gitReadSpec(showBlobArgs(target, "a.txt"), {
        cwd: repo.dir,
        maxStdoutBytes: 4,
      }),
    );
    expect(result).toMatchObject({ kind: "done", stdout: "two\n" });
  });
});
