import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import {
  chmod,
  cp,
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
  ciWorkflowRun,
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

/**
 * `releases/<sha>`を、中身はそのままに、本物のディレクトリでなくす。
 * マニフェストとassetsは揃っているので、戻し先に選ばれ、`switchCurrent`だけが拒む。
 */
async function brokenRelease(sha: string): Promise<void> {
  const outside = join(root, `outside-${sha.slice(0, 4)}`);
  await cp(join(root, "releases", sha), outside, { recursive: true });
  await rm(join(root, "releases", sha), { recursive: true, force: true });
  await symlink(outside, join(root, "releases", sha));
}

/** 付け替えに必ず失敗する`switchCurrent`の代わり。 */
async function failingSwitch(): Promise<void> {
  throw new Error("switch failed");
}

/** `revoked.json`を読む。 */
async function readRevoked(): Promise<{ shas: string[]; digests: string[] }> {
  return JSON.parse(await readFile(join(root, "revoked.json"), "utf8"));
}

/** `revoked.json`を書く。 */
async function writeRevoked(shas: string[], digests: string[] = []) {
  await writeFile(
    join(root, "revoked.json"),
    `${JSON.stringify({ shas, digests })}\n`,
  );
}

/** `revoked.json`に、書いたとおりの文字列を置く。 */
async function writeRevokedRaw(text: string): Promise<void> {
  await writeFile(join(root, "revoked.json"), text);
}

/** `revoked.json`を読めない状態にする(ファイルでなくディレクトリにする)。壊れた中身ではない。 */
async function blockRevokedFile(): Promise<void> {
  await mkdir(join(root, "revoked.json"));
}

/** 壊れた`revoked.json`を脇へ移した控えの名前を、古い順に返す。 */
async function corruptCopyNames(): Promise<string[]> {
  return (await readdir(root))
    .filter((name) => name.startsWith("revoked.json.corrupt-"))
    .sort();
}

/** 壊れた`revoked.json`を脇へ移した控えの中身を、名前の順に返す。 */
async function readCorruptCopies(): Promise<string[]> {
  const contents: string[] = [];
  for (const name of await corruptCopyNames()) {
    contents.push(await readFile(join(root, name), "utf8"));
  }
  return contents;
}

/** 管理者(root)は書き込みの権限の制限を受けないので、権限で失敗を起こすテストは飛ばす。 */
const itFailsOnPermission = process.getuid?.() === 0 ? test.skip : test;

describe("runOnce with the draw.io directory", () => {
  const drawioFiles = {
    ...filesFor("A"),
    "drawio/drawio-viewer-bc7586cb.js": "viewer",
    "drawio/drawio-frame-ca735013.js": "frame",
  };

  function githubServingDrawio() {
    const zip = buildRelease(SHA_A, drawioFiles);
    return fakeGitHub({
      runs: [workflowRun(1, SHA_A)],
      artifacts: { 1: [artifactJson(101, SHA_A, zip)] },
      blobs: { 101: zip },
    });
  }

  test("serves the draw.io files through current", async () => {
    await runOnce(deps(githubServingDrawio().fetch));
    expect(
      await readFile(
        join(root, "current", "drawio", "drawio-viewer-bc7586cb.js"),
        "utf8",
      ),
    ).toBe("viewer");
  });

  test("keeps the draw.io files out of the shared assets", async () => {
    await runOnce(deps(githubServingDrawio().fetch));
    expect(await readdir(join(root, "assets"))).toEqual(["index-A0000000.js"]);
  });

  test("reports ok for a release with the draw.io directory", async () => {
    const status = await runOnce(deps(githubServingDrawio().fetch));
    expect(status.state).toBe("ok");
  });
});

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
      "/repos/o/r/actions/workflows/console-dist.yml/runs",
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

  describe("with the ci.yml result", () => {
    function githubWithCi(ciRuns: readonly Record<string, unknown>[]) {
      const zip = buildRelease(SHA_A, filesFor("A"));
      return fakeGitHub({
        runs: [workflowRun(1, SHA_A)],
        ciRuns,
        artifacts: { 1: [artifactJson(101, SHA_A, zip)] },
        blobs: { 101: zip },
      });
    }

    test("reports no_successful_run when ci.yml has no successful run for the commit", async () => {
      const status = await runOnce(deps(githubWithCi([]).fetch));
      expect(status.error).toBe("no_successful_run");
    });

    test("does not point current at a commit whose ci.yml did not succeed", async () => {
      await runOnce(deps(githubWithCi([]).fetch));
      expect(await exists(join(root, "current"))).toBe(false);
    });

    test("does not download the artifact while ci.yml has not succeeded", async () => {
      const github = githubWithCi([]);
      await runOnce(deps(github.fetch));
      expect(
        github.calls.filter((call) => call.url.includes("/artifacts")),
      ).toEqual([]);
    });

    test("ignores a ci.yml run of another commit", async () => {
      const status = await runOnce(
        deps(githubWithCi([ciWorkflowRun(5, SHA_B)]).fetch),
      );
      expect(status.error).toBe("no_successful_run");
    });

    test("ignores a ci.yml run on a branch other than main", async () => {
      const onTag = { ...ciWorkflowRun(5, SHA_A), head_branch: "v1" };
      const status = await runOnce(deps(githubWithCi([onTag]).fetch));
      expect(status.error).toBe("no_successful_run");
    });

    test("ignores a ci.yml run that failed", async () => {
      const failed = { ...ciWorkflowRun(5, SHA_A), conclusion: "failure" };
      const status = await runOnce(deps(githubWithCi([failed]).fetch));
      expect(status.error).toBe("no_successful_run");
    });

    test("ignores a ci.yml run that is a pull_request run", async () => {
      const pr = { ...ciWorkflowRun(5, SHA_A), event: "pull_request" };
      const status = await runOnce(deps(githubWithCi([pr]).fetch));
      expect(status.error).toBe("no_successful_run");
    });

    test("deploys when ci.yml succeeded for the commit", async () => {
      const status = await runOnce(
        deps(githubWithCi([ciWorkflowRun(5, SHA_A)]).fetch),
      );
      expect(status.sha).toBe(SHA_A);
    });

    test("asks ci.yml for the commit on main pushes", async () => {
      const github = githubWithCi([ciWorkflowRun(5, SHA_A)]);
      await runOnce(deps(github.fetch));
      const ciCall = github.calls.find((call) =>
        call.url.includes("/workflows/ci.yml/runs"),
      );
      expect(
        Object.fromEntries(new URL(ciCall?.url ?? "").searchParams),
      ).toMatchObject({
        head_sha: SHA_A,
        branch: "main",
        event: "push",
        status: "success",
      });
    });

    test("falls back to the newest commit that both workflows passed", async () => {
      const zipA = buildRelease(SHA_A, filesFor("A"));
      const zipB = buildRelease(SHA_B, filesFor("B"));
      const github = fakeGitHub({
        runs: [
          workflowRun(1, SHA_A, "2026-10-07T00:00:00Z"),
          workflowRun(2, SHA_B, "2026-10-08T00:00:00Z"),
        ],
        ciRuns: [ciWorkflowRun(5, SHA_A)],
        artifacts: {
          1: [artifactJson(101, SHA_A, zipA)],
          2: [artifactJson(102, SHA_B, zipB)],
        },
        blobs: { 101: zipA, 102: zipB },
      });
      const status = await runOnce(deps(github.fetch));
      expect(status.sha).toBe(SHA_A);
    });

    test("reports github_unavailable when the ci.yml run list fails", async () => {
      const github = fakeGitHub({
        runs: [workflowRun(1, SHA_A)],
        ciRunsStatus: 500,
      });
      const status = await runOnce(deps(github.fetch));
      expect(status.error).toBe("github_unavailable");
    });
  });

  describe("version order and revocation", () => {
    /** 古い順に並べた版を、console-dist.ymlの成功した実行として配る。ci.ymlは`ciShas`の版だけ成功している。 */
    function githubWith(shas: readonly string[], ciShas: readonly string[]) {
      const runs: Record<string, unknown>[] = [];
      const artifacts: Record<number, unknown[]> = {};
      const blobs: Record<number, Uint8Array> = {};
      shas.forEach((sha, index) => {
        const id = index + 1;
        const zip = buildRelease(sha, filesFor(sha.slice(0, 1).toUpperCase()));
        runs.push(workflowRun(id, sha, `2026-10-0${index + 1}T00:00:00Z`));
        artifacts[id] = [artifactJson(100 + id, sha, zip)];
        blobs[100 + id] = zip;
      });
      return fakeGitHub({
        runs,
        ciRuns: ciShas.map((sha, index) => ciWorkflowRun(50 + index, sha)),
        artifacts,
        blobs,
      });
    }

    test("stays on the served commit even when its ci.yml run is no longer listed", async () => {
      await deploy(SHA_B, "B", 2);
      const status = await runOnce(
        deps(githubWith([SHA_A, SHA_B], [SHA_A]).fetch),
      );
      expect(status.sha).toBe(SHA_B);
    });

    test("does not check ci.yml once it reaches the served commit", async () => {
      await deploy(SHA_B, "B", 2);
      const github = githubWith([SHA_A, SHA_B], [SHA_A]);
      await runOnce(deps(github.fetch));
      expect(
        github.calls.filter((call) => call.url.includes("/workflows/ci.yml/")),
      ).toEqual([]);
    });

    test("deploys a newer commit that passed both workflows", async () => {
      await deploy(SHA_A, "A", 1);
      const status = await runOnce(
        deps(githubWith([SHA_A, SHA_B], [SHA_A, SHA_B]).fetch),
      );
      expect(status.sha).toBe(SHA_B);
    });

    test("skips a revoked commit and serves the previous one", async () => {
      await writeRevoked([SHA_B]);
      const status = await runOnce(
        deps(githubWith([SHA_A, SHA_B], [SHA_A, SHA_B]).fetch),
      );
      expect(status.sha).toBe(SHA_A);
    });

    test("keeps the revoked record after skipping the commit", async () => {
      await writeRevoked([SHA_B]);
      await runOnce(deps(githubWith([SHA_A, SHA_B], [SHA_A, SHA_B]).fetch));
      expect((await readRevoked()).shas).toEqual([SHA_B]);
    });

    test("does not bring the revoked commit back on a later run", async () => {
      await writeRevoked([SHA_B]);
      const github = githubWith([SHA_A, SHA_B], [SHA_A, SHA_B]);
      await runOnce(deps(github.fetch));
      const status = await runOnce(deps(github.fetch));
      expect(status.sha).toBe(SHA_A);
    });

    test("keeps current on the previous commit while the revoked one is newest", async () => {
      await deploy(SHA_A, "A", 1);
      await writeRevoked([SHA_B]);
      await runOnce(deps(githubWith([SHA_A, SHA_B], [SHA_A, SHA_B]).fetch));
      expect(await readlink(join(root, "current"))).toBe(`releases/${SHA_A}`);
    });

    test("reports no_successful_run when the only candidate is revoked", async () => {
      await writeRevoked([SHA_B]);
      const status = await runOnce(deps(githubWith([SHA_B], [SHA_B]).fetch));
      expect(status.error).toBe("no_successful_run");
    });
  });

  test("reports no_successful_run when only a ci.yml run is listed", async () => {
    const ciRun = {
      ...workflowRun(1, SHA_A),
      name: "CI",
      path: ".github/workflows/ci.yml",
    };
    const status = await runOnce(deps(fakeGitHub({ runs: [ciRun] }).fetch));
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
      "/repos/o/r/actions/workflows/console-dist.yml/runs",
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

  test("removes a revoked release during retention", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "C", 3);
    await writeRevoked([SHA_A]);
    await runOnce(deps(githubServing(SHA_C, "C", 3).fetch));
    expect(await exists(join(root, "releases", SHA_A))).toBe(false);
  });

  test("removes the assets only a revoked release used during retention", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "C", 3);
    await writeRevoked([SHA_A]);
    await runOnce(deps(githubServing(SHA_C, "C", 3).fetch));
    expect(await exists(join(root, "assets/index-A0000000.js"))).toBe(false);
  });

  test("removes a release with revoked files during retention", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "C", 3);
    await writeRevoked([], [await digestOfRelease(SHA_A)]);
    await runOnce(deps(githubServing(SHA_C, "C", 3).fetch));
    expect(await exists(join(root, "releases", SHA_A))).toBe(false);
  });

  test("keeps the current release even when it is revoked", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await writeRevoked([SHA_B]);
    await runOnce(deps(githubServing(SHA_B, "B", 2).fetch));
    expect(await exists(join(root, "releases", SHA_B))).toBe(true);
  });

  test("keeps the revoked shas whose releases are gone", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await writeRevoked([SHA_A, SHA_D]);
    await runOnce(deps(githubServing(SHA_B, "B", 2).fetch));
    expect((await readRevoked()).shas).toEqual([SHA_A, SHA_D]);
  });

  test("keeps the revoked digests after removing the revoked release", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    const digest = await digestOfRelease(SHA_A);
    await writeRevoked([SHA_A], [digest]);
    await runOnce(deps(githubServing(SHA_B, "B", 2).fetch));
    expect((await readRevoked()).digests).toEqual([digest]);
  });

  test("logs when revoked.json cannot be read during retention", async () => {
    await deploy(SHA_A, "A", 1);
    await writeRevokedRaw("not json");
    const events: string[] = [];
    await runOnce({
      ...deps(githubServing(SHA_A, "A", 1).fetch),
      log: (event) => events.push(event),
    });
    expect(events).toContain("revoked_state_unreadable");
  });

  test("keeps a copy of an invalid revoked.json during retention", async () => {
    await deploy(SHA_A, "A", 1);
    await writeRevokedRaw("not json");
    await runOnce(deps(githubServing(SHA_A, "A", 1).fetch));
    expect(await readCorruptCopies()).toEqual(["not json"]);
  });

  test("logs when revoked.json has the wrong shape during retention", async () => {
    await deploy(SHA_A, "A", 1);
    await writeRevokedRaw("[]");
    const events: string[] = [];
    await runOnce({
      ...deps(githubServing(SHA_A, "A", 1).fetch),
      log: (event) => events.push(event),
    });
    expect(events).toContain("revoked_state_unreadable");
  });

  test("keeps a copy of a revoked.json with the wrong shape during retention", async () => {
    await deploy(SHA_A, "A", 1);
    await writeRevokedRaw("[]");
    await runOnce(deps(githubServing(SHA_A, "A", 1).fetch));
    expect(await readCorruptCopies()).toEqual(["[]"]);
  });

  test("keeps the current release when its digest is revoked", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await writeRevoked([], [await digestOfRelease(SHA_B)]);
    await runOnce(deps(githubServing(SHA_B, "B", 2).fetch));
    expect(await exists(join(root, "releases", SHA_B))).toBe(true);
  });

  test("clears a revoked digest when the same files are released again", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rm(join(root, "current"));
    await symlink(`releases/${SHA_A}`, join(root, "current"));
    await writeRevoked([], [await digestOfRelease(SHA_B)]);
    await runOnce(deps(githubServing(SHA_B, "B", 2).fetch));
    expect((await readRevoked()).digests).toEqual([]);
  });

  test("serves the release whose revoked digest it clears", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rm(join(root, "current"));
    await symlink(`releases/${SHA_A}`, join(root, "current"));
    await writeRevoked([], [await digestOfRelease(SHA_B)]);
    await runOnce(deps(githubServing(SHA_B, "B", 2).fetch));
    expect(await readlink(join(root, "current"))).toBe(`releases/${SHA_B}`);
  });

  test("keeps the release whose revoked digest it clears", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rm(join(root, "current"));
    await symlink(`releases/${SHA_A}`, join(root, "current"));
    await writeRevoked([SHA_B], [await digestOfRelease(SHA_B)]);
    await runOnce(deps(githubServing(SHA_B, "B", 2).fetch));
    expect(await exists(join(root, "releases", SHA_B))).toBe(true);
  });

  test("drops the sha of the release whose digest it clears", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rm(join(root, "current"));
    await symlink(`releases/${SHA_A}`, join(root, "current"));
    await writeRevoked([SHA_B], [await digestOfRelease(SHA_B)]);
    await runOnce(deps(githubServing(SHA_C, "B", 3).fetch));
    expect((await readRevoked()).shas).toEqual([]);
  });

  test("logs when it clears a revoked digest", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rm(join(root, "current"));
    await symlink(`releases/${SHA_A}`, join(root, "current"));
    await writeRevoked([], [await digestOfRelease(SHA_B)]);
    const events: string[] = [];
    await runOnce({
      ...deps(githubServing(SHA_B, "B", 2).fetch),
      log: (event) => events.push(event),
    });
    expect(events).toContain("revoked_digest_cleared");
  });

  test("keeps the revoked digests of other files when it clears one", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rm(join(root, "current"));
    await symlink(`releases/${SHA_A}`, join(root, "current"));
    const other = "9".repeat(64);
    await writeRevoked([], [other, await digestOfRelease(SHA_B)]);
    await runOnce(deps(githubServing(SHA_B, "B", 2).fetch));
    expect((await readRevoked()).digests).toEqual([other]);
  });

  test("does not clear a revoked digest of files that were not released", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rm(join(root, "current"));
    await symlink(`releases/${SHA_A}`, join(root, "current"));
    const digest = await digestOfRelease(SHA_A);
    await writeRevoked([], [digest]);
    await runOnce(deps(githubServing(SHA_B, "B", 2).fetch));
    expect((await readRevoked()).digests).toEqual([digest]);
  });

  test("stays ok when revoked.json cannot be read during retention", async () => {
    await deploy(SHA_A, "A", 1);
    await blockRevokedFile();
    const status = await runOnce(deps(githubServing(SHA_A, "A", 1).fetch));
    expect(status.state).toBe("ok");
  });

  test("logs a read error of revoked.json during retention", async () => {
    await deploy(SHA_A, "A", 1);
    await blockRevokedFile();
    const events: string[] = [];
    await runOnce({
      ...deps(githubServing(SHA_A, "A", 1).fetch),
      log: (event) => events.push(event),
    });
    expect(events).toContain("revoked_state_read_failed");
  });

  itFailsOnPermission("logs when clearing a revoked digest fails", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rm(join(root, "current"));
    await symlink(`releases/${SHA_A}`, join(root, "current"));
    await writeRevoked([], [await digestOfRelease(SHA_B)]);
    const events: string[] = [];
    try {
      await runOnce({
        ...deps(githubServing(SHA_B, "B", 2).fetch),
        log: (event) => {
          events.push(event);
          if (event === "deployed") chmodSync(root, 0o555);
        },
      });
    } finally {
      await chmod(root, 0o755);
    }
    expect(events).toContain("revoked_digest_clear_failed");
  });

  test("keeps the sha of a revoked version when its digest was not recorded", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rm(join(root, "current"));
    await symlink(`releases/${SHA_A}`, join(root, "current"));
    await writeRevoked([SHA_B], []);
    await runOnce(deps(githubServing(SHA_B, "B", 2).fetch));
    expect((await readRevoked()).shas).toEqual([SHA_B]);
  });
});

