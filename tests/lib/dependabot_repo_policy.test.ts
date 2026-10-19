import { describe, expect, test } from "bun:test";
import {
  MAX_REQUIRED_CHECKS,
  REQUIRED_CHECKS,
  requiredChecksFromRules,
  resolveRepoPolicy,
} from "../../f/factory/lib/dependabot_support.ts";

const FACTORY_REPO = "https://github.com/Acme/Factory";

function config(others: readonly string[] = []) {
  return { factory_repo: FACTORY_REPO, dependabot_other_repos: others };
}

function rule(
  checks: readonly { context: unknown; integration_id?: unknown }[],
) {
  return {
    type: "required_status_checks",
    parameters: { required_status_checks: checks },
  };
}

describe("resolveRepoPolicy", () => {
  test("treats the factory repository as primary with the default config", () => {
    expect(resolveRepoPolicy(config(), "Acme", "Factory")).toBe("primary");
  });

  test("ignores case when matching the factory repository", () => {
    expect(resolveRepoPolicy(config(), "acme", "factory")).toBe("primary");
  });

  test("keeps the factory repository primary even when it is also listed", () => {
    expect(resolveRepoPolicy(config(["acme/factory"]), "acme", "factory")).toBe(
      "primary",
    );
  });

  test("treats a listed repository as other", () => {
    expect(resolveRepoPolicy(config(["acme/widgets"]), "acme", "widgets")).toBe(
      "other",
    );
  });

  test("ignores case when matching a listed repository", () => {
    expect(resolveRepoPolicy(config(["Acme/Widgets"]), "acme", "widgets")).toBe(
      "other",
    );
  });

  test("treats an unlisted repository as off", () => {
    expect(resolveRepoPolicy(config(), "acme", "widgets")).toBe("off");
  });

  test("does not match a repository whose name only starts with a listed name", () => {
    expect(
      resolveRepoPolicy(config(["acme/widgets"]), "acme", "widgets-extra"),
    ).toBe("off");
  });

  test("does not match a listed name that is only a suffix", () => {
    expect(
      resolveRepoPolicy(config(["acme/widgets"]), "acme", "old-widgets"),
    ).toBe("off");
  });

  test("treats every repository as off when the factory repository url is unreadable", () => {
    expect(
      resolveRepoPolicy(
        { factory_repo: "not a url", dependabot_other_repos: [] },
        "acme",
        "factory",
      ),
    ).toBe("off");
  });
});

describe("requiredChecksFromRules", () => {
  test("collects the contexts of a required_status_checks rule", () => {
    expect(
      requiredChecksFromRules([
        rule([{ context: "build" }, { context: "lint" }]),
      ]),
    ).toEqual({ ok: true, checks: ["build", "lint"] });
  });

  test("ignores rules of other types", () => {
    expect(
      requiredChecksFromRules([
        { type: "deletion" },
        rule([{ context: "build" }]),
      ]),
    ).toEqual({ ok: true, checks: ["build"] });
  });

  test("merges the contexts of several rules without duplicates", () => {
    expect(
      requiredChecksFromRules([
        rule([{ context: "build" }]),
        rule([{ context: "build" }, { context: "lint" }]),
      ]),
    ).toEqual({ ok: true, checks: ["build", "lint"] });
  });

  test("accepts an integration id of GitHub Actions", () => {
    expect(
      requiredChecksFromRules([
        rule([{ context: "build", integration_id: 15368 }]),
      ]),
    ).toEqual({ ok: true, checks: ["build"] });
  });

  test("accepts a null integration id", () => {
    expect(
      requiredChecksFromRules([
        rule([{ context: "build", integration_id: null }]),
      ]),
    ).toEqual({ ok: true, checks: ["build"] });
  });

  test("fails when a check is bound to another app", () => {
    expect(
      requiredChecksFromRules([
        rule([{ context: "build", integration_id: 42 }]),
      ]).ok,
    ).toBe(false);
  });

  test("fails when there is no required status check", () => {
    expect(requiredChecksFromRules([{ type: "deletion" }]).ok).toBe(false);
  });

  test("fails when the rules are not an array", () => {
    expect(requiredChecksFromRules({}).ok).toBe(false);
  });

  test("fails when a rule is not an object", () => {
    expect(requiredChecksFromRules(["x"]).ok).toBe(false);
  });

  test("fails when the parameters are malformed", () => {
    expect(
      requiredChecksFromRules([
        { type: "required_status_checks", parameters: {} },
      ]).ok,
    ).toBe(false);
  });

  test("fails on a context that is not a string", () => {
    expect(requiredChecksFromRules([rule([{ context: 1 }])]).ok).toBe(false);
  });

  test("fails on an empty context", () => {
    expect(requiredChecksFromRules([rule([{ context: "" }])]).ok).toBe(false);
  });

  test("fails on a context with a newline", () => {
    expect(requiredChecksFromRules([rule([{ context: "a\nb" }])]).ok).toBe(
      false,
    );
  });

  test("fails on a context with surrounding spaces", () => {
    expect(requiredChecksFromRules([rule([{ context: " a" }])]).ok).toBe(false);
  });

  test("fails on a context longer than 100 characters", () => {
    expect(
      requiredChecksFromRules([rule([{ context: "a".repeat(101) }])]).ok,
    ).toBe(false);
  });

  test("accepts a context of exactly 100 characters", () => {
    expect(
      requiredChecksFromRules([rule([{ context: "a".repeat(100) }])]).ok,
    ).toBe(true);
  });

  test("fails when there are more contexts than the limit", () => {
    const many = Array.from({ length: MAX_REQUIRED_CHECKS + 1 }, (_, i) => ({
      context: `job-${String(i)}`,
    }));
    expect(requiredChecksFromRules([rule(many)]).ok).toBe(false);
  });

  test("accepts exactly the limit", () => {
    const many = Array.from({ length: MAX_REQUIRED_CHECKS }, (_, i) => ({
      context: `job-${String(i)}`,
    }));
    expect(requiredChecksFromRules([rule(many)]).ok).toBe(true);
  });

  test("freezes the returned checks", () => {
    const result = requiredChecksFromRules([rule([{ context: "build" }])]);
    expect(result.ok && Object.isFrozen(result.checks)).toBe(true);
  });

  test("never puts a rule value in the failure reason", () => {
    const result = requiredChecksFromRules([rule([{ context: "evil\nname" }])]);
    expect(!result.ok && result.reason.includes("evil")).toBe(false);
  });
});

describe("REQUIRED_CHECKS for the primary repository", () => {
  test("stays the seven literal check names", () => {
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
