import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `console-a11y`ジョブの配線を、ワークフローの定義から静的に確かめる。
// 実際のGitHub Actionsでは動かせないので、組み立ての手順がconsoleジョブと同じことと、
// ブラウザの取得、失敗時の報告の扱いを確かめる。
// ブラウザは毎回取得する。取得物を照合しないので、mainの実行が書いたキャッシュをPRが読む経路を作らない。
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
const jobs = recordAt(ci, "jobs");
const a11y = recordAt(jobs, "console-a11y");
const consoleJob = recordAt(jobs, "console");
const steps = stepsOf(a11y);
const consoleSteps = stepsOf(consoleJob);

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

function consoleStepNamed(name: string): Record<string, unknown> {
  const found = consoleSteps.find((step) => step.name === name);
  if (found === undefined) {
    throw new Error(`console step not found: ${name}`);
  }
  return found;
}

const SHARED_STEPS: readonly string[] = [
  "Checkout",
  "Setup mise",
  "Install root dependencies",
  "Check the console lockfile policy",
  "Install console dependencies",
  "Build",
];

describe("the console-a11y job", () => {
  test("waits for the scope job", () => {
    expect(a11y.needs).toBe("scope");
  });

  // mainのpushで照合しないブラウザを動かすと、mainの範囲のキャッシュへ書けるトークンが渡る。
  // そのため、consoleジョブの条件に、PRの実行に限る条件を足す。
  test("runs under the console job condition and only for pull requests", () => {
    const base = String(consoleJob.if).replace(/\s*\}\}\s*$/, "");
    expect(a11y.if).toBe(`${base} && github.event_name == 'pull_request' }}`);
  });

  test("has a time limit of 10 minutes", () => {
    expect(a11y["timeout-minutes"]).toBe(10);
  });

  test("sets no permissions of its own", () => {
    expect("permissions" in a11y).toBe(false);
  });

  test("keeps mise from installing tools it does not use", () => {
    expect(recordAt(a11y, "env")).toEqual(recordAt(consoleJob, "env"));
  });

  for (const name of SHARED_STEPS) {
    test(`runs the step "${name}" as the console job does`, () => {
      expect(stepNamed(name)).toEqual(consoleStepNamed(name));
    });
  }

  test("does not keep the checkout credentials", () => {
    expect(recordAt(stepNamed("Checkout"), "with")["persist-credentials"]).toBe(
      false,
    );
  });

  test("installs only bun and node with mise", () => {
    expect(recordAt(stepNamed("Setup mise"), "with").install_args).toBe(
      "bun node",
    );
  });

  test("neither reads nor writes the mise cache", () => {
    expect(recordAt(stepNamed("Setup mise"), "with").cache).toBe(false);
  });

  test("builds the console before it installs the browser", () => {
    expect(indexOfStep("Build")).toBeLessThan(
      indexOfStep("Install the Playwright browser"),
    );
  });

  test("installs the browser before it runs the checks", () => {
    expect(indexOfStep("Install the Playwright browser")).toBeLessThan(
      indexOfStep("Run the accessibility checks"),
    );
  });

  test("uses no cache action", () => {
    expect(
      steps.filter((step) => String(step.uses).startsWith("actions/cache")),
    ).toEqual([]);
  });

  test("does not refer to the Playwright browser directory", () => {
    expect(
      steps.filter((step) =>
        JSON.stringify(step).includes(".cache/ms-playwright"),
      ),
    ).toEqual([]);
  });

  test("has no step that reads the Playwright version for a cache key", () => {
    expect(steps.map((step) => step.name)).not.toContain(
      "Read the Playwright version",
    );
  });

  test("installs the chromium browser with its system packages", () => {
    expect(stepNamed("Install the Playwright browser").run).toBe(
      "bun run --cwd console playwright install --with-deps --only-shell chromium",
    );
  });

  test("runs the checks through the console script", () => {
    expect(stepNamed("Run the accessibility checks").run).toBe(
      "bun run --cwd console test:a11y",
    );
  });

  test("uploads the report only when a step failed", () => {
    expect(stepNamed("Upload the Playwright report").if).toBe(
      `${OPEN} failure() }}`,
    );
  });

  test("pins the upload action to the commit console-dist.yml uses", () => {
    const upload = stepsOf(
      recordAt(recordAt(consoleDist, "jobs"), "build"),
    ).find((step) => step.name === "Upload the console build");

    expect(stepNamed("Upload the Playwright report").uses).toBe(upload?.uses);
  });

  test("keeps the report for a short time", () => {
    expect(
      recordAt(stepNamed("Upload the Playwright report"), "with")[
        "retention-days"
      ],
    ).toBe(3);
  });

  test("uploads nothing but the report directory", () => {
    expect(
      recordAt(stepNamed("Upload the Playwright report"), "with").path,
    ).toBe("console/playwright-report/");
  });
});
