import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FetcherDeps,
  type FetchLike,
  LIMITS,
  LOCK_STALE_MS,
  type LogFields,
  recordConfigFailure,
  rollback,
  runOnce,
  unpin,
  withLock,
} from "../../infra/console_fetcher/fetcher.ts";
import {
  artifactJson,
  buildRelease,
  FAKE_BLOB_HOST,
  fakeGitHub,
  workflowRun,
} from "./zip_fixture.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(40);
const SHA_E = "e".repeat(40);
const NOW = new Date("2026-10-08T00:00:00Z");
const CONFIG = { token: "test_token", owner: "o", repo: "r" };

function filesFor(label: string): Record<string, string> {
  return {
    "index.html": `<!doctype html><title>${label}</title>`,
    [`assets/index-${label}0000000.js`]: `console.log("${label}")`,
  };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "console-fetcher-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function deps(fetch: FetchLike, now: Date = NOW): FetcherDeps {
  return { fetch, now: () => now, root, config: CONFIG, log: () => {} };
}

function githubServing(sha: string, label: string, runId = 1) {
  const zip = buildRelease(sha, filesFor(label));
  return fakeGitHub({
    runs: [workflowRun(runId, sha)],
    artifacts: { [runId]: [artifactJson(100 + runId, sha, zip)] },
    blobs: { [100 + runId]: zip },
  });
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

async function deploy(
  sha: string,
  label: string,
  runId: number,
): Promise<void> {
  await runOnce(deps(githubServing(sha, label, runId).fetch));
}

/** 版Aと同じasset名(`assets/index-A0000000.js`)に、違う中身を入れた版Bを配る。 */
function conflictingGitHub() {
  const zip = buildRelease(SHA_B, {
    "index.html": "<!doctype html><title>B</title>",
    "assets/fresh-B0000000.js": 'console.log("fresh")',
    "assets/index-A0000000.js": 'console.log("changed")',
  });
  return fakeGitHub({
    runs: [workflowRun(2, SHA_B)],
    artifacts: { 2: [artifactJson(102, SHA_B, zip)] },
    blobs: { 102: zip },
  });
}

describe("runOnce", () => {
  test("points current at the new release with a relative link", async () => {
    await deploy(SHA_A, "A", 1);
    expect(await readlink(join(root, "current"))).toBe(`releases/${SHA_A}`);
  });

  test("reports ok with the deployed sha", async () => {
    const status = await runOnce(deps(githubServing(SHA_A, "A").fetch));
    expect(status).toEqual({
      state: "ok",
      sha: SHA_A,
      checked_at: NOW.toISOString(),
      error: null,
    });
  });

  test("writes the status to status.json", async () => {
    await deploy(SHA_A, "A", 1);
    expect(
      JSON.parse(await readFile(join(root, "status.json"), "utf8")),
    ).toEqual({
      state: "ok",
      sha: SHA_A,
      checked_at: NOW.toISOString(),
      error: null,
    });
  });

  test("places hashed assets in the shared assets directory", async () => {
    await deploy(SHA_A, "A", 1);
    expect(await readFile(join(root, "assets/index-A0000000.js"), "utf8")).toBe(
      'console.log("A")',
    );
  });

  test("records the deployed sha in history.json", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    expect(
      JSON.parse(await readFile(join(root, "history.json"), "utf8")),
    ).toEqual([SHA_A, SHA_B]);
  });

  test("does not send the token to the download host", async () => {
    const github = githubServing(SHA_A, "A");
    await runOnce(deps(github.fetch));
    expect(
      github.calls
        .filter((call) => new URL(call.url).hostname === FAKE_BLOB_HOST)
        .map((call) => call.authorization),
    ).toEqual([null]);
  });

  test("does not follow redirects from the download host", async () => {
    const github = githubServing(SHA_A, "A");
    const modes: (string | undefined)[] = [];
    const recording: FetchLike = async (url, init) => {
      if (new URL(url).hostname === FAKE_BLOB_HOST) modes.push(init?.redirect);
      return github.fetch(url, init);
    };
    await runOnce(deps(recording));
    expect(modes).toEqual(["error"]);
  });

  test("never logs the token", async () => {
    const logged: string[] = [];
    const github = githubServing(SHA_A, "A");
    await runOnce({
      ...deps(github.fetch),
      log: (event: string, fields?: LogFields) => {
        logged.push(JSON.stringify({ event, ...fields }));
      },
    });
    expect(logged.join("\n")).not.toContain(CONFIG.token);
  });

  test("only lists runs when current already serves the latest sha", async () => {
    const github = githubServing(SHA_A, "A");
    await runOnce(deps(github.fetch));
    github.calls.length = 0;
    await runOnce(deps(github.fetch));
    expect(github.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/repos/o/r/actions/workflows/ci.yml/runs",
    ]);
  });

  test("makes no request while pinned", async () => {
    await writeFile(join(root, "pin"), "{}");
    const github = githubServing(SHA_A, "A");
    await runOnce(deps(github.fetch));
    expect(github.calls).toEqual([]);
  });

  test("reports pinned while pinned", async () => {
    await writeFile(join(root, "pin"), "{}");
    const status = await runOnce(deps(githubServing(SHA_A, "A").fetch));
    expect(status.state).toBe("pinned");
  });

  test("does not switch current when a pin appears during the fetch", async () => {
    await deploy(SHA_A, "A", 1);
    const github = githubServing(SHA_B, "B", 2);
    const pinning: FetchLike = async (url, init) => {
      if (new URL(url).hostname === FAKE_BLOB_HOST) {
        await writeFile(join(root, "pin"), "{}");
      }
      return github.fetch(url, init);
    };
    await runOnce(deps(pinning));
    expect(await readlink(join(root, "current"))).toBe(`releases/${SHA_A}`);
  });

  test("rejects an archive whose digest does not match", async () => {
    const zip = buildRelease(SHA_A, filesFor("A"));
    const github = fakeGitHub({
      runs: [workflowRun(1, SHA_A)],
      artifacts: {
        1: [artifactJson(101, SHA_A, zip, `sha256:${"0".repeat(64)}`)],
      },
      blobs: { 101: zip },
    });
    const status = await runOnce(deps(github.fetch));
    expect(status.error).toBe("digest_mismatch");
  });

  test("stops a download larger than the limit even when the listed size is small", async () => {
    const zip = buildRelease(SHA_A, filesFor("A"));
    const github = fakeGitHub({
      runs: [workflowRun(1, SHA_A)],
      artifacts: { 1: [artifactJson(101, SHA_A, zip)] },
      blobs: { 101: new Uint8Array(LIMITS.maxArchiveBytes + 1) },
    });
    const status = await runOnce(deps(github.fetch));
    expect(status.error).toBe("artifact_too_large");
  });

  test("rejects a file that the manifest does not list", async () => {
    const zip = buildRelease(SHA_A, filesFor("A"), [
      { name: "assets/extra-00000000.js", data: "x" },
    ]);
    const github = fakeGitHub({
      runs: [workflowRun(1, SHA_A)],
      artifacts: { 1: [artifactJson(101, SHA_A, zip)] },
      blobs: { 101: zip },
    });
    const status = await runOnce(deps(github.fetch));
    expect(status.error).toBe("manifest_mismatch");
  });

  test("rejects an entry that escapes the release directory", async () => {
    const zip = buildRelease(SHA_A, filesFor("A"), [
      { name: "../escape.txt", data: "x" },
    ]);
    const github = fakeGitHub({
      runs: [workflowRun(1, SHA_A)],
      artifacts: { 1: [artifactJson(101, SHA_A, zip)] },
      blobs: { 101: zip },
    });
    const status = await runOnce(deps(github.fetch));
    expect(status.error).toBe("zip_unsafe_entry");
  });

  test("rejects a manifest built for another commit", async () => {
    const zip = buildRelease(SHA_B, filesFor("A"));
    const github = fakeGitHub({
      runs: [workflowRun(1, SHA_A)],
      artifacts: { 1: [artifactJson(101, SHA_A, zip)] },
      blobs: { 101: zip },
    });
    const status = await runOnce(deps(github.fetch));
    expect(status.error).toBe("manifest_mismatch");
  });

  test("writes nothing into releases when verification fails", async () => {
    const zip = buildRelease(SHA_B, filesFor("A"));
    const github = fakeGitHub({
      runs: [workflowRun(1, SHA_A)],
      artifacts: { 1: [artifactJson(101, SHA_A, zip)] },
      blobs: { 101: zip },
    });
    await runOnce(deps(github.fetch));
    expect(await readdir(join(root, "releases"))).toEqual([]);
  });

  test("keeps current when a newer release fails verification", async () => {
    await deploy(SHA_A, "A", 1);
    const zip = buildRelease(SHA_C, filesFor("B"));
    const github = fakeGitHub({
      runs: [workflowRun(2, SHA_B)],
      artifacts: { 2: [artifactJson(102, SHA_B, zip)] },
      blobs: { 102: zip },
    });
    await runOnce(deps(github.fetch));
    expect(await readlink(join(root, "current"))).toBe(`releases/${SHA_A}`);
  });

  test("fails with asset_conflict when a shared asset name has different content", async () => {
    await deploy(SHA_A, "A", 1);
    const status = await runOnce(deps(conflictingGitHub().fetch));
    expect(status.error).toBe("asset_conflict");
  });

  test("keeps current when a shared asset conflicts", async () => {
    await deploy(SHA_A, "A", 1);
    await runOnce(deps(conflictingGitHub().fetch));
    expect(await readlink(join(root, "current"))).toBe(`releases/${SHA_A}`);
  });

  test("does not overwrite the conflicting shared asset", async () => {
    await deploy(SHA_A, "A", 1);
    await runOnce(deps(conflictingGitHub().fetch));
    expect(await readFile(join(root, "assets/index-A0000000.js"), "utf8")).toBe(
      'console.log("A")',
    );
  });

  test("writes no shared asset when another asset of the release conflicts", async () => {
    await deploy(SHA_A, "A", 1);
    await runOnce(deps(conflictingGitHub().fetch));
    expect(await exists(join(root, "assets/fresh-B0000000.js"))).toBe(false);
  });

  test("does not create the release when a shared asset conflicts", async () => {
    await deploy(SHA_A, "A", 1);
    await runOnce(deps(conflictingGitHub().fetch));
    expect(await readdir(join(root, "releases"))).toEqual([SHA_A]);
  });

  test("reports auth_failed when GitHub rejects the token", async () => {
    const status = await runOnce(deps(fakeGitHub({ runsStatus: 401 }).fetch));
    expect(status.error).toBe("auth_failed");
  });

  test("writes only the classified failure to status.json", async () => {
    await runOnce(deps(fakeGitHub({ runsStatus: 401 }).fetch));
    expect(
      JSON.parse(await readFile(join(root, "status.json"), "utf8")),
    ).toEqual({
      state: "failed",
      sha: null,
      checked_at: NOW.toISOString(),
      error: "auth_failed",
    });
  });

  test("reports no_successful_run when no run qualifies", async () => {
    const status = await runOnce(deps(fakeGitHub({ runs: [] }).fetch));
    expect(status.error).toBe("no_successful_run");
  });

  test("refuses a redirect to an unexpected host", async () => {
    const zip = buildRelease(SHA_A, filesFor("A"));
    const github = fakeGitHub({
      runs: [workflowRun(1, SHA_A)],
      artifacts: { 1: [artifactJson(101, SHA_A, zip)] },
      blobs: { 101: zip },
      location: () => "https://evil.example.com/x.zip",
    });
    const status = await runOnce(deps(github.fetch));
    expect(status.error).toBe("unexpected_redirect");
  });

  test("reports github_unavailable when the network fails", async () => {
    const failing: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    const status = await runOnce(deps(failing));
    expect(status.error).toBe("github_unavailable");
  });

  test("keeps only the newest three releases", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "C", 3);
    await deploy(SHA_D, "D", 4);
    expect((await readdir(join(root, "releases"))).sort()).toEqual([
      SHA_B,
      SHA_C,
      SHA_D,
    ]);
  });

  test("does not follow a symlink in releases when cleaning up", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep.txt"), "keep");
    await deploy(SHA_A, "A", 1);
    await symlink(outside, join(root, "releases", SHA_E));
    await deploy(SHA_B, "B", 2);
    expect(await exists(join(outside, "keep.txt"))).toBe(true);
  });

  test("removes an unreferenced asset older than 14 days", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "C", 3);
    await deploy(SHA_D, "D", 4);
    const old = new Date(NOW.getTime() - 15 * 24 * 60 * 60 * 1000);
    await utimes(join(root, "assets/index-A0000000.js"), old, old);
    await runOnce(deps(githubServing(SHA_D, "D", 4).fetch));
    expect(await exists(join(root, "assets/index-A0000000.js"))).toBe(false);
  });

  test("keeps every asset when a kept release has no readable manifest", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "C", 3);
    await deploy(SHA_D, "D", 4);
    const old = new Date(NOW.getTime() - 15 * 24 * 60 * 60 * 1000);
    await utimes(join(root, "assets/index-A0000000.js"), old, old);
    await rm(join(root, "releases", SHA_C, "manifest.json"));
    await runOnce(deps(githubServing(SHA_D, "D", 4).fetch));
    expect(await exists(join(root, "assets/index-A0000000.js"))).toBe(true);
  });

  test("reuses an existing release without downloading it again", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    await unpin(root);
    const github = githubServing(SHA_B, "B", 2);
    await runOnce(deps(github.fetch));
    expect(github.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/repos/o/r/actions/workflows/ci.yml/runs",
    ]);
  });
});

