import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
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
  contentDigest,
  parseManifest,
} from "../../infra/console_fetcher/decide.ts";
import {
  type FetcherDeps,
  type FetchLike,
  LIMITS,
  LOCK_STALE_MS,
  type LogFields,
  recordConfigFailure,
  rollback,
  runLoopIteration,
  runOnce,
  type UnpinDeps,
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

function unpinDeps(
  fetch: FetchLike,
  config: UnpinDeps["config"] = CONFIG,
): UnpinDeps {
  return { fetch, now: () => NOW, root, config, log: () => {} };
}

const failingFetch: FetchLike = async () => {
  throw new Error("network down");
};

/** 実行の一覧だけを返し、成果物は配らないGitHub。 */
function githubWithLatestRun(sha: string, runId: number) {
  return fakeGitHub({ runs: [workflowRun(runId, sha)] });
}

/** `current`を`sha`の版に向け、`revoked`を記録したpinを置く。`revoked`が無ければ旧形式のpinにする。 */
async function pinAt(
  sha: string,
  revoked?: string[],
  content?: string[],
): Promise<void> {
  await rm(join(root, "current"), { recursive: true, force: true });
  await symlink(`releases/${sha}`, join(root, "current"));
  await writeFile(
    join(root, "pin"),
    `${JSON.stringify({ sha, pinned_at: NOW.toISOString(), ...(revoked === undefined ? {} : { rolled_back_from: revoked }), ...(content === undefined ? {} : { rolled_back_content: content }) })}\n`,
  );
}

/** `releases/<sha>`の中身(`files`)のsha256を返す。 */
async function digestOfRelease(sha: string): Promise<string> {
  const manifest = parseManifest(
    JSON.parse(
      await readFile(join(root, "releases", sha, "manifest.json"), "utf8"),
    ),
  );
  if (manifest === null) throw new Error("manifest is unreadable");
  return contentDigest(manifest);
}

/** `releases/<sha>`を本物のディレクトリでなくし、`switchCurrent`が拒む状態にする。 */
async function brokenRelease(sha: string): Promise<void> {
  const outside = join(root, `outside-${sha.slice(0, 4)}`);
  await mkdir(outside, { recursive: true });
  await rm(join(root, "releases", sha), { recursive: true, force: true });
  await symlink(outside, join(root, "releases", sha));
}

/** 管理者(root)は書き込みの権限の制限を受けないので、権限で失敗を起こすテストは飛ばす。 */
const itFailsOnPermission = process.getuid?.() === 0 ? test.skip : test;

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

  test("reports the switched sha when recording history fails", async () => {
    // history.jsonをディレクトリにして、読み込みを失敗させる。
    await mkdir(join(root, "history.json"));
    const status = await runOnce(deps(githubServing(SHA_A, "A").fetch));
    expect(status.sha).toBe(SHA_A);
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
    await rm(join(root, "current"));
    await symlink(`releases/${SHA_A}`, join(root, "current"));
    const github = githubServing(SHA_B, "B", 2);
    await runOnce(deps(github.fetch));
    expect(github.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/repos/o/r/actions/workflows/ci.yml/runs",
    ]);
  });

  test("removes a release left behind by the pin while pinned", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rm(join(root, "current"));
    await symlink(`releases/${SHA_A}`, join(root, "current"));
    await writeFile(
      join(root, "pin"),
      `${JSON.stringify({ sha: SHA_A, pinned_at: NOW.toISOString(), rolled_back_from: [SHA_B] })}\n`,
    );
    await runOnce(deps(githubServing(SHA_B, "B", 2).fetch));
    expect(await exists(join(root, "releases", SHA_B))).toBe(false);
  });

  test("keeps an older version after unrelated merges produce identical releases", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "B", 3);
    await deploy(SHA_D, "B", 4);
    await deploy(SHA_E, "B", 5);
    expect(await exists(join(root, "releases", SHA_A))).toBe(true);
  });

  test("refetches an existing release whose assets are missing", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rm(join(root, "current"));
    await symlink(`releases/${SHA_A}`, join(root, "current"));
    await rm(join(root, "assets/index-B0000000.js"));
    await runOnce(deps(githubServing(SHA_B, "B", 2).fetch));
    expect(await exists(join(root, "assets/index-B0000000.js"))).toBe(true);
  });
});

