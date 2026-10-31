import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LogFields } from "../../f/factory/lib/log.ts";
import type { ManualIntakeRefusalReason } from "../../f/factory/lib/manual_intake_support.ts";
import type { FactoryConfig } from "../../f/factory/lib/types.ts";
import {
  type ManualIntakeSubmitDeps,
  submitManualIntake,
} from "../../f/factory/manual_intake_submit.ts";

const JOB = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

const CONFIG: Pick<
  FactoryConfig,
  "owners" | "repo_allowlist" | "factory_repo"
> = {
  owners: [{ name: "octo-owner", kind: "user" }],
  repo_allowlist: [],
  factory_repo: "https://github.com/octo-owner/atelier-works",
};

const INPUT = {
  owner: "octo-owner",
  repo: "widgets",
  title: "Add a widget",
  body: "Add a widget to the page.",
  acceptance_criteria: "It renders.",
  profile: "standard",
};

type Run = { path: string; args: Record<string, unknown> };
type Logged = { message: string; fields: LogFields | undefined };

type Harness = {
  readonly deps: ManualIntakeSubmitDeps;
  readonly runs: Run[];
  readonly logs: Logged[];
};

function harness(overrides: Partial<ManualIntakeSubmitDeps> = {}): Harness {
  const runs: Run[] = [];
  const logs: Logged[] = [];
  const deps: ManualIntakeSubmitDeps = {
    loadConfig: () => Promise.resolve(CONFIG),
    deriveActor: () => "alice",
    runFlow: (path, args) => {
      runs.push({ path, args });
      return Promise.resolve(JOB);
    },
    log: {
      info: (message, fields) => {
        logs.push({ message, fields });
      },
    },
    ...overrides,
  };
  return { deps, runs, logs };
}

describe("submitManualIntake", () => {
  test("returns the id of the flow job it started", async () => {
    const { deps } = harness();
    expect(await submitManualIntake(INPUT, deps)).toEqual({
      refused: false,
      flow_job_id: JOB,
    });
  });

  test("starts the manual_intake flow", async () => {
    const { deps, runs } = harness();
    await submitManualIntake(INPUT, deps);
    expect(runs.map((run) => run.path)).toEqual(["f/factory/manual_intake"]);
  });

  test("passes exactly the flow inputs", async () => {
    const { deps, runs } = harness();
    await submitManualIntake(INPUT, deps);
    expect(runs[0]?.args).toEqual(INPUT);
  });

  test("passes the trimmed title that it validated", async () => {
    const { deps, runs } = harness();
    await submitManualIntake(
      { ...INPUT, title: `  ${"a".repeat(256)}\t` },
      deps,
    );
    expect(runs[0]?.args.title).toBe("a".repeat(256));
  });

  test("lowercases the job id it returns", async () => {
    const { deps } = harness({
      runFlow: () => Promise.resolve(` ${JOB.toUpperCase()}\n`),
    });
    expect(await submitManualIntake(INPUT, deps)).toEqual({
      refused: false,
      flow_job_id: JOB,
    });
  });

  test("throws when the flow start does not return a job id", async () => {
    const { deps } = harness({
      runFlow: () => Promise.resolve("not a job id"),
    });
    await expect(submitManualIntake(INPUT, deps)).rejects.toThrow();
  });

  test("throws when the flow cannot be started", async () => {
    const { deps } = harness({
      runFlow: () => Promise.reject(new Error("boom")),
    });
    await expect(submitManualIntake(INPUT, deps)).rejects.toThrow("boom");
  });
});

describe("a refusal", () => {
  test("names the reason and nothing from the input", async () => {
    const { deps } = harness();
    expect(
      await submitManualIntake({ ...INPUT, owner: "stranger" }, deps),
    ).toEqual({ refused: true, reason: "repo_not_allowed" });
  });

  const CASES: ReadonlyArray<
    readonly [ManualIntakeRefusalReason, Partial<typeof INPUT>]
  > = [
    ["invalid_owner", { owner: "bad owner" }],
    ["invalid_repo", { repo: "a/b" }],
    ["repo_not_allowed", { owner: "stranger" }],
    ["profile_not_allowed", { profile: "direct" }],
    ["empty_title", { title: "  " }],
    ["title_too_long", { title: "a".repeat(257) }],
    ["invalid_title_chars", { title: "a\u0000b" }],
    ["empty_body", { body: "" }],
    ["invalid_body_chars", { body: "a‮b" }],
    ["body_too_long", { body: "a".repeat(65536) }],
  ];

  test.each(CASES)("is %s for the matching input", async (reason, change) => {
    const { deps } = harness();
    const result = await submitManualIntake({ ...INPUT, ...change }, deps);
    expect(result).toEqual({ refused: true, reason });
  });

  test("does not start the flow", async () => {
    const { deps, runs } = harness();
    await submitManualIntake({ ...INPUT, owner: "stranger" }, deps);
    expect(runs).toEqual([]);
  });

  test("does not start the flow for a profile that is not accepted", async () => {
    const { deps, runs } = harness();
    await submitManualIntake({ ...INPUT, profile: "direct" }, deps);
    expect(runs).toEqual([]);
  });

  test("refuses an empty profile", async () => {
    const { deps } = harness();
    expect(await submitManualIntake({ ...INPUT, profile: "" }, deps)).toEqual({
      refused: true,
      reason: "profile_not_allowed",
    });
  });
});

