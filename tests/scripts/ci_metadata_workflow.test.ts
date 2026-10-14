import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `metadata`ジョブが、検査の失敗のときだけ、条件を満たすPRにパッチを出す配線を確かめる。
// 実際のGitHub Actionsでは動かせないので、ワークフローの定義を静的に確かめる。
const ROOT = join(import.meta.dir, "..", "..");

// GitHub Actionsの式の開き括弧。テンプレートリテラルの置換と誤検出されないよう、組み立てる。
const OPEN = "$" + "{{";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readYaml(file: string): Record<string, unknown> {
  const parsed: unknown = Bun.YAML.parse(
    readFileSync(join(ROOT, ".github", "workflows", file), "utf8"),
  );
  if (!isRecord(parsed)) {
    throw new Error(`${file} is not an object`);
  }
  return parsed;
}

function recordAt(parent: unknown, key: string): Record<string, unknown> {
  if (!isRecord(parent)) {
    throw new Error(`not an object when reading ${key}`);
  }
  const value = parent[key];
  if (!isRecord(value)) {
    throw new Error(`${key} is not an object`);
  }
  return value;
}

function stepsOf(job: Record<string, unknown>): Record<string, unknown>[] {
  const steps = job.steps;
  if (!Array.isArray(steps)) {
    throw new Error("no steps");
  }
  return steps.filter(isRecord);
}

const ci = readYaml("ci.yml");
const consoleDist = readYaml("console-dist.yml");
const metadata = recordAt(recordAt(ci, "jobs"), "metadata");
const steps = stepsOf(metadata);

function stepNamed(name: string): Record<string, unknown> {
  const found = steps.find((step) => step.name === name);
  if (found === undefined) {
    throw new Error(`step not found: ${name}`);
  }
  return found;
}

function indexOfStep(name: string): number {
  return steps.findIndex((step) => step.name === name);
}

const FAILED = "steps.check.outcome == 'failure'";
const ELIGIBLE = "env.METADATA_PATCH_ELIGIBLE == 'true'";

const GATED_STEPS: string[] = [
  "Start a worker for regeneration",
  "Wait for the worker to register",
  "Regenerate the metadata",
  "Collect the metadata patch",
  "Upload the metadata patch",
];

