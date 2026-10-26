import { describe, expect, test } from "bun:test";
import {
  chooseDeployOrSkip,
  isSameDeploymentRange,
  resolveTriggerKind,
} from "../../f/factory/lib/self_update_support.ts";
import type { LatestSuccessDeployment } from "../../f/factory/lib/types.ts";

// 直近の成功と同じ範囲の反映を繰り返さないことの確認。
// 判断(`chooseDeployOrSkip`)は入出力から切り離した関数なので、偽の読み取りで試験する。
// `self_update.ts`への組み込みは、ソースの文字列照合で固定する。構文は解析しないので、
// 呼び出しを別の形に書き換えると、実装が正しくても落ちることがある。そのときは照合を直す。

const OLD = "ff88a5c0000000000000000000000000000000aa";
const NEW = "81a99180000000000000000000000000000000bb";
const OTHER = "1234567000000000000000000000000000000000";

function latest(
  from: string | null,
  to: string,
): LatestSuccessDeployment | null {
  return { sha_from: from, sha_to: to };
}

type Harness = {
  readonly deps: Parameters<typeof chooseDeployOrSkip>[0];
  readonly reads: () => number;
  readonly errors: unknown[];
};

async function choose(h: Harness): Promise<string> {
  const choice = await chooseDeployOrSkip(h.deps, {
    shaFrom: OLD,
    shaTo: NEW,
  });
  return choice.action;
}

function harness(
  read: () => Promise<LatestSuccessDeployment | null>,
): Harness {
  let reads = 0;
  const errors: unknown[] = [];
  return {
    deps: {
      readLatestSuccess: () => {
        reads += 1;
        return read();
      },
      onReadError: (err) => {
        errors.push(err);
      },
    },
    reads: () => reads,
    errors,
  };
}

describe("isSameDeploymentRange", () => {
  test("is true when both the source and the target match", () => {
    expect(isSameDeploymentRange(latest(OLD, NEW), OLD, NEW)).toBe(true);
  });

  test("is false when only the source differs", () => {
    expect(isSameDeploymentRange(latest(OTHER, NEW), OLD, NEW)).toBe(false);
  });

  test("is false when only the target differs", () => {
    expect(isSameDeploymentRange(latest(OLD, OTHER), OLD, NEW)).toBe(false);
  });

  test("is false when there is no successful record", () => {
    expect(isSameDeploymentRange(null, OLD, NEW)).toBe(false);
  });

  test("is false for a first deployment without a source", () => {
    expect(isSameDeploymentRange(latest(null, NEW), null, NEW)).toBe(false);
  });
});

describe("chooseDeployOrSkip", () => {
  test("reads the latest success before deciding", async () => {
    const h = harness(async () => latest(OTHER, OLD));

    await choose(h);

    expect(h.reads()).toBe(1);
  });

  test("skips when the latest success has the same range", async () => {
    expect(await choose(harness(async () => latest(OLD, NEW)))).toBe("skip");
  });

  test("deploys when the latest success has a different range", async () => {
    expect(await choose(harness(async () => latest(OTHER, OLD)))).toBe(
      "deploy",
    );
  });

  test("deploys when there is no successful record", async () => {
    expect(await choose(harness(async () => null))).toBe("deploy");
  });

  test("deploys a first deployment without reading the record", async () => {
    const h = harness(async () => latest(null, NEW));

    const choice = await chooseDeployOrSkip(h.deps, {
      shaFrom: null,
      shaTo: NEW,
    });

    expect([choice.action, h.reads()]).toEqual(["deploy", 0]);
  });

  test("deploys when the record cannot be read", async () => {
    const h = harness(() => Promise.reject(new Error("db down")));

    expect(await choose(h)).toBe("deploy");
  });

  test("reports why the record could not be read", async () => {
    const failure = new Error("db down");
    const h = harness(() => Promise.reject(failure));

    await choose(h);

    expect(h.errors).toEqual([failure]);
  });

  test("does not report an error when the record is read", async () => {
    const h = harness(async () => latest(OLD, NEW));

    await choose(h);

    expect(h.errors).toEqual([]);
  });
});

