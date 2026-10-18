import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommandResult,
  type CommandRunner,
  type IssuedSpec,
  isIssued,
} from "../../scripts/host_apply/command.ts";
import { COMMAND_TIMEOUT_MS } from "../../scripts/host_apply/constants.ts";
import { GIT_BIN } from "../../scripts/host_apply/exec_paths.ts";
import { approveGitEnv, fetchArgs } from "../../scripts/host_apply/git.ts";
import { REMOTE_URL_ARGS } from "../../scripts/host_apply/git_grammar.ts";
import {
  fetchOrigin,
  remoteUrlSpec,
} from "../../scripts/host_apply/run_fetch.ts";
import { createRunner } from "../../scripts/host_apply/spawn_runner.ts";
import { fixtureGitEnv } from "../fixtures/host_apply_repo.ts";

const REPO_GIT = "/var/host/repo.git";
const URL = "https://github.com/example/repo.git";
const TOKEN = "ghs_secrettoken123";

function done(stdout: string, code = 0): CommandResult {
  return {
    kind: "done",
    code,
    stdout,
    stderr: "remote: noisy output",
    stdoutDropped: false,
    stderrDropped: false,
  };
}

/** 呼ばれた指定を記録し、用意した結果を順に返す実行口。 */
function scripted(...results: CommandResult[]) {
  const calls: { spec: IssuedSpec; signal: AbortSignal | undefined }[] = [];
  const run: CommandRunner = async (spec, opts) => {
    calls.push({ spec, signal: opts?.signal });
    const result = results[calls.length - 1];
    if (result === undefined) throw new Error("unexpected call");
    return result;
  };
  return { calls, run };
}

function input(overrides: Partial<Parameters<typeof fetchOrigin>[1]> = {}) {
  return { repoGit: REPO_GIT, recordedUrl: URL, token: null, ...overrides };
}

describe("remoteUrlSpec", () => {
  const spec = remoteUrlSpec(REPO_GIT);

  test("is an issued specification", () => {
    expect(isIssued(spec)).toBe(true);
  });

  test("is the git_fetch kind", () => {
    expect(spec.kind).toBe("git_fetch");
  });

  test("runs the absolute path of git", () => {
    expect(spec.bin).toBe(GIT_BIN);
  });

  test("reads only remote.origin.url from the repository config", () => {
    expect([...spec.args]).toEqual([...REMOTE_URL_ARGS]);
  });

  test("points git at the repository and runs there", () => {
    expect([spec.cwd, spec.env.GIT_DIR]).toEqual([REPO_GIT, REPO_GIT]);
  });

  test("uses the fixed git environment besides GIT_DIR", () => {
    expect({ ...spec.env }).toEqual({ ...approveGitEnv(), GIT_DIR: REPO_GIT });
  });

  test("takes the timeout of a fetch", () => {
    expect(spec.timeoutMs).toBe(COMMAND_TIMEOUT_MS.git_fetch);
  });

  test("keeps at most 64 KiB of output", () => {
    expect(spec.maxStdoutBytes).toBe(64 * 1024);
  });

  test("refuses a relative repository path", () => {
    expect(() => remoteUrlSpec("repo.git")).toThrow("invalid command spec");
  });
});

describe("fetchOrigin when the url matches", () => {
  test("reports that it fetched", async () => {
    const s = scripted(done(`${URL}\n`), done(""));
    expect(await fetchOrigin(s.run, input())).toEqual({ kind: "fetched" });
  });

  test("reads the remote url first", async () => {
    const s = scripted(done(`${URL}\n`), done(""));
    await fetchOrigin(s.run, input());
    expect([...(s.calls[0]?.spec.args ?? [])]).toEqual([...REMOTE_URL_ARGS]);
  });

  test("then fetches from the recorded url, not from a remote name", async () => {
    const s = scripted(done(`${URL}\n`), done(""));
    await fetchOrigin(s.run, input());
    expect([...(s.calls[1]?.spec.args ?? [])]).toEqual(fetchArgs(URL));
  });

  test("runs the fetch in the repository", async () => {
    const s = scripted(done(`${URL}\n`), done(""));
    await fetchOrigin(s.run, input());
    expect(s.calls[1]?.spec.cwd).toBe(REPO_GIT);
  });

  test("points the fetch at the repository with GIT_DIR", async () => {
    const s = scripted(done(`${URL}\n`), done(""));
    await fetchOrigin(s.run, input());
    expect(s.calls[1]?.spec.env.GIT_DIR).toBe(REPO_GIT);
  });

  test("allows only https for the fetch", async () => {
    const s = scripted(done(`${URL}\n`), done(""));
    await fetchOrigin(s.run, input());
    expect(s.calls[1]?.spec.args).toContain("protocol.allow=never");
  });

  test("never puts the token in the arguments", async () => {
    const s = scripted(done(`${URL}\n`), done(""));
    await fetchOrigin(s.run, input({ token: TOKEN }));
    expect(
      JSON.stringify(s.calls.map((call) => [...call.spec.args])),
    ).not.toContain(TOKEN);
  });

  test("passes the token in the environment of the fetch", async () => {
    const s = scripted(done(`${URL}\n`), done(""));
    await fetchOrigin(s.run, input({ token: TOKEN }));
    expect(s.calls[1]?.spec.env.GIT_CONFIG_VALUE_0).toBe(
      `Authorization: Basic ${btoa(`x-access-token:${TOKEN}`)}`,
    );
  });

  test("does not pass the token to the read of the url", async () => {
    const s = scripted(done(`${URL}\n`), done(""));
    await fetchOrigin(s.run, input({ token: TOKEN }));
    expect("GIT_CONFIG_COUNT" in (s.calls[0]?.spec.env ?? {})).toBe(false);
  });

  test("sets no credentials without a token", async () => {
    const s = scripted(done(`${URL}\n`), done(""));
    await fetchOrigin(s.run, input());
    expect("GIT_CONFIG_COUNT" in (s.calls[1]?.spec.env ?? {})).toBe(false);
  });

  test("accepts an output without the trailing newline", async () => {
    const s = scripted(done(URL), done(""));
    expect(await fetchOrigin(s.run, input())).toEqual({ kind: "fetched" });
  });

  test("passes the abort signal to both commands", async () => {
    const controller = new AbortController();
    const s = scripted(done(`${URL}\n`), done(""));
    await fetchOrigin(s.run, input(), { signal: controller.signal });
    expect(s.calls.map((call) => call.signal)).toEqual([
      controller.signal,
      controller.signal,
    ]);
  });
});