describe("runOnce with a pin", () => {
  test("removes the assets used only by a revoked release", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await pinAt(SHA_A, [SHA_B]);
    await runOnce(deps(githubServing(SHA_B, "B", 2).fetch));
    expect(await exists(join(root, "assets/index-B0000000.js"))).toBe(false);
  });

  test("stays pinned after removing a revoked release", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await pinAt(SHA_A, [SHA_B]);
    const status = await runOnce(deps(githubServing(SHA_B, "B", 2).fetch));
    expect(status.state).toBe("pinned");
  });

  test("keeps a revoked release when current cannot be read", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await pinAt(SHA_A, [SHA_B]);
    await rm(join(root, "current"));
    await mkdir(join(root, "current"));
    await runOnce(deps(githubServing(SHA_B, "B", 2).fetch));
    expect(await exists(join(root, "releases", SHA_B))).toBe(true);
  });

  test("keeps the live release when rolled_back_from names it", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await pinAt(SHA_A, [SHA_A]);
    await runOnce(deps(githubServing(SHA_B, "B", 2).fetch));
    expect(await exists(join(root, "releases", SHA_A))).toBe(true);
  });

  test("keeps every release when the pin has no rolled_back_from", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await pinAt(SHA_A);
    await runOnce(deps(githubServing(SHA_B, "B", 2).fetch));
    expect((await readdir(join(root, "releases"))).sort()).toEqual([
      SHA_A,
      SHA_B,
    ]);
  });

  test("keeps the revoked assets when the manifest of current cannot be read", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await pinAt(SHA_A, [SHA_B]);
    await rm(join(root, "releases", SHA_A, "manifest.json"));
    await runOnce(deps(githubServing(SHA_B, "B", 2).fetch));
    expect(await exists(join(root, "assets/index-B0000000.js"))).toBe(true);
  });

  test("keeps the revoked release when the manifest of current cannot be read", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await pinAt(SHA_A, [SHA_B]);
    await rm(join(root, "releases", SHA_A, "manifest.json"));
    await runOnce(deps(githubServing(SHA_B, "B", 2).fetch));
    expect(await exists(join(root, "releases", SHA_B))).toBe(true);
  });

  test("keeps the revoked release when its own manifest cannot be read", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await pinAt(SHA_A, [SHA_B]);
    await rm(join(root, "releases", SHA_B, "manifest.json"));
    await runOnce(deps(githubServing(SHA_B, "B", 2).fetch));
    expect(await exists(join(root, "releases", SHA_B))).toBe(true);
  });

  test("logs a warning when the assets to remove cannot be determined", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await pinAt(SHA_A, [SHA_B]);
    await rm(join(root, "releases", SHA_A, "manifest.json"));
    const events: string[] = [];
    await runOnce({
      ...deps(githubServing(SHA_B, "B", 2).fetch),
      log: (event) => events.push(event),
    });
    expect(events).toContain("revoked_cleanup_skipped");
  });

  test("removes the revoked assets even when another remaining manifest cannot be read", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "C", 3);
    await pinAt(SHA_A, [SHA_C]);
    await rm(join(root, "releases", SHA_B, "manifest.json"));
    await runOnce(deps(githubServing(SHA_C, "C", 3).fetch));
    expect(await exists(join(root, "assets/index-C0000000.js"))).toBe(false);
  });

  test("keeps the assets of another remaining release whose manifest can be read", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "C", 3);
    await pinAt(SHA_A, [SHA_C]);
    await rm(join(root, "releases", SHA_B, "manifest.json"));
    await runOnce(deps(githubServing(SHA_C, "C", 3).fetch));
    expect(await exists(join(root, "assets/index-A0000000.js"))).toBe(true);
  });

  test("logs a warning when the manifest of the revoked release cannot be read", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await pinAt(SHA_A, [SHA_B]);
    await rm(join(root, "releases", SHA_B, "manifest.json"));
    const events: string[] = [];
    await runOnce({
      ...deps(githubServing(SHA_B, "B", 2).fetch),
      log: (event) => events.push(event),
    });
    expect(events).toContain("revoked_cleanup_skipped");
  });

  test("does not switch to a release whose asset is not a regular file", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rm(join(root, "current"));
    await symlink(`releases/${SHA_A}`, join(root, "current"));
    const outside = join(root, "outside.js");
    await writeFile(outside, 'console.log("B")');
    await rm(join(root, "assets/index-B0000000.js"));
    await symlink(outside, join(root, "assets/index-B0000000.js"));
    await runOnce(deps(githubServing(SHA_B, "B", 2).fetch));
    expect(await readlink(join(root, "current"))).toBe(`releases/${SHA_A}`);
  });

  test("does not remove an asset that is not a regular file", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await pinAt(SHA_A, [SHA_B]);
    const outside = join(root, "outside.js");
    await writeFile(outside, "outside");
    await rm(join(root, "assets/index-B0000000.js"));
    await symlink(outside, join(root, "assets/index-B0000000.js"));
    await runOnce(deps(githubServing(SHA_B, "B", 2).fetch));
    expect(
      (await lstat(join(root, "assets/index-B0000000.js"))).isSymbolicLink(),
    ).toBe(true);
  });

  itFailsOnPermission(
    "stays pinned when removing a revoked release fails",
    async () => {
      await deploy(SHA_A, "A", 1);
      await deploy(SHA_B, "B", 2);
      await pinAt(SHA_A, [SHA_B]);
      await chmod(join(root, "releases"), 0o555);
      try {
        const status = await runOnce(deps(githubServing(SHA_B, "B", 2).fetch));
        expect(status.state).toBe("pinned");
      } finally {
        await chmod(join(root, "releases"), 0o755);
      }
    },
  );

  itFailsOnPermission(
    "logs a failure when removing a revoked release fails",
    async () => {
      await deploy(SHA_A, "A", 1);
      await deploy(SHA_B, "B", 2);
      await pinAt(SHA_A, [SHA_B]);
      await chmod(join(root, "releases"), 0o555);
      const events: string[] = [];
      try {
        await runOnce({
          ...deps(githubServing(SHA_B, "B", 2).fetch),
          log: (event) => events.push(event),
        });
      } finally {
        await chmod(join(root, "releases"), 0o755);
      }
      expect(events).toContain("revoked_cleanup_failed");
    },
  );
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

  test("switches to the newest recorded release when current is missing from history", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await writeFile(join(root, "history.json"), `${JSON.stringify([SHA_A])}\n`);
    await rollback(root, () => NOW);
    expect(await readlink(join(root, "current"))).toBe(`releases/${SHA_A}`);
  });

  test("skips a release whose content is identical to current", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "B", 3);
    await rollback(root, () => NOW);
    expect(await readlink(join(root, "current"))).toBe(`releases/${SHA_A}`);
  });

  test("reports no_previous_release when every earlier release has the same content", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "A", 2);
    expect(await rollback(root, () => NOW)).toEqual({
      ok: false,
      reason: "no_previous_release",
    });
  });

  test("keeps current when no release with different content exists", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "A", 2);
    await rollback(root, () => NOW);
    expect(await readlink(join(root, "current"))).toBe(`releases/${SHA_B}`);
  });

  test("removes the release it rolled back from", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    expect(await readdir(join(root, "releases"))).toEqual([SHA_A]);
  });

  test("removes releases with the same content as the one it rolled back from", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "B", 3);
    await rollback(root, () => NOW);
    expect(await readdir(join(root, "releases"))).toEqual([SHA_A]);
  });

  test("removes the assets used only by the release it rolled back from", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    expect(await exists(join(root, "assets/index-B0000000.js"))).toBe(false);
  });

  test("keeps the assets of the release it rolled back to", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    expect(await exists(join(root, "assets/index-A0000000.js"))).toBe(true);
  });

  test("keeps an asset that the release it rolled back to also uses", async () => {
    const shared = { "assets/shared-00000000.js": "shared" };
    const zipA = buildRelease(SHA_A, { ...filesFor("A"), ...shared });
    const zipB = buildRelease(SHA_B, { ...filesFor("B"), ...shared });
    await runOnce(
      deps(
        fakeGitHub({
          runs: [workflowRun(1, SHA_A)],
          artifacts: { 1: [artifactJson(101, SHA_A, zipA)] },
          blobs: { 101: zipA },
        }).fetch,
      ),
    );
    await runOnce(
      deps(
        fakeGitHub({
          runs: [workflowRun(2, SHA_B)],
          artifacts: { 2: [artifactJson(102, SHA_B, zipB)] },
          blobs: { 102: zipB },
        }).fetch,
      ),
    );
    await rollback(root, () => NOW);
    expect(await exists(join(root, "assets/shared-00000000.js"))).toBe(true);
  });

  test("records the release it rolled back from in the pin", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    expect(
      JSON.parse(await readFile(join(root, "pin"), "utf8")).rolled_back_from,
    ).toEqual([SHA_B]);
  });

  test("keeps the releases it rolled back from earlier in the pin", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "C", 3);
    await rollback(root, () => NOW);
    await rollback(root, () => NOW);
    expect(
      JSON.parse(await readFile(join(root, "pin"), "utf8")).rolled_back_from,
    ).toEqual([SHA_C, SHA_B]);
  });

  test("records the content digest of the release it rolled back from in the pin", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    const digest = await digestOfRelease(SHA_B);
    await rollback(root, () => NOW);
    expect(
      JSON.parse(await readFile(join(root, "pin"), "utf8")).rolled_back_content,
    ).toEqual([digest]);
  });

  test("keeps the content digests of earlier rollbacks in the pin", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "C", 3);
    const digests = [
      await digestOfRelease(SHA_C),
      await digestOfRelease(SHA_B),
    ];
    await rollback(root, () => NOW);
    await rollback(root, () => NOW);
    expect(
      JSON.parse(await readFile(join(root, "pin"), "utf8")).rolled_back_content,
    ).toEqual(digests);
  });

  test("downloads the release rolled back from again after unpinning", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    await unpin(unpinDeps(failingFetch), { force: true });
    await runOnce(deps(githubServing(SHA_B, "B", 2).fetch));
    expect(await readlink(join(root, "current"))).toBe(`releases/${SHA_B}`);
  });

  test("reports the cleanup as done", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    expect(await rollback(root, () => NOW)).toEqual({
      ok: true,
      sha: SHA_A,
      cleanup: "done",
    });
  });

  itFailsOnPermission(
    "reports the cleanup as pending when removing fails",
    async () => {
      await deploy(SHA_A, "A", 1);
      await deploy(SHA_B, "B", 2);
      await chmod(join(root, "releases"), 0o555);
      try {
        expect(await rollback(root, () => NOW)).toEqual({
          ok: true,
          sha: SHA_A,
          cleanup: "pending",
        });
      } finally {
        await chmod(join(root, "releases"), 0o755);
      }
    },
  );

  itFailsOnPermission(
    "keeps current switched when removing fails",
    async () => {
      await deploy(SHA_A, "A", 1);
      await deploy(SHA_B, "B", 2);
      await chmod(join(root, "releases"), 0o555);
      try {
        await rollback(root, () => NOW);
      } finally {
        await chmod(join(root, "releases"), 0o755);
      }
      expect(await readlink(join(root, "current"))).toBe(`releases/${SHA_A}`);
    },
  );

  test("removes the new pin when switching current fails", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await brokenRelease(SHA_A);
    await rollback(root, () => NOW).catch(() => {});
    expect(await exists(join(root, "pin"))).toBe(false);
  });

  test("restores the previous pin when switching current fails", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "C", 3);
    await rollback(root, () => NOW);
    const before = await readFile(join(root, "pin"), "utf8");
    await brokenRelease(SHA_A);
    await rollback(root, () => NOW).catch(() => {});
    expect(await readFile(join(root, "pin"), "utf8")).toBe(before);
  });

  test("rejects when switching current fails", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await brokenRelease(SHA_A);
    await expect(rollback(root, () => NOW)).rejects.toThrow();
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
    await unpin(unpinDeps(failingFetch), { force: false });
    expect(await exists(join(root, "pin"))).toBe(false);
  });

  test("does not query GitHub when the pin names no revoked release", async () => {
    await writeFile(join(root, "pin"), "{}");
    const github = githubWithLatestRun(SHA_B, 2);
    await unpin(unpinDeps(github.fetch), { force: false });
    expect(github.calls).toEqual([]);
  });

  test("succeeds when there is no pin", async () => {
    expect(await unpin(unpinDeps(failingFetch), { force: false })).toEqual({
      ok: true,
    });
  });

  test("does not append to history", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    await unpin(unpinDeps(failingFetch), { force: true });
    expect(
      JSON.parse(await readFile(join(root, "history.json"), "utf8")),
    ).toEqual([SHA_A, SHA_B]);
  });

  test("refuses while the latest run is the release rolled back from", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    expect(
      await unpin(unpinDeps(githubWithLatestRun(SHA_B, 2).fetch), {
        force: false,
      }),
    ).toEqual({ ok: false, reason: "latest_run_is_revoked", sha: SHA_B });
  });

  test("keeps the pin when refusing because the latest run is revoked", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    await unpin(unpinDeps(githubWithLatestRun(SHA_B, 2).fetch), {
      force: false,
    });
    expect(await exists(join(root, "pin"))).toBe(true);
  });

  test("refuses while the latest run has the same content as the release rolled back from", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "B", 3);
    await rollback(root, () => NOW);
    expect(
      await unpin(unpinDeps(githubWithLatestRun(SHA_B, 2).fetch), {
        force: false,
      }),
    ).toEqual({ ok: false, reason: "latest_run_is_revoked", sha: SHA_B });
  });

  test("unpins once a newer run has succeeded", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    expect(
      await unpin(unpinDeps(githubServing(SHA_C, "C", 3).fetch), {
        force: false,
      }),
    ).toEqual({ ok: true });
  });

  test("removes the pin once a newer run has succeeded", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    await unpin(unpinDeps(githubServing(SHA_C, "C", 3).fetch), {
      force: false,
    });
    expect(await exists(join(root, "pin"))).toBe(false);
  });

  test("refuses when the latest run cannot be looked up", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    expect(await unpin(unpinDeps(failingFetch), { force: false })).toEqual({
      ok: false,
      reason: "lookup_failed",
    });
  });

  test("keeps the pin when the latest run cannot be looked up", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    await unpin(unpinDeps(failingFetch), { force: false });
    expect(await exists(join(root, "pin"))).toBe(true);
  });

  test("refuses when the GitHub settings are missing", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    expect(
      await unpin(unpinDeps(failingFetch, null), { force: false }),
    ).toEqual({ ok: false, reason: "lookup_failed" });
  });

  test("refuses when no successful run exists", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    expect(
      await unpin(unpinDeps(fakeGitHub({ runs: [] }).fetch), { force: false }),
    ).toEqual({ ok: false, reason: "lookup_failed" });
  });

  test("unpins with force while the latest run is revoked", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    await unpin(unpinDeps(githubWithLatestRun(SHA_B, 2).fetch), {
      force: true,
    });
    expect(await exists(join(root, "pin"))).toBe(false);
  });

  test("does not query GitHub with force", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    const github = githubWithLatestRun(SHA_B, 2);
    await unpin(unpinDeps(github.fetch), { force: true });
    expect(github.calls).toEqual([]);
  });

  test("removes the revoked release left behind before releasing the pin", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await pinAt(SHA_A, [SHA_B]);
    await rm(join(root, "assets/index-B0000000.js"));
    await unpin(unpinDeps(failingFetch), { force: true });
    expect(await exists(join(root, "releases", SHA_B))).toBe(false);
  });

  test("refuses while the revoked release cannot be removed", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await pinAt(SHA_A, [SHA_B]);
    await rm(join(root, "releases", SHA_A, "manifest.json"));
    expect(
      await unpin(unpinDeps(githubWithLatestRun(SHA_C, 3).fetch), {
        force: false,
      }),
    ).toEqual({ ok: false, reason: "cleanup_incomplete" });
  });

  test("keeps the pin while the revoked release cannot be removed", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await pinAt(SHA_A, [SHA_B]);
    await rm(join(root, "releases", SHA_A, "manifest.json"));
    await unpin(unpinDeps(githubWithLatestRun(SHA_C, 3).fetch), {
      force: false,
    });
    expect(await exists(join(root, "pin"))).toBe(true);
  });

  test("unpins with ignoreCleanup even when the revoked release cannot be removed", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await pinAt(SHA_A, [SHA_B]);
    await rm(join(root, "releases", SHA_A, "manifest.json"));
    await unpin(unpinDeps(githubWithLatestRun(SHA_C, 3).fetch), {
      force: false,
      ignoreCleanup: true,
    });
    expect(await exists(join(root, "pin"))).toBe(false);
  });

  test("refuses with force while the revoked release cannot be removed", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await pinAt(SHA_A, [SHA_B]);
    await rm(join(root, "releases", SHA_A, "manifest.json"));
    expect(await unpin(unpinDeps(failingFetch), { force: true })).toEqual({
      ok: false,
      reason: "cleanup_incomplete",
    });
  });

  test("still checks the latest run with ignoreCleanup", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    expect(
      await unpin(unpinDeps(githubWithLatestRun(SHA_B, 2).fetch), {
        force: false,
        ignoreCleanup: true,
      }),
    ).toEqual({ ok: false, reason: "latest_run_is_revoked", sha: SHA_B });
  });

  test("refuses when a new commit has the same files as the release rolled back from", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    expect(
      await unpin(unpinDeps(githubServing(SHA_C, "B", 3).fetch), {
        force: false,
      }),
    ).toEqual({
      ok: false,
      reason: "latest_run_has_revoked_content",
      sha: SHA_C,
    });
  });

  test("keeps the pin when a new commit has the same files as the release rolled back from", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    await unpin(unpinDeps(githubServing(SHA_C, "B", 3).fetch), {
      force: false,
    });
    expect(await exists(join(root, "pin"))).toBe(true);
  });

  test("refuses when the files of the latest run cannot be read", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    expect(
      await unpin(unpinDeps(githubWithLatestRun(SHA_C, 3).fetch), {
        force: false,
      }),
    ).toEqual({ ok: false, reason: "content_undeterminable", sha: SHA_C });
  });

  test("keeps the pin when the files of the latest run cannot be read", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    await unpin(unpinDeps(githubWithLatestRun(SHA_C, 3).fetch), {
      force: false,
    });
    expect(await exists(join(root, "pin"))).toBe(true);
  });

  test("reads the files of the latest run from the release on disk", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "C", 3);
    await pinAt(SHA_A, [SHA_B], [await digestOfRelease(SHA_B)]);
    expect(
      await unpin(unpinDeps(githubWithLatestRun(SHA_C, 3).fetch), {
        force: false,
      }),
    ).toEqual({ ok: true });
  });

  test("refuses when the release on disk has the revoked files", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "B", 3);
    await pinAt(SHA_A, [SHA_B], [await digestOfRelease(SHA_B)]);
    expect(
      await unpin(unpinDeps(githubWithLatestRun(SHA_C, 3).fetch), {
        force: false,
      }),
    ).toEqual({
      ok: false,
      reason: "latest_run_has_revoked_content",
      sha: SHA_C,
    });
  });

  test("only compares shas for a pin without content digests", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await pinAt(SHA_A, [SHA_B]);
    expect(
      await unpin(unpinDeps(githubWithLatestRun(SHA_C, 3).fetch), {
        force: false,
      }),
    ).toEqual({ ok: true });
  });

  test("skips the file check with force", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    await unpin(unpinDeps(githubServing(SHA_C, "B", 3).fetch), { force: true });
    expect(await exists(join(root, "pin"))).toBe(false);
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

describe("runLoopIteration", () => {
  function failingAction(): Promise<void> {
    return Promise.reject(new Error("EACCES: permission denied, open 'lock'"));
  }

  test("does not throw when the iteration fails", async () => {
    await expect(runLoopIteration(failingAction, () => {})).resolves.toBe(
      undefined,
    );
  });

  test("logs a single filesystem_error line without details", async () => {
    const lines: [string, LogFields | undefined][] = [];
    await runLoopIteration(failingAction, (event, fields) => {
      lines.push([event, fields]);
    });
    expect(lines).toEqual([["failed", { error: "filesystem_error" }]]);
  });

  test("logs nothing when the iteration succeeds", async () => {
    const lines: string[] = [];
    await runLoopIteration(
      async () => {},
      (event) => {
        lines.push(event);
      },
    );
    expect(lines).toEqual([]);
  });
});