describe("resolveTriggerKind", () => {
  test("is schedule when the job came from a schedule", () => {
    expect(
      resolveTriggerKind({
        WM_JOB_ID: "job-1",
        WM_SCHEDULE_PATH: "f/factory/self_update",
      }),
    ).toBe("schedule");
  });

  test("is manual when the job has no schedule path", () => {
    expect(resolveTriggerKind({ WM_JOB_ID: "job-1" })).toBe("manual");
  });

  test("is manual when the schedule path is empty", () => {
    const env = { WM_JOB_ID: "job-1", WM_SCHEDULE_PATH: "" };

    expect(resolveTriggerKind(env)).toBe("manual");
  });

  test("is unknown outside a job", () => {
    expect(resolveTriggerKind({})).toBe("unknown");
  });

  test("is unknown when the job id is empty", () => {
    const env = { WM_JOB_ID: "", WM_SCHEDULE_PATH: "f/x" };

    expect(resolveTriggerKind(env)).toBe("unknown");
  });
});

/** コメントを除いた`self_update.ts`のソース。 */
async function selfUpdateSource(): Promise<string> {
  const text = await Bun.file("f/factory/self_update.ts").text();
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/.*$/gm, "");
}

/** 見送りの分岐。`if (choice.action === "skip") {`から、見送りの結果を返す文まで。 */
function skipBranch(source: string): string {
  const start = source.indexOf('if (choice.action === "skip") {');
  const end = source.indexOf('reason: "same_range"', start);
  return start < 0 || end < 0 ? "" : source.slice(start, end);
}

describe("self_update same range wiring", () => {
  test("decides before the first wmill command", async () => {
    const source = await selfUpdateSource();

    expect(source.indexOf("await chooseDeployOrSkip(")).toBeLessThan(
      source.indexOf("await runWmillCli("),
    );
  });

  test("decides before the deploying log", async () => {
    const source = await selfUpdateSource();

    expect(source.indexOf("await chooseDeployOrSkip(")).toBeLessThan(
      source.indexOf('"self clone changed, deploying"'),
    );
  });

  test("decides after the deploy freeze hold", async () => {
    const source = await selfUpdateSource();

    expect(source.indexOf('return { outcome: "held"')).toBeLessThan(
      source.indexOf("await chooseDeployOrSkip("),
    );
  });

  test("decides only when the run is not a schedule follow-up", async () => {
    const source = await selfUpdateSource();

    expect(source).toMatch(
      /if \(!reconcileOnly\) \{\s*const choice = await chooseDeployOrSkip\(/,
    );
  });

  test("reads the latest success inside a bounded call", async () => {
    const source = await selfUpdateSource();

    expect(source).toMatch(
      /readLatestSuccess: \(\) =>\s*withCallTimeout\("getLatestSuccessDeployment", \(\) =>\s*getLatestSuccessDeployment\(\),?\s*\),/,
    );
  });

  test("the skip branch exists", async () => {
    expect(skipBranch(await selfUpdateSource()).length).toBeGreaterThan(0);
  });

  test("the skip branch does not run the CLI", async () => {
    expect(skipBranch(await selfUpdateSource())).not.toContain("runWmillCli(");
  });

  test("the skip branch does not record a deployment", async () => {
    const branch = skipBranch(await selfUpdateSource());

    expect(branch).not.toMatch(/record(Success|Failed)?Deployment/);
  });

  test("the skip branch advances the deployed sha", async () => {
    expect(skipBranch(await selfUpdateSource())).toContain(
      "await markDeployed()",
    );
  });

  test("the skip branch logs the skip once with both shas", async () => {
    const branch = skipBranch(await selfUpdateSource());

    expect([
      branch.match(/log\.info\(/g)?.length,
      branch.includes("sha_from: deployedSha"),
      branch.includes("sha_to: currentSha"),
    ]).toEqual([1, true, true]);
  });

  test("the skip branch resolves the host action notices", async () => {
    expect(skipBranch(await selfUpdateSource())).toContain(
      "await resolveHostActionNotices()",
    );
  });

  test("the skip result differs from the result of a deployed run", async () => {
    const source = await selfUpdateSource();

    expect(source).toMatch(
      /return \{\s*outcome: "skipped",\s*reason: "same_range",\s*sha_from: deployedSha,\s*sha_to: currentSha,\s*\};/,
    );
  });

  test("logs the trigger kind at the start of every run", async () => {
    const source = await selfUpdateSource();
    const start = source.indexOf("async function updateSelf(");

    expect(source.indexOf('log.info("self_update started"', start)).toBe(
      source.indexOf("log.info(", start),
    );
  });

  test("logs the trigger kind from the job environment", async () => {
    const source = await selfUpdateSource();

    expect(source).toContain("trigger: resolveTriggerKind(process.env),");
  });
});
