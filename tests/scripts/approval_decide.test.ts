import { describe, expect, test } from "bun:test";
import {
  assertIssueMatchesIntake,
  assertValidApprovalDecideInput,
  checkBeforeRecording,
  checkIssueAgainstIntake,
  type IssueCheckDeps,
} from "../../f/factory/approval_decide.ts";
import type { FetchLike } from "../../f/factory/lib/github.ts";

const SNAPSHOT = {
  owner: "o",
  repo: "r",
  issue_number: 42,
  title: "Add feature",
  body: "Original body",
};

const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

function issueResponse(status: number, body: unknown): ReturnType<FetchLike> {
  return Promise.resolve({ status, json: async () => body });
}

function liveIssue(
  overrides: Record<string, unknown> = {},
): ReturnType<FetchLike> {
  return issueResponse(200, {
    title: "Add feature",
    body: "Original body",
    state: "open",
    ...overrides,
  });
}

function checkDeps(overrides: Partial<IssueCheckDeps> = {}): {
  deps: IssueCheckDeps;
  warnings: string[];
} {
  const warnings: string[] = [];
  const deps: IssueCheckDeps = {
    getWorkItem: () => Promise.resolve(SNAPSHOT),
    getToken: () => Promise.resolve(TOKEN),
    fetchFn: () => liveIssue(),
    warn: (message, fields) => {
      warnings.push(`${message} ${JSON.stringify(fields)}`);
    },
    ...overrides,
  };
  return { deps, warnings };
}

describe("checkIssueAgainstIntake", () => {
  test("returns match when the live issue equals the intake content", async () => {
    expect(await checkIssueAgainstIntake(9, checkDeps().deps)).toBe("match");
  });

  test("returns match when only the line endings differ", async () => {
    const { deps } = checkDeps({
      getWorkItem: () => Promise.resolve({ ...SNAPSHOT, body: "a\nb" }),
      fetchFn: () => liveIssue({ body: "a\r\nb" }),
    });
    expect(await checkIssueAgainstIntake(9, deps)).toBe("match");
  });

  test("returns match when only a lone carriage return differs", async () => {
    const { deps } = checkDeps({
      getWorkItem: () => Promise.resolve({ ...SNAPSHOT, body: "a\nb" }),
      fetchFn: () => liveIssue({ body: "a\rb" }),
    });
    expect(await checkIssueAgainstIntake(9, deps)).toBe("match");
  });

  test("returns match when only trailing whitespace of the body differs", async () => {
    const { deps } = checkDeps({
      fetchFn: () => liveIssue({ body: "Original body\n\n" }),
    });
    expect(await checkIssueAgainstIntake(9, deps)).toBe("match");
  });

  test("returns changed when trailing whitespace of a line differs", async () => {
    const { deps } = checkDeps({
      getWorkItem: () => Promise.resolve({ ...SNAPSHOT, body: "a\nb" }),
      fetchFn: () => liveIssue({ body: "a \nb" }),
    });
    expect(await checkIssueAgainstIntake(9, deps)).toBe("changed");
  });

  test("returns changed when the body was rewritten", async () => {
    const { deps } = checkDeps({
      fetchFn: () => liveIssue({ body: "Rewritten body" }),
    });
    expect(await checkIssueAgainstIntake(9, deps)).toBe("changed");
  });

  test("returns changed when the title was rewritten", async () => {
    const { deps } = checkDeps({
      fetchFn: () => liveIssue({ title: "Other title" }),
    });
    expect(await checkIssueAgainstIntake(9, deps)).toBe("changed");
  });

  test.each([301, 302, 404, 403, 500, 502])(
    "returns unavailable for HTTP %d",
    async (status) => {
      const { deps } = checkDeps({ fetchFn: () => issueResponse(status, {}) });
      expect(await checkIssueAgainstIntake(9, deps)).toBe("unavailable");
    },
  );

  test("returns unavailable when the network fails", async () => {
    const { deps } = checkDeps({
      fetchFn: () => Promise.reject(new TypeError("fetch failed")),
    });
    expect(await checkIssueAgainstIntake(9, deps)).toBe("unavailable");
  });

  test("returns unavailable when the deadline passes", async () => {
    const { deps } = checkDeps({
      fetchFn: () =>
        Promise.reject(
          new DOMException("The operation timed out", "TimeoutError"),
        ),
    });
    expect(await checkIssueAgainstIntake(9, deps)).toBe("unavailable");
  });

  test("returns unavailable for a response of the wrong shape", async () => {
    const { deps } = checkDeps({
      fetchFn: () => issueResponse(200, { title: 1 }),
    });
    expect(await checkIssueAgainstIntake(9, deps)).toBe("unavailable");
  });

  test("returns unavailable when the token cannot be read", async () => {
    const { deps } = checkDeps({
      getToken: () => Promise.reject(new Error("no such variable")),
    });
    expect(await checkIssueAgainstIntake(9, deps)).toBe("unavailable");
  });

  test("returns unavailable when the work item is missing", async () => {
    const { deps } = checkDeps({ getWorkItem: () => Promise.resolve(null) });
    expect(await checkIssueAgainstIntake(9, deps)).toBe("unavailable");
  });

  test("returns unavailable when the work item has no issue number", async () => {
    const { deps } = checkDeps({
      getWorkItem: () => Promise.resolve({ ...SNAPSHOT, issue_number: null }),
    });
    expect(await checkIssueAgainstIntake(9, deps)).toBe("unavailable");
  });

  test("does not call GitHub when the work item has no issue number", async () => {
    let calls = 0;
    const { deps } = checkDeps({
      getWorkItem: () => Promise.resolve({ ...SNAPSHOT, issue_number: null }),
      fetchFn: () => {
        calls += 1;
        return liveIssue();
      },
    });
    await checkIssueAgainstIntake(9, deps);
    expect(calls).toBe(0);
  });

  test("reads the issue of the work item from api.github.com", async () => {
    const urls: string[] = [];
    const { deps } = checkDeps({
      fetchFn: (url) => {
        urls.push(url);
        return liveIssue();
      },
    });
    await checkIssueAgainstIntake(9, deps);
    expect(urls).toEqual(["https://api.github.com/repos/o/r/issues/42"]);
  });

  test("keeps the token out of the log", async () => {
    const { deps, warnings } = checkDeps({
      fetchFn: () => Promise.reject(new Error(`failed with ${TOKEN}`)),
    });
    await checkIssueAgainstIntake(9, deps);
    expect(warnings.join("\n")).not.toContain(TOKEN);
  });

  test("keeps the issue text out of the log", async () => {
    const { deps, warnings } = checkDeps({
      fetchFn: () => issueResponse(200, { title: "secret title", body: 1 }),
    });
    await checkIssueAgainstIntake(9, deps);
    expect(warnings.join("\n")).not.toContain("secret title");
  });
});