describe("runOnce with a pin", () => {
  test("logs when the pin names another release than current", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await pinAt(SHA_A, [SHA_C]);
    await rm(join(root, "current"));
    await symlink(`releases/${SHA_B}`, join(root, "current"));
    const events: string[] = [];
    await runOnce({
      ...deps(githubServing(SHA_B, "B", 2).fetch),
      log: (event) => events.push(event),
    });
    expect(events).toContain("pin_mismatch");
  });

  test("does not log pin_mismatch when the pin names current", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await pinAt(SHA_A, [SHA_B]);
    const events: string[] = [];
    await runOnce({
      ...deps(githubServing(SHA_B, "B", 2).fetch),
      log: (event) => events.push(event),
    });
    expect(events).not.toContain("pin_mismatch");
  });

  test("stays pinned when the pin names another release than current", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await pinAt(SHA_A, [SHA_C]);
    await rm(join(root, "current"));
    await symlink(`releases/${SHA_B}`, join(root, "current"));
    const status = await runOnce(deps(githubServing(SHA_B, "B", 2).fetch));
    expect(status.state).toBe("pinned");
  });

  test("stays pinned when the pin cannot be read", async () => {
    await deploy(SHA_A, "A", 1);
    await mkdir(join(root, "pin"));
    const status = await runOnce(deps(githubServing(SHA_A, "A", 1).fetch));
    expect(status.state).toBe("pinned");
  });

  test("reports no error when the pin cannot be read", async () => {
    await deploy(SHA_A, "A", 1);
    await mkdir(join(root, "pin"));
    const status = await runOnce(deps(githubServing(SHA_A, "A", 1).fetch));
    expect(status.error).toBeNull();
  });

  test("logs when the pin cannot be read", async () => {
    await deploy(SHA_A, "A", 1);
    await mkdir(join(root, "pin"));
    const events: string[] = [];
    await runOnce({
      ...deps(githubServing(SHA_A, "A", 1).fetch),
      log: (event) => events.push(event),
    });
    expect(events).toContain("pin_read_failed");
  });

  test("does not log pin_mismatch when the pin cannot be read", async () => {
    await deploy(SHA_A, "A", 1);
    await mkdir(join(root, "pin"));
    const events: string[] = [];
    await runOnce({
      ...deps(githubServing(SHA_A, "A", 1).fetch),
      log: (event) => events.push(event),
    });
    expect(events).not.toContain("pin_mismatch");
  });

  test("does not log pin_mismatch when the pin names no release", async () => {
    await deploy(SHA_A, "A", 1);
    await writeFile(join(root, "pin"), "{}");
    const events: string[] = [];
    await runOnce({
      ...deps(githubServing(SHA_A, "A", 1).fetch),
      log: (event) => events.push(event),
    });
    expect(events).not.toContain("pin_mismatch");
  });

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

  test("does not bring the commit rolled back from back after unpinning", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    await unpin(unpinDeps(failingFetch), { force: true, ignoreCleanup: false });
    await runOnce(deps(githubServing(SHA_B, "B", 2).fetch));
    expect(await readlink(join(root, "current"))).toBe(`releases/${SHA_A}`);
  });

  test("serves a new commit with the content rolled back from after unpinning", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    await unpin(unpinDeps(failingFetch), { force: true, ignoreCleanup: false });
    await runOnce(deps(githubServing(SHA_C, "B", 3).fetch));
    expect(await readlink(join(root, "current"))).toBe(`releases/${SHA_C}`);
  });

  test("reports the cleanup as done", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    expect(await rollback(root, () => NOW)).toEqual({
      ok: true,
      sha: SHA_A,
      cleanup: "done",
      contentRecorded: true,
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
          contentRecorded: true,
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

  test("skips a symlinked release and chooses the next valid one", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "C", 3);
    await brokenRelease(SHA_B);
    await rollback(root, () => NOW);
    expect(await readlink(join(root, "current"))).toBe(`releases/${SHA_A}`);
  });

  test("removes the new pin when switching current fails", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(
      root,
      () => NOW,
      () => {},
      failingSwitch,
    ).catch(() => {});
    expect(await exists(join(root, "pin"))).toBe(false);
  });

  test("restores the previous pin when switching current fails", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "C", 3);
    await rollback(root, () => NOW);
    const before = await readFile(join(root, "pin"), "utf8");
    await rollback(
      root,
      () => NOW,
      () => {},
      failingSwitch,
    ).catch(() => {});
    expect(await readFile(join(root, "pin"), "utf8")).toBe(before);
  });

  test("rejects when switching current fails", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await expect(
      rollback(
        root,
        () => NOW,
        () => {},
        failingSwitch,
      ),
    ).rejects.toThrow("switch failed");
  });

  test("does not record the revoked state when switching current fails", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(
      root,
      () => NOW,
      () => {},
      failingSwitch,
    ).catch(() => {});
    expect(await exists(join(root, "revoked.json"))).toBe(false);
  });

  test("records the rolled back shas in the revoked state", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    expect((await readRevoked()).shas).toEqual([SHA_B]);
  });

  test("records the content digest in the revoked state", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    const digest = await digestOfRelease(SHA_B);
    await rollback(root, () => NOW);
    expect((await readRevoked()).digests).toEqual([digest]);
  });

  test("keeps the revoked state after unpinning", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    await unpin(unpinDeps(failingFetch), { force: true, ignoreCleanup: false });
    expect((await readRevoked()).shas).toEqual([SHA_B]);
  });

  test("does not roll back to a release whose sha is revoked", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "C", 3);
    await writeRevoked([SHA_B]);
    await rollback(root, () => NOW);
    expect(await readlink(join(root, "current"))).toBe(`releases/${SHA_A}`);
  });

  test("does not roll back to a release whose files are revoked", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "C", 3);
    await writeRevoked([], [await digestOfRelease(SHA_B)]);
    await rollback(root, () => NOW);
    expect(await readlink(join(root, "current"))).toBe(`releases/${SHA_A}`);
  });

  test("still rolls back when recording the revoked state fails", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await blockRevokedFile();
    expect(await rollback(root, () => NOW)).toMatchObject({
      ok: true,
      sha: SHA_A,
    });
  });

  test("logs when recording the revoked state fails", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await blockRevokedFile();
    const events: string[] = [];
    await rollback(
      root,
      () => NOW,
      (event) => events.push(event),
    );
    expect(events).toContain("revoked_record_failed");
  });

  test("still removes the release rolled back from when recording fails", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await blockRevokedFile();
    await rollback(root, () => NOW);
    expect(await readdir(join(root, "releases"))).toEqual([SHA_A]);
  });

  test("still writes the status when recording fails", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await blockRevokedFile();
    await rollback(root, () => NOW);
    expect(
      JSON.parse(await readFile(join(root, "status.json"), "utf8")).state,
    ).toBe("pinned");
  });

  test("logs when revoked.json is not valid JSON", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await writeRevokedRaw("not json");
    const events: string[] = [];
    await rollback(
      root,
      () => NOW,
      (event) => events.push(event),
    );
    expect(events).toContain("revoked_state_unreadable");
  });

  test("keeps a copy of an invalid revoked.json", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await writeRevokedRaw("not json");
    await rollback(root, () => NOW);
    expect(await readCorruptCopies()).toEqual(["not json"]);
  });

  test("logs when revoked.json has the wrong shape", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await writeRevokedRaw('{"shas":"x"}');
    const events: string[] = [];
    await rollback(
      root,
      () => NOW,
      (event) => events.push(event),
    );
    expect(events).toContain("revoked_state_unreadable");
  });

  test("keeps a copy of a revoked.json with the wrong shape", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await writeRevokedRaw('{"shas":"x"}');
    await rollback(root, () => NOW);
    expect(await readCorruptCopies()).toEqual(['{"shas":"x"}']);
  });

  test("writes a valid revoked.json after setting a corrupt one aside", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await writeRevokedRaw("not json");
    await rollback(root, () => NOW);
    expect((await readRevoked()).shas).toEqual([SHA_B]);
  });

  test("does not log when revoked.json is valid", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await writeRevoked([SHA_D]);
    const events: string[] = [];
    await rollback(
      root,
      () => NOW,
      (event) => events.push(event),
    );
    expect(events).not.toContain("revoked_state_unreadable");
  });

  test("does not log when revoked.json does not exist", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    const events: string[] = [];
    await rollback(
      root,
      () => NOW,
      (event) => events.push(event),
    );
    expect(events).not.toContain("revoked_state_unreadable");
  });

  test("keeps both copies when revoked.json is corrupted twice", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "C", 3);
    await writeRevokedRaw("one");
    await rollback(root, () => new Date(1000));
    await writeRevokedRaw("two");
    await rollback(root, () => new Date(2000));
    expect(await readCorruptCopies()).toEqual(["one", "two"]);
  });

  test("keeps both copies when revoked.json is corrupted twice in the same millisecond", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "C", 3);
    await writeRevokedRaw("one");
    await rollback(root, () => NOW);
    await writeRevokedRaw("two");
    await rollback(root, () => NOW);
    expect(await readCorruptCopies()).toEqual(["one", "two"]);
  });

  test("keeps only the five newest copies of a corrupt revoked.json", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    for (let epoch = 1; epoch <= 6; epoch++) {
      await writeFile(
        join(root, `revoked.json.corrupt-${epoch}`),
        `old${epoch}`,
      );
    }
    await writeRevokedRaw("new");
    await rollback(root, () => NOW);
    expect(await corruptCopyNames()).toHaveLength(5);
  });

  test("deletes the oldest copies of a corrupt revoked.json", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    for (let epoch = 1; epoch <= 6; epoch++) {
      await writeFile(
        join(root, `revoked.json.corrupt-${epoch}`),
        `old${epoch}`,
      );
    }
    await writeRevokedRaw("new");
    await rollback(root, () => NOW);
    expect(await corruptCopyNames()).not.toContain("revoked.json.corrupt-1");
  });

  test("does not treat a read error as corruption", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await blockRevokedFile();
    const events: string[] = [];
    await rollback(
      root,
      () => NOW,
      (event) => events.push(event),
    );
    expect(events).not.toContain("revoked_state_unreadable");
  });

  test("logs a read error of revoked.json", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await blockRevokedFile();
    const events: string[] = [];
    await rollback(
      root,
      () => NOW,
      (event) => events.push(event),
    );
    expect(events).toContain("revoked_state_read_failed");
  });

  test("does not move revoked.json when it cannot be read", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await blockRevokedFile();
    await rollback(root, () => NOW);
    expect((await lstat(join(root, "revoked.json"))).isDirectory()).toBe(true);
  });

  test("logs when the previous pin cannot be read", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await writeFile(join(root, "pin"), "not json");
    const events: string[] = [];
    await rollback(
      root,
      () => NOW,
      (event) => events.push(event),
    );
    expect(events).toContain("rollback_previous_pin_unreadable");
  });

  test("keeps the earlier revoked records when the previous pin cannot be read", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "C", 3);
    await rollback(root, () => NOW);
    await writeFile(join(root, "pin"), "not json");
    await rollback(root, () => NOW);
    expect((await readRevoked()).shas).toEqual([SHA_C, SHA_B]);
  });

  test("does not roll back to a release whose manifest cannot be read", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "C", 3);
    await rm(join(root, "releases", SHA_B, "manifest.json"));
    await rollback(root, () => NOW);
    expect(await readlink(join(root, "current"))).toBe(`releases/${SHA_A}`);
  });

  test("keeps the assets of the readable releases when it skips an unreadable one", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "C", 3);
    await rm(join(root, "releases", SHA_B, "manifest.json"));
    await rollback(root, () => NOW);
    expect(await exists(join(root, "assets/index-A0000000.js"))).toBe(true);
  });

  test("reports no_previous_release when the only earlier release has an unreadable manifest", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rm(join(root, "releases", SHA_A, "manifest.json"));
    expect(await rollback(root, () => NOW)).toEqual({
      ok: false,
      reason: "no_previous_release",
    });
  });

  test("does not roll back to a release whose assets are missing", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "C", 3);
    await rm(join(root, "assets/index-B0000000.js"));
    await rollback(root, () => NOW);
    expect(await readlink(join(root, "current"))).toBe(`releases/${SHA_A}`);
  });

  test("reports that the content was not recorded when the manifest of current cannot be read", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rm(join(root, "releases", SHA_B, "manifest.json"));
    expect(await rollback(root, () => NOW)).toMatchObject({
      ok: true,
      contentRecorded: false,
    });
  });

  test("logs when the content was not recorded", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rm(join(root, "releases", SHA_B, "manifest.json"));
    const events: string[] = [];
    await rollback(
      root,
      () => NOW,
      (event) => events.push(event),
    );
    expect(events).toContain("rollback_content_unrecorded");
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
    await unpin(unpinDeps(failingFetch), {
      force: false,
      ignoreCleanup: false,
    });
    expect(await exists(join(root, "pin"))).toBe(false);
  });

  test("does not query GitHub when the pin names no revoked release", async () => {
    await writeFile(join(root, "pin"), "{}");
    const github = githubWithLatestRun(SHA_B, 2);
    await unpin(unpinDeps(github.fetch), {
      force: false,
      ignoreCleanup: false,
    });
    expect(github.calls).toEqual([]);
  });

  test("succeeds when there is no pin", async () => {
    expect(
      await unpin(unpinDeps(failingFetch), {
        force: false,
        ignoreCleanup: false,
      }),
    ).toEqual({
      ok: true,
    });
  });

  test("refuses when the pin cannot be parsed", async () => {
    await writeFile(join(root, "pin"), "not json");
    expect(
      await unpin(unpinDeps(failingFetch), {
        force: false,
        ignoreCleanup: false,
      }),
    ).toEqual({
      ok: false,
      reason: "pin_unreadable",
    });
  });

  test("keeps a pin that cannot be parsed when refusing", async () => {
    await writeFile(join(root, "pin"), "not json");
    await unpin(unpinDeps(failingFetch), {
      force: false,
      ignoreCleanup: false,
    });
    expect(await exists(join(root, "pin"))).toBe(true);
  });

  test("removes a pin that cannot be parsed with force", async () => {
    await writeFile(join(root, "pin"), "not json");
    await unpin(unpinDeps(failingFetch), { force: true, ignoreCleanup: false });
    expect(await exists(join(root, "pin"))).toBe(false);
  });

  test("records the revoked releases of the pin in the revoked state when unpinning", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await pinAt(SHA_A, [SHA_B], [await digestOfRelease(SHA_B)]);
    await unpin(unpinDeps(failingFetch), { force: true, ignoreCleanup: false });
    expect((await readRevoked()).shas).toEqual([SHA_B]);
  });

  test("refuses when the pin has a rolled_back_from that is not a list of shas", async () => {
    await writeFile(join(root, "pin"), '{"rolled_back_from":["zzz"]}');
    expect(
      await unpin(unpinDeps(failingFetch), {
        force: false,
        ignoreCleanup: false,
      }),
    ).toEqual({ ok: false, reason: "pin_unreadable" });
  });

  test("refuses when the pin has a rolled_back_content that is not a list of digests", async () => {
    await writeFile(join(root, "pin"), '{"rolled_back_content":"x"}');
    expect(
      await unpin(unpinDeps(failingFetch), {
        force: false,
        ignoreCleanup: false,
      }),
    ).toEqual({ ok: false, reason: "pin_unreadable" });
  });

  test("removes a malformed pin with force", async () => {
    await writeFile(join(root, "pin"), '{"rolled_back_from":["zzz"]}');
    await unpin(unpinDeps(failingFetch), { force: true, ignoreCleanup: false });
    expect(await exists(join(root, "pin"))).toBe(false);
  });

  test("rejects when the revoked state cannot be written", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await pinAt(SHA_A, [SHA_B]);
    await blockRevokedFile();
    await expect(
      unpin(unpinDeps(failingFetch), { force: true, ignoreCleanup: false }),
    ).rejects.toThrow();
  });

  test("keeps the pin when the revoked state cannot be written", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await pinAt(SHA_A, [SHA_B]);
    await blockRevokedFile();
    await unpin(unpinDeps(failingFetch), {
      force: true,
      ignoreCleanup: false,
    }).catch(() => {});
    expect(await exists(join(root, "pin"))).toBe(true);
  });

  test("refuses a release rolled back from in an earlier rollback that the pin no longer lists", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "C", 3);
    await rollback(root, () => NOW);
    await pinAt(SHA_B);
    expect(
      await unpin(unpinDeps(githubWithLatestRun(SHA_C, 3).fetch), {
        force: false,
        ignoreCleanup: false,
      }),
    ).toEqual({ ok: false, reason: "latest_run_is_revoked", sha: SHA_C });
  });

  test("refuses files rolled back from in an earlier rollback that the pin no longer lists", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await deploy(SHA_C, "C", 3);
    await rollback(root, () => NOW);
    await pinAt(SHA_B);
    expect(
      await unpin(unpinDeps(githubServing(SHA_D, "C", 4).fetch), {
        force: false,
        ignoreCleanup: false,
      }),
    ).toEqual({
      ok: false,
      reason: "latest_run_has_revoked_content",
      sha: SHA_D,
    });
  });

  test("does not append to history", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    await unpin(unpinDeps(failingFetch), { force: true, ignoreCleanup: false });
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
        ignoreCleanup: false,
      }),
    ).toEqual({ ok: false, reason: "latest_run_is_revoked", sha: SHA_B });
  });

  test("keeps the pin when refusing because the latest run is revoked", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    await unpin(unpinDeps(githubWithLatestRun(SHA_B, 2).fetch), {
      force: false,
      ignoreCleanup: false,
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
        ignoreCleanup: false,
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
        ignoreCleanup: false,
      }),
    ).toEqual({ ok: true });
  });

  test("removes the pin once a newer run has succeeded", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    await unpin(unpinDeps(githubServing(SHA_C, "C", 3).fetch), {
      force: false,
      ignoreCleanup: false,
    });
    expect(await exists(join(root, "pin"))).toBe(false);
  });

  test("refuses when the latest run cannot be looked up", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    expect(
      await unpin(unpinDeps(failingFetch), {
        force: false,
        ignoreCleanup: false,
      }),
    ).toEqual({
      ok: false,
      reason: "lookup_failed",
    });
  });

  test("keeps the pin when the latest run cannot be looked up", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    await unpin(unpinDeps(failingFetch), {
      force: false,
      ignoreCleanup: false,
    });
    expect(await exists(join(root, "pin"))).toBe(true);
  });

  test("refuses when the GitHub settings are missing", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    expect(
      await unpin(unpinDeps(failingFetch, null), {
        force: false,
        ignoreCleanup: false,
      }),
    ).toEqual({ ok: false, reason: "lookup_failed" });
  });

  test("refuses when no successful run exists", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    expect(
      await unpin(unpinDeps(fakeGitHub({ runs: [] }).fetch), {
        force: false,
        ignoreCleanup: false,
      }),
    ).toEqual({ ok: false, reason: "lookup_failed" });
  });

  test("unpins with force while the latest run is revoked", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    await unpin(unpinDeps(githubWithLatestRun(SHA_B, 2).fetch), {
      force: true,
      ignoreCleanup: false,
    });
    expect(await exists(join(root, "pin"))).toBe(false);
  });

  test("does not query GitHub with force", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    const github = githubWithLatestRun(SHA_B, 2);
    await unpin(unpinDeps(github.fetch), { force: true, ignoreCleanup: false });
    expect(github.calls).toEqual([]);
  });

  test("removes the revoked release left behind before releasing the pin", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await pinAt(SHA_A, [SHA_B]);
    await rm(join(root, "assets/index-B0000000.js"));
    await unpin(unpinDeps(failingFetch), { force: true, ignoreCleanup: false });
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
        ignoreCleanup: false,
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
      ignoreCleanup: false,
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
    expect(
      await unpin(unpinDeps(failingFetch), {
        force: true,
        ignoreCleanup: false,
      }),
    ).toEqual({
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
        ignoreCleanup: false,
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
      ignoreCleanup: false,
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
        ignoreCleanup: false,
      }),
    ).toEqual({ ok: false, reason: "content_undeterminable", sha: SHA_C });
  });

  test("keeps the pin when the files of the latest run cannot be read", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    await unpin(unpinDeps(githubWithLatestRun(SHA_C, 3).fetch), {
      force: false,
      ignoreCleanup: false,
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
        ignoreCleanup: false,
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
        ignoreCleanup: false,
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
        ignoreCleanup: false,
      }),
    ).toEqual({ ok: true });
  });

  test("skips the file check with force", async () => {
    await deploy(SHA_A, "A", 1);
    await deploy(SHA_B, "B", 2);
    await rollback(root, () => NOW);
    await unpin(unpinDeps(githubServing(SHA_C, "B", 3).fetch), {
      force: true,
      ignoreCleanup: false,
    });
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