describe("recordConfigFailure", () => {
  test("reports config_missing", async () => {
    const status = await recordConfigFailure(
      root,
      () => NOW,
      () => {},
    );
    expect(status.error).toBe("config_missing");
  });
});

describe("rollback", () => {
  test("switches current to the previous release", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    expect(await readlink(join(root, "current"))).toBe(`releases/${SHA_A}`);
  });

  test("creates the pin file", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    expect(await exists(join(root, "pin"))).toBe(true);
  });

  test("does not append to history", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    expect(
      JSON.parse(await readFile(join(root, "history.json"), "utf8")),
    ).toEqual([SHA_A, SHA_B]);
  });

  test("steps back one more release when run again", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "C", 3);
    await rollback(root, () => NOW);
    await rollback(root, () => NOW);
    expect(await readlink(join(root, "current"))).toBe(`releases/${SHA_A}`);
  });

  test("reports no_previous_release with a single release", async () => {
    await deploy(SHA_A, "A", 1);
    expect(await rollback(root, () => NOW)).toEqual({
      ok: false,
      reason: "no_previous_release",
    });
  });

  test("reports no_previous_release on an empty volume", async () => {
    expect(await rollback(root, () => NOW)).toEqual({
      ok: false,
      reason: "no_previous_release",
    });
  });
});