describe("the metadata job", () => {
  test("computes the eligibility from the repository and the branch name", () => {
    expect(recordAt(metadata, "env").METADATA_PATCH_ELIGIBLE).toBe(
      `${OPEN} github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && startsWith(github.event.pull_request.head.ref, 'factory/') }}`,
    );
  });

  test("does not set its own permissions", () => {
    expect("permissions" in metadata).toBe(false);
  });

  test("lets the check step fail without stopping the job", () => {
    expect(
      stepNamed("Check that the metadata is up to date")["continue-on-error"],
    ).toBe(true);
  });

  test("names the check step so the later steps can read its outcome", () => {
    expect(stepNamed("Check that the metadata is up to date").id).toBe("check");
  });

  test.each(GATED_STEPS)("%s runs only after a failed check", (name) => {
    expect(String(stepNamed(name).if)).toContain(FAILED);
  });

  test.each(GATED_STEPS)(
    "%s runs only for an eligible pull request",
    (name) => {
      expect(String(stepNamed(name).if)).toContain(ELIGIBLE);
    },
  );

  test("collects only after the regeneration succeeded", () => {
    expect(String(stepNamed("Collect the metadata patch").if)).toContain(
      "steps.regenerate.outcome == 'success'",
    );
  });

  test("uploads only after the collection succeeded", () => {
    expect(String(stepNamed("Upload the metadata patch").if)).toContain(
      "steps.collect.outcome == 'success'",
    );
  });

  test("lets the regeneration fail without stopping the job", () => {
    expect(stepNamed("Regenerate the metadata")["continue-on-error"]).toBe(
      true,
    );
  });

  test("regenerates with the same task a person runs", () => {
    expect(stepNamed("Regenerate the metadata").run).toBe("mise run metadata");
  });

  test("starts the worker and waits until it is healthy", () => {
    expect(stepNamed("Start a worker for regeneration").run).toBe(
      "mise exec -- docker compose up -d --wait windmill_worker_ci",
    );
  });

  test("passes the commits to the collection through the environment", () => {
    expect(recordAt(stepNamed("Collect the metadata patch"), "env")).toEqual({
      HEAD_SHA: `${OPEN} github.event.pull_request.head.sha }}`,
      BASE_SHA: `${OPEN} github.event.pull_request.base.sha }}`,
      MERGE_SHA: `${OPEN} github.sha }}`,
    });
  });

  test("waits for the worker to register after starting it", () => {
    expect(stepNamed("Wait for the worker to register").run).toBe(
      "mise exec -- scripts/ci-metadata-wait-worker.sh",
    );
  });

  test("waits for the worker after it starts", () => {
    expect(indexOfStep("Wait for the worker to register")).toBe(
      indexOfStep("Start a worker for regeneration") + 1,
    );
  });

  test("allows twenty-five minutes for the whole job", () => {
    expect(metadata["timeout-minutes"]).toBe(25);
  });

  test("limits the regeneration step so the job timeout is not the first to fire", () => {
    expect(stepNamed("Regenerate the metadata")["timeout-minutes"]).toBe(8);
  });

  test("collects into a folder outside the checkout", () => {
    expect(stepNamed("Collect the metadata patch").run).toBe(
      'mise exec -- bun ./scripts/metadata-patch.ts "$RUNNER_TEMP/metadata-patch"',
    );
  });

  test("uploads the artifact named metadata-patch", () => {
    expect(recordAt(stepNamed("Upload the metadata patch"), "with").name).toBe(
      "metadata-patch",
    );
  });

  test("uploads from the folder the collection wrote", () => {
    expect(recordAt(stepNamed("Upload the metadata patch"), "with").path).toBe(
      `${OPEN} runner.temp }}/metadata-patch/`,
    );
  });

  test("keeps the artifact for seven days", () => {
    expect(
      recordAt(stepNamed("Upload the metadata patch"), "with")[
        "retention-days"
      ],
    ).toBe(7);
  });

  test("fails the upload when the folder is empty", () => {
    expect(
      recordAt(stepNamed("Upload the metadata patch"), "with")[
        "if-no-files-found"
      ],
    ).toBe("error");
  });

  test("pins the upload action to the same commit as console-dist.yml", () => {
    const consoleSteps = stepsOf(
      recordAt(recordAt(consoleDist, "jobs"), "build"),
    );
    const consoleUpload = consoleSteps.find(
      (step) => step.name === "Upload the console build",
    );

    expect(stepNamed("Upload the metadata patch").uses).toBe(
      consoleUpload?.uses,
    );
  });

  test("fails the job when the check failed", () => {
    expect(stepNamed("Fail because the metadata is stale").if).toBe(
      `${OPEN} !cancelled() && steps.check.outcome == 'failure' }}`,
    );
  });

  test("exits with a failure in the final step", () => {
    expect(
      String(stepNamed("Fail because the metadata is stale").run),
    ).toContain("exit 1");
  });

  test("fails the job after the patch is uploaded", () => {
    expect(indexOfStep("Fail because the metadata is stale")).toBeGreaterThan(
      indexOfStep("Upload the metadata patch"),
    );
  });

  test("tears down the stack last", () => {
    expect(steps.at(-1)?.name).toBe("Tear down Windmill");
  });

  test("shows diagnostics after a failed check even though the step continued", () => {
    expect(String(stepNamed("Show diagnostics").if)).toContain(FAILED);
  });

  test("never expands an expression inside a shell script", () => {
    const withExpression = steps
      .filter((step) => typeof step.run === "string")
      .filter((step) => String(step.run).includes(OPEN))
      .map((step) => step.name);

    expect(withExpression).toEqual([]);
  });
});

describe("the artifacts of ci.yml", () => {
  test("uploads only the metadata patch", () => {
    const names: unknown[] = [];
    for (const job of Object.values(recordAt(ci, "jobs"))) {
      if (!isRecord(job)) {
        continue;
      }
      for (const step of stepsOf(job)) {
        if (
          typeof step.uses === "string" &&
          step.uses.startsWith("actions/upload-artifact@")
        ) {
          names.push(recordAt(step, "with").name);
        }
      }
    }

    expect(names).toEqual(["metadata-patch"]);
  });
});
