import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ARTIFACT_NAME,
  CI_WORKFLOW_FILE,
  CI_WORKFLOW_NAME,
  CI_WORKFLOW_PATH,
  WORKFLOW_FILE,
  WORKFLOW_NAME,
  WORKFLOW_PATH,
} from "../../infra/console_fetcher/decide.ts";

const ROOT = join(import.meta.dir, "..", "..");
const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readYaml(path: string): Record<string, unknown> {
  const parsed: unknown = Bun.YAML.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error(`${path} is not an object`);
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

function stepsOf(container: unknown): Record<string, unknown>[] {
  const steps = isRecord(container) ? container.steps : undefined;
  if (!Array.isArray(steps)) {
    throw new Error("no steps");
  }
  return steps.filter(isRecord);
}

function stepNamed(
  steps: readonly Record<string, unknown>[],
  name: string,
): Record<string, unknown> {
  const found = steps.find((step) => step.name === name);
  if (found === undefined) {
    throw new Error(`step not found: ${name}`);
  }
  return found;
}

const consoleDist = readYaml(join(WORKFLOWS_DIR, WORKFLOW_FILE));
const ci = readYaml(join(WORKFLOWS_DIR, CI_WORKFLOW_FILE));

function stepsOfAllJobs(
  document: Record<string, unknown>,
): Record<string, unknown>[] {
  return Object.values(recordAt(document, "jobs")).flatMap((container) =>
    stepsOf(container),
  );
}

function allUses(...documents: readonly Record<string, unknown>[]): string[] {
  const uses: string[] = [];
  for (const document of documents) {
    for (const container of Object.values(recordAt(document, "jobs"))) {
      for (const step of stepsOf(container)) {
        if (typeof step.uses === "string") {
          uses.push(step.uses);
        }
      }
    }
  }
  return uses;
}

describe("console-dist.yml", () => {
  test("lives at the path the console_fetcher accepts", () => {
    expect(existsSync(join(ROOT, WORKFLOW_PATH))).toBe(true);
  });

  test("is named as the console_fetcher expects", () => {
    expect(consoleDist.name).toBe(WORKFLOW_NAME);
  });

  test("runs only on push", () => {
    expect(Object.keys(recordAt(consoleDist, "on"))).toEqual(["push"]);
  });

  test("runs only for pushes to main", () => {
    expect(recordAt(recordAt(consoleDist, "on"), "push")).toEqual({
      branches: ["main"],
    });
  });

  test("grants only contents: read", () => {
    expect(recordAt(consoleDist, "permissions")).toEqual({
      contents: "read",
    });
  });

  test("has a single job", () => {
    expect(Object.keys(recordAt(consoleDist, "jobs"))).toEqual(["build"]);
  });

  test("the job does not widen the permissions", () => {
    expect(
      "permissions" in recordAt(recordAt(consoleDist, "jobs"), "build"),
    ).toBe(false);
  });

  test("never cancels a run that is in progress", () => {
    expect(recordAt(consoleDist, "concurrency")["cancel-in-progress"]).toBe(
      false,
    );
  });

  test("uploads the artifact the console_fetcher reads", () => {
    const steps = stepsOf(recordAt(recordAt(consoleDist, "jobs"), "build"));

    expect(
      recordAt(stepNamed(steps, "Upload the console build"), "with").name,
    ).toBe(ARTIFACT_NAME);
  });

  test("uploads from a single step", () => {
    const steps = stepsOf(recordAt(recordAt(consoleDist, "jobs"), "build"));
    const uploads = steps.filter(
      (step) =>
        typeof step.uses === "string" &&
        step.uses.startsWith("actions/upload-artifact@"),
    );

    expect(uploads).toHaveLength(1);
  });

  test("records the pushed commit in the manifest", () => {
    const steps = stepsOf(recordAt(recordAt(consoleDist, "jobs"), "build"));

    expect(
      recordAt(stepNamed(steps, "Write the release manifest"), "env")
        .SOURCE_SHA,
    ).toBe("$" + "{{ github.sha }}");
  });

  test("runs the lockfile check as a file", () => {
    const steps = stepsOf(recordAt(recordAt(consoleDist, "jobs"), "build"));

    expect(stepNamed(steps, "Check the console lockfile policy").run).toBe(
      "bun ./scripts/check-console-lockfile.ts console/bun.lock",
    );
  });

  test("keeps the build steps in the file instead of a local action", () => {
    const steps = stepsOf(recordAt(recordAt(consoleDist, "jobs"), "build"));
    const local = steps.filter(
      (step) => typeof step.uses === "string" && step.uses.startsWith("./"),
    );

    expect(local).toEqual([]);
  });
});

describe("ci.yml", () => {
  test("lives at the path the console_fetcher accepts", () => {
    expect(existsSync(join(ROOT, CI_WORKFLOW_PATH))).toBe(true);
  });

  test("is named as the console_fetcher expects", () => {
    expect(ci.name).toBe(CI_WORKFLOW_NAME);
  });

  test("runs only on push and pull_request", () => {
    expect(Object.keys(recordAt(ci, "on")).sort()).toEqual([
      "pull_request",
      "push",
    ]);
  });

  test("runs pushes only for the main branch, never for tags", () => {
    expect(recordAt(recordAt(ci, "on"), "push")).toEqual({
      branches: ["main"],
    });
  });

  test("uploads no artifact with the console build's name", () => {
    const consoleUploads = stepsOfAllJobs(ci).filter(
      (step) =>
        typeof step.uses === "string" &&
        step.uses.startsWith("actions/upload-artifact@") &&
        recordAt(step, "with").name === ARTIFACT_NAME,
    );

    expect(consoleUploads).toEqual([]);
  });

  test("builds the console with the same steps as console-dist.yml", () => {
    const build = stepsOf(recordAt(recordAt(consoleDist, "jobs"), "build"));
    const check = stepsOf(recordAt(recordAt(ci, "jobs"), "console"));
    const shared = (steps: readonly Record<string, unknown>[]) =>
      steps.filter(
        (step) =>
          step.name !== "Checkout" && step.name !== "Upload the console build",
      );

    expect(shared(check)).toEqual(shared(build));
  });
});

describe("local actions", () => {
  test("none exist, so no unreviewed file joins the build", () => {
    expect(existsSync(join(ROOT, ".github", "actions"))).toBe(false);
  });
});

describe("every workflow", () => {
  const workflowDocuments = readdirSync(WORKFLOWS_DIR)
    .filter((file) => file.endsWith(".yml"))
    .map((file) => readYaml(join(WORKFLOWS_DIR, file)));

  test("pins each external action to a commit sha", () => {
    const unpinned = allUses(...workflowDocuments)
      .filter((uses) => !uses.startsWith("./"))
      .filter((uses) => !/^[^@]+@[0-9a-f]{40}$/.test(uses));

    expect(unpinned).toEqual([]);
  });
});