describe("assertIssueMatchesIntake", () => {
  test("passes when the issue matches the intake content", async () => {
    await expect(
      assertIssueMatchesIntake(5, 9, checkDeps().deps),
    ).resolves.toBeUndefined();
  });

  test("refuses when the issue changed", async () => {
    const { deps } = checkDeps({ fetchFn: () => liveIssue({ body: "x" }) });
    await expect(assertIssueMatchesIntake(5, 9, deps)).rejects.toThrow(
      "changed after intake",
    );
  });

  test("refuses when the issue could not be compared", async () => {
    const { deps } = checkDeps({ fetchFn: () => issueResponse(500, {}) });
    await expect(assertIssueMatchesIntake(5, 9, deps)).rejects.toThrow(
      "try again",
    );
  });

  test("keeps the token out of the refusal", async () => {
    const { deps } = checkDeps({
      fetchFn: () => Promise.reject(new Error(TOKEN)),
    });
    const message = await assertIssueMatchesIntake(5, 9, deps).catch((err) =>
      String(err),
    );
    expect(message).not.toContain(TOKEN);
  });
});

describe("checkBeforeRecording", () => {
  test("does not record when the check refuses", async () => {
    const calls: string[] = [];
    await checkBeforeRecording(
      true,
      async () => {
        throw new Error("refused");
      },
      async () => {
        calls.push("record");
      },
    ).catch(() => {});
    expect(calls).toEqual([]);
  });

  test("passes the refusal on to the caller", async () => {
    const result = checkBeforeRecording(
      true,
      async () => {
        throw new Error("refused");
      },
      async () => {},
    );
    await expect(result).rejects.toThrow("refused");
  });

  test("records after the check passes", async () => {
    const calls: string[] = [];
    await checkBeforeRecording(
      true,
      async () => {
        calls.push("check");
      },
      async () => {
        calls.push("record");
      },
    );
    expect(calls).toEqual(["check", "record"]);
  });

  test("records without a check when none is needed", async () => {
    const calls: string[] = [];
    await checkBeforeRecording(
      false,
      async () => {
        calls.push("check");
      },
      async () => {
        calls.push("record");
      },
    );
    expect(calls).toEqual(["record"]);
  });
});

describe("assertValidApprovalDecideInput", () => {
  test("allows an approve decision with an empty reason", () => {
    expect(() =>
      assertValidApprovalDecideInput({ decision: "approve", reason: "" }),
    ).not.toThrow();
  });

  test("allows a reject decision with a non-empty reason", () => {
    expect(() =>
      assertValidApprovalDecideInput({
        decision: "reject",
        reason: "missing tests",
      }),
    ).not.toThrow();
  });

  test("rejects a reject decision with an empty reason", () => {
    expect(() =>
      assertValidApprovalDecideInput({ decision: "reject", reason: "" }),
    ).toThrow();
  });

  test("rejects a reject decision with a whitespace-only reason", () => {
    expect(() =>
      assertValidApprovalDecideInput({ decision: "reject", reason: "   " }),
    ).toThrow();
  });
});
