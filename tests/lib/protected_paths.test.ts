import { describe, expect, test } from "bun:test";
import {
  FORBIDDEN_PATH_PREFIXES,
  IMPLEMENT_PROTECTED_PATH_PREFIXES,
  isNewShellScript,
  matchesForbiddenPath,
} from "../../f/factory/lib/protected_paths.ts";
// Namespace import (not a renamed named import) so the pre-commit
// no-type-assertions lint's token heuristic — which special-cases
// `import * as name` but not `{ name as alias }` — does not false-positive
// on this `as`.
import * as prWorkflowSupport from "../../f/factory/steps/pr_workflow_support.ts";

describe("IMPLEMENT_PROTECTED_PATH_PREFIXES", () => {
  test("adds infra/ on top of the pr_fix prefixes", () => {
    expect(IMPLEMENT_PROTECTED_PATH_PREFIXES).toEqual([
      ...FORBIDDEN_PATH_PREFIXES,
      "infra/",
    ]);
  });

  test("leaves the pr_fix list itself without infra/", () => {
    expect(FORBIDDEN_PATH_PREFIXES).not.toContain("infra/");
  });
});

describe("matchesForbiddenPath", () => {
  test("does not match infra/** with the default (pr_fix) prefixes", () => {
    expect(matchesForbiddenPath("infra/worker/Dockerfile")).toBe(false);
  });

  test("matches infra/** with the implement prefixes", () => {
    expect(
      matchesForbiddenPath(
        "infra/worker/Dockerfile",
        IMPLEMENT_PROTECTED_PATH_PREFIXES,
      ),
    ).toBe(true);
  });

  test("matches the bare infra directory entry with the implement prefixes", () => {
    expect(
      matchesForbiddenPath("infra", IMPLEMENT_PROTECTED_PATH_PREFIXES),
    ).toBe(true);
  });

  test("does not match a path that merely starts with the letters infra", () => {
    expect(
      matchesForbiddenPath(
        "infrastructure/notes.md",
        IMPLEMENT_PROTECTED_PATH_PREFIXES,
      ),
    ).toBe(false);
  });

  test("still matches a basename pattern regardless of the prefix list", () => {
    expect(
      matchesForbiddenPath(
        "packages/app/lefthook.yml",
        IMPLEMENT_PROTECTED_PATH_PREFIXES,
      ),
    ).toBe(true);
  });

  test("strips a leading ./ before matching", () => {
    expect(matchesForbiddenPath("./.claude/settings.json")).toBe(true);
  });

  test("is the same function pr_workflow_support.ts re-exports", () => {
    expect(prWorkflowSupport.matchesForbiddenPath).toBe(matchesForbiddenPath);
  });
});

describe("isNewShellScript", () => {
  test("matches an added .SH file case-insensitively", () => {
    expect(isNewShellScript({ path: "bin/RUN.SH", status: "added" })).toBe(
      true,
    );
  });
});