describe("the profile", () => {
  test("is passed to the flow", async () => {
    const { deps, runs } = harness();
    await submitManualIntake(INPUT, deps);
    expect(runs[0]?.args.profile).toBe("standard");
  });

  test("defaults to standard when the script is called without it", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../f/factory/manual_intake_submit.ts"),
      "utf8",
    );
    expect(source).toMatch(/\bprofile: string = "standard",/);
  });
});

describe("the intake key", () => {
  // フローのジョブIDと違う値にする。ログにキーが無いことを、ジョブIDと取り違えずに確かめるため。
  const INTAKE_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";

  test("is passed to the flow", async () => {
    const { deps, runs } = harness();
    await submitManualIntake({ ...INPUT, intake_key: INTAKE_ID }, deps);
    expect(runs[0]?.args.intake_key).toBe(INTAKE_ID);
  });

  test("is left out of the flow inputs when the caller sends none", async () => {
    const { deps, runs } = harness();
    await submitManualIntake(INPUT, deps);
    expect("intake_key" in (runs[0]?.args ?? {})).toBe(false);
  });

  test("starts the flow for a valid key", async () => {
    const { deps } = harness();
    expect(
      await submitManualIntake({ ...INPUT, intake_key: INTAKE_ID }, deps),
    ).toEqual({ refused: false, flow_job_id: JOB });
  });

  test.each([
    ["an empty string", ""],
    ["upper case letters", INTAKE_ID.toUpperCase()],
    ["a trailing line feed", `${INTAKE_ID}\n`],
    ["a word", "not-a-key"],
  ])("refuses %s as invalid_intake_key", async (_name, intake_key) => {
    const { deps } = harness();
    expect(await submitManualIntake({ ...INPUT, intake_key }, deps)).toEqual({
      refused: true,
      reason: "invalid_intake_key",
    });
  });

  test("starts no flow for a key that is not valid", async () => {
    const { deps, runs } = harness();
    await submitManualIntake({ ...INPUT, intake_key: "not-a-key" }, deps);
    expect(runs).toEqual([]);
  });

  test("is not logged", async () => {
    const { deps, logs } = harness();
    await submitManualIntake({ ...INPUT, intake_key: INTAKE_ID }, deps);
    expect(JSON.stringify(logs)).not.toContain(INTAKE_ID);
  });

  test("is an optional argument of the script", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../f/factory/manual_intake_submit.ts"),
      "utf8",
    );
    expect(source).toMatch(/\bintake_key\?: string/);
  });
});

describe("the actor", () => {
  test("is logged when it can be derived", async () => {
    const { deps, logs } = harness();
    await submitManualIntake(INPUT, deps);
    expect(logs.map((entry) => entry.fields?.actor)).toContain("alice");
  });

  test("is refused as actor_unknown when it cannot be derived", async () => {
    const { deps } = harness({
      deriveActor: () => {
        throw new Error("no identity");
      },
    });
    expect(await submitManualIntake(INPUT, deps)).toEqual({
      refused: true,
      reason: "actor_unknown",
    });
  });

  test("starts no flow when it cannot be derived", async () => {
    const { deps, runs } = harness({
      deriveActor: () => {
        throw new Error("no identity");
      },
    });
    await submitManualIntake(INPUT, deps);
    expect(runs).toEqual([]);
  });

  test("is not logged with the title or the body", async () => {
    const { deps, logs } = harness();
    await submitManualIntake(INPUT, deps);
    expect(JSON.stringify(logs)).not.toContain(INPUT.body);
  });
});
