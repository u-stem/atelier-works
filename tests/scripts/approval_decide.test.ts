import { describe, expect, test } from "bun:test";
import {
  type ApprovalDecideDeps,
  assertIssueMatchesIntake,
  assertValidApprovalDecideInput,
  checkIssueAgainstIntake,
  decideApproval,
  type IssueCheckDeps,
  missingApprovalRequestMessage,
} from "../../f/factory/approval_decide.ts";
import type { FetchLike } from "../../f/factory/lib/github.ts";
import type { ApprovalRequest } from "../../f/factory/lib/types.ts";

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

  test("explains the limit of regenerations when a design could not be compared", async () => {
    const { deps } = checkDeps({ fetchFn: () => issueResponse(500, {}) });
    await expect(
      assertIssueMatchesIntake(5, 9, deps, "design"),
    ).rejects.toThrow("max_design_attempts");
  });

  test("keeps the sentence of requirements when no kind is passed", async () => {
    const { deps } = checkDeps({ fetchFn: () => issueResponse(500, {}) });
    const message = await assertIssueMatchesIntake(5, 9, deps).catch((err) =>
      String(err),
    );
    expect(message).not.toContain("max_design_attempts");
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

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 5,
    kind: "requirements",
    work_item_id: 9,
    subject_id: 1,
    status: "pending",
    payload: {},
    decision_options: {},
    requested_at: new Date("2026-10-26T00:00:00Z"),
    expires_at: null,
    decided_at: null,
    decided_by: null,
    reason: null,
    ...overrides,
  };
}

/** 呼び出しの順を控える偽の依存。 */
function decideHarness(
  row: ApprovalRequest | null,
  overrides: Partial<ApprovalDecideDeps> = {},
) {
  const events: string[] = [];
  const deps: ApprovalDecideDeps = {
    getApprovalRequest: async () => {
      events.push("get");
      return row;
    },
    assertIssueMatchesIntake: async () => {
      events.push("issue_check");
    },
    deriveApprover: () => "alice",
    decideIfPending: async () => {
      events.push("decide");
      return true;
    },
    runHandler: async (path) => {
      events.push(`run:${path}`);
      return "job-1";
    },
    ...overrides,
  };
  return { deps, events };
}

const APPROVE = {
  approval_request_id: 5,
  decision: "approve",
  reason: "",
  note: "",
  options: {},
} as const;

const REJECT = { ...APPROVE, decision: "reject", reason: "no" } as const;

describe("decideApproval and the handler of the kind", () => {
  test("refuses a pending design request without recording the decision", async () => {
    const h = decideHarness(request({ kind: "design" }));
    await decideApproval(h.deps, APPROVE).catch(() => undefined);
    expect(h.events).toEqual(["get"]);
  });

  test("names the missing handler when it refuses a design request", async () => {
    const h = decideHarness(request({ kind: "design" }));
    await expect(decideApproval(h.deps, APPROVE)).rejects.toThrow(
      "no approval handler for kind design",
    );
  });

  test("refuses a design request that was already decided before it dispatches again", async () => {
    const h = decideHarness(request({ kind: "design", status: "approved" }));
    await decideApproval(h.deps, APPROVE).catch(() => undefined);
    expect(h.events).toEqual(["get"]);
  });

  test("looks up the handler before it compares the recorded decision", async () => {
    const h = decideHarness(request({ kind: "design", status: "approved" }));
    await expect(decideApproval(h.deps, REJECT)).rejects.toThrow(
      "no approval handler for kind design",
    );
  });

  test("does not check the issue for a design request", async () => {
    const h = decideHarness(request({ kind: "design" }));
    await decideApproval(h.deps, APPROVE).catch(() => undefined);
    expect(h.events).not.toContain("issue_check");
  });
});

describe("decideApproval for the kinds that have a handler", () => {
  test("checks the issue, records the decision, then starts the handler for an approval of requirements", async () => {
    const h = decideHarness(request());
    await decideApproval(h.deps, APPROVE);
    expect(h.events).toEqual([
      "get",
      "issue_check",
      "decide",
      "run:f/factory/steps/requirements_apply",
    ]);
  });

  test("does not check the issue for a rejection of requirements", async () => {
    const h = decideHarness(request());
    await decideApproval(h.deps, REJECT);
    expect(h.events).toEqual([
      "get",
      "decide",
      "run:f/factory/steps/requirements_apply",
    ]);
  });

  test("starts the handler of an issue proposal", async () => {
    const h = decideHarness(request({ kind: "issue_proposal" }));
    await decideApproval(h.deps, APPROVE);
    expect(h.events).toEqual([
      "get",
      "decide",
      "run:f/factory/steps/issue_proposal_apply",
    ]);
  });

  test("starts the handler again without recording when the same decision is already recorded", async () => {
    const h = decideHarness(request({ status: "approved" }));
    await decideApproval(h.deps, APPROVE);
    expect(h.events).toEqual(["get", "run:f/factory/steps/requirements_apply"]);
  });

  test("refuses a different decision than the recorded one", async () => {
    const h = decideHarness(request({ status: "approved" }));
    await expect(decideApproval(h.deps, REJECT)).rejects.toThrow(
      "refusing to overwrite it",
    );
  });

  test("passes the kind of the request to the issue check", async () => {
    const kinds: string[] = [];
    const h = decideHarness(request(), {
      assertIssueMatchesIntake: async (_requestId, _workItemId, kind) => {
        kinds.push(kind);
      },
    });
    await decideApproval(h.deps, APPROVE);
    expect(kinds).toEqual(["requirements"]);
  });

  test("does not start the handler when the issue check refuses", async () => {
    const h = decideHarness(request(), {
      assertIssueMatchesIntake: async () => {
        throw new Error("issue changed");
      },
    });
    await decideApproval(h.deps, APPROVE).catch(() => undefined);
    expect(h.events).toEqual(["get"]);
  });

  test("reads the row again and classifies it when another call recorded first", async () => {
    let reads = 0;
    const h = decideHarness(request(), {
      getApprovalRequest: async () => {
        reads += 1;
        return reads === 1 ? request() : request({ status: "approved" });
      },
      decideIfPending: async () => false,
    });
    await decideApproval(h.deps, APPROVE);
    expect(reads).toBe(2);
  });

  test("returns the status that was recorded and the job id", async () => {
    const h = decideHarness(request());
    expect(await decideApproval(h.deps, APPROVE)).toEqual({
      ok: true,
      status: "approved",
      job_id: "job-1",
    });
  });

  test("throws when the request does not exist", async () => {
    const h = decideHarness(null);
    await expect(decideApproval(h.deps, APPROVE)).rejects.toThrow(
      missingApprovalRequestMessage(5),
    );
  });
});