describe("unpin", () => {
  test("removes the pin file", async () => {
    await writeFile(join(root, "pin"), "{}");
    await unpin(root);
    expect(await exists(join(root, "pin"))).toBe(false);
  });

  test("does not append to history", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    await unpin(root);
    expect(
      JSON.parse(await readFile(join(root, "history.json"), "utf8")),
    ).toEqual([SHA_A, SHA_B]);
  });
});

describe("withLock", () => {
  test("runs the action while holding the lock", async () => {
    const result = await withLock(
      root,
      () => NOW,
      async () => "done",
    );
    expect(result).toEqual({ acquired: true, value: "done" });
  });

  test("refuses while another holder has a fresh lock", async () => {
    await writeFile(
      join(root, "lock"),
      JSON.stringify({ acquired_at: NOW.toISOString() }),
    );
    const result = await withLock(
      root,
      () => NOW,
      async () => "done",
    );
    expect(result).toEqual({ acquired: false });
  });

  test("keeps the lock of another holder when refusing", async () => {
    await writeFile(
      join(root, "lock"),
      JSON.stringify({ acquired_at: NOW.toISOString() }),
    );
    await withLock(
      root,
      () => NOW,
      async () => "done",
    );
    expect(await exists(join(root, "lock"))).toBe(true);
  });

  test("takes over a stale lock", async () => {
    const old = new Date(NOW.getTime() - LOCK_STALE_MS - 1000);
    await writeFile(
      join(root, "lock"),
      JSON.stringify({ acquired_at: old.toISOString() }),
    );
    const result = await withLock(
      root,
      () => NOW,
      async () => "done",
    );
    expect(result.acquired).toBe(true);
  });

  test("takes over a lock dated far in the future", async () => {
    const future = new Date(NOW.getTime() + LOCK_STALE_MS + 1000);
    await writeFile(
      join(root, "lock"),
      JSON.stringify({ acquired_at: future.toISOString() }),
    );
    const result = await withLock(
      root,
      () => NOW,
      async () => "done",
    );
    expect(result.acquired).toBe(true);
  });

  test("releases the lock even when the action throws", async () => {
    await withLock(
      root,
      () => NOW,
      async () => {
        throw new Error("boom");
      },
    ).catch(() => undefined);
    expect(await exists(join(root, "lock"))).toBe(false);
  });
});