describe("fetchOrigin when the url does not match", () => {
  test("reports a mismatch for another url", async () => {
    const s = scripted(done("https://github.com/someone/else.git\n"));
    expect(await fetchOrigin(s.run, input())).toEqual({
      kind: "url_mismatch",
    });
  });

  test("does not fetch after a mismatch", async () => {
    const s = scripted(done("https://github.com/someone/else.git\n"));
    await fetchOrigin(s.run, input());
    expect(s.calls.length).toBe(1);
  });

  test("reports a mismatch when only the .git suffix differs", async () => {
    const s = scripted(done("https://github.com/example/repo\n"));
    expect(await fetchOrigin(s.run, input())).toEqual({
      kind: "url_mismatch",
    });
  });

  test("reports a mismatch for a url that is not github https", async () => {
    const s = scripted(done("git@github.com:example/repo.git\n"));
    expect(
      await fetchOrigin(
        s.run,
        input({ recordedUrl: "git@github.com:example/repo.git" }),
      ),
    ).toEqual({ kind: "url_mismatch" });
  });

  test("runs nothing when the recorded url is not github https", async () => {
    const s = scripted(done("x\n"));
    await fetchOrigin(s.run, input({ recordedUrl: "http://github.com/a/b" }));
    expect(s.calls.length).toBe(0);
  });

  test("runs nothing when the recorded url is empty", async () => {
    const s = scripted(done("\n"));
    await fetchOrigin(s.run, input({ recordedUrl: "" }));
    expect(s.calls.length).toBe(0);
  });

  test("reports a mismatch when the config has two urls", async () => {
    const s = scripted(done(`${URL}\n${URL}\n`));
    expect(await fetchOrigin(s.run, input())).toEqual({
      kind: "url_mismatch",
    });
  });

  test("reports a mismatch when the config has no url", async () => {
    const s = scripted(done(""));
    expect(await fetchOrigin(s.run, input())).toEqual({
      kind: "url_mismatch",
    });
  });

  test("reports a mismatch when the output was cut", async () => {
    const s = scripted({
      kind: "done",
      code: 0,
      stdout: `${URL}\n`,
      stderr: "",
      stdoutDropped: true,
      stderrDropped: false,
    });
    expect(await fetchOrigin(s.run, input())).toEqual({
      kind: "url_mismatch",
    });
  });
});

describe("fetchOrigin when a command fails", () => {
  test("returns only the exit code of a failed fetch", async () => {
    const s = scripted(done(`${URL}\n`), done("fatal: secret detail", 128));
    expect(await fetchOrigin(s.run, input())).toEqual({
      kind: "failed",
      code: 128,
    });
  });

  test("returns no exit code for a fetch that was cut short", async () => {
    const s = scripted(done(`${URL}\n`), {
      kind: "truncated",
      stderr: "",
      stderrDropped: false,
    });
    expect(await fetchOrigin(s.run, input())).toEqual({
      kind: "failed",
      code: null,
    });
  });

  test("returns the exit code when the config cannot be read", async () => {
    const s = scripted(done("", 1));
    expect(await fetchOrigin(s.run, input())).toEqual({
      kind: "failed",
      code: 1,
    });
  });

  test("does not fetch when the config cannot be read", async () => {
    const s = scripted(done("", 1));
    await fetchOrigin(s.run, input());
    expect(s.calls.length).toBe(1);
  });

  test("lets an error of the runner through", async () => {
    const run: CommandRunner = async () => {
      throw new Error("runner failed");
    };
    await expect(fetchOrigin(run, input())).rejects.toThrow("runner failed");
  });
});

describe("remoteUrlSpec against a real bare repository", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function bare(url: string | null): string {
    const root = mkdtempSync(join(tmpdir(), "host-apply-bare-"));
    dirs.push(root);
    const dir = join(root, "repo.git");
    const env = fixtureGitEnv(root);
    Bun.spawnSync(["git", "init", "-q", "--bare", dir], { env });
    if (url !== null) {
      Bun.spawnSync(["git", "config", "remote.origin.url", url], {
        cwd: dir,
        env,
      });
    }
    return dir;
  }

  test("reads the url of the origin remote", async () => {
    const dir = bare(URL);
    const result = await createRunner()(remoteUrlSpec(dir));
    expect(result).toMatchObject({ kind: "done", code: 0, stdout: `${URL}\n` });
  });

  test("exits with 1 when the remote has no url", async () => {
    const dir = bare(null);
    const result = await createRunner()(remoteUrlSpec(dir));
    expect(result).toMatchObject({ kind: "done", code: 1, stdout: "" });
  });
});
