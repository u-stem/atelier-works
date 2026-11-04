import { describe, expect, test } from "bun:test";
import type { DeployApproval } from "../../f/factory/lib/deploy_approvals.ts";
import {
  buildDeployApprovalNotice,
  DEPLOY_APPROVAL_NEXT_ACTION,
  type DeployApprovalEvent,
  type DeployGateDeps,
  decideProtectedDeploy,
  isDeployScopedPath,
  parseNameStatus,
  runDeployApprovalGate,
  selectProtectedChanges,
} from "../../f/factory/lib/deploy_gate.ts";
import type { ChangedPath } from "../../f/factory/lib/protected_paths.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const PROTECTED: ChangedPath = {
  path: "f/factory/self_update.ts",
  status: "modified",
};
const ORDINARY: ChangedPath = {
  path: "docs/operations.md",
  status: "modified",
};

function approval(decision: DeployApproval["decision"]): DeployApproval {
  return {
    sha: SHA,
    protected_paths: [PROTECTED.path],
    requested_at: "2026-11-05T01:00:00.000Z",
    decided_at: decision === null ? null : "2026-11-05T02:00:00.000Z",
    decision,
    decided_by: decision === null ? null : "human",
  };
}

type Recorded = {
  requested: (readonly string[])[];
  superseded: number;
  notices: { kind: string; message: string }[];
  events: DeployApprovalEvent[];
  warnings: string[];
  order: string[];
};

function deps(overrides: Partial<DeployGateDeps> = {}): {
  deps: DeployGateDeps;
  recorded: Recorded;
} {
  const recorded: Recorded = {
    requested: [],
    superseded: 0,
    notices: [],
    events: [],
    warnings: [],
    order: [],
  };
  const base: DeployGateDeps = {
    listChanges: () => Promise.resolve([PROTECTED, ORDINARY]),
    findApproval: () => Promise.resolve(null),
    requestApproval: (_sha, paths) => {
      recorded.requested.push(paths);
      recorded.order.push("request");
      return Promise.resolve(true);
    },
    supersedeNotices: () => {
      recorded.superseded += 1;
      recorded.order.push("supersede");
      return Promise.resolve(0);
    },
    addNotice: (record) => {
      recorded.notices.push({ kind: record.kind, message: record.message });
      recorded.order.push("notice");
      return Promise.resolve(41);
    },
    notify: (event) => {
      recorded.events.push(event);
      recorded.order.push("notify");
      return Promise.resolve();
    },
    noticeUrl: (id) => `https://factory.example/console/?notice=${String(id)}`,
    instanceName: "local",
    log: {
      info: () => undefined,
      warn: (message) => {
        recorded.warnings.push(message);
      },
    },
  };
  return { deps: { ...base, ...overrides }, recorded };
}

describe("parseNameStatus", () => {
  test("returns nothing for an empty output", () => {
    expect(parseNameStatus("")).toEqual([]);
  });

  test("reads a status and a path", () => {
    expect(parseNameStatus("M\0f/factory/self_update.ts\0")).toEqual([
      { path: "f/factory/self_update.ts", status: "modified" },
    ]);
  });

  test.each([
    ["A", "added"],
    ["M", "modified"],
    ["D", "deleted"],
    ["T", "typechange"],
  ] as const)("reads the status %s as %s", (letter, status) => {
    expect(parseNameStatus(`${letter}\0a.ts\0`)[0]?.status).toBe(status);
  });

  test.each(["U", "X", "R100", "C75", "", "MM"])(
    "throws on the status %p, which is not A, M, D or T",
    (letter) => {
      expect(() => parseNameStatus(`${letter}\0a.ts\0`)).toThrow(
        /unexpected status/,
      );
    },
  );

  test("keeps a path with a newline in it", () => {
    expect(parseNameStatus("A\0a\nb.sh\0")[0]?.path).toBe("a\nb.sh");
  });

  test("throws on an odd number of fields", () => {
    expect(() => parseNameStatus("M\0a.ts\0D\0")).toThrow(/odd/);
  });

  test("throws on an empty path", () => {
    expect(() => parseNameStatus("M\0\0")).toThrow(/empty path/);
  });
});

describe("isDeployScopedPath", () => {
  test.each([
    "f/factory/lib/claude.ts",
    "f/factory/self_update.script.yaml",
    "migrations/datatable/main/x.up.sql",
    "wmill.yaml",
  ])("puts %s in the scope of the deployment", (path) => {
    expect(isDeployScopedPath(path)).toBe(true);
  });

  test.each([
    "infra/worker/Dockerfile",
    ".github/workflows/ci.yml",
    ".claude/skills/hold/SKILL.md",
    "scripts/hold.ts",
    "bun.lock",
    "package.json",
    "mise.toml",
    "wmill-lock.yaml",
    "f/factory/lib/claude.script.lock",
    "sub/wmill.yaml",
  ])("leaves %s out of the scope of the deployment", (path) => {
    expect(isDeployScopedPath(path)).toBe(false);
  });
});

describe("selectProtectedChanges", () => {
  test("gates f/factory/lib/claude.ts", () => {
    expect(
      selectProtectedChanges([
        { path: "f/factory/lib/claude.ts", status: "modified" },
      ]),
    ).toEqual(["f/factory/lib/claude.ts"]);
  });

  test("leaves out an ordinary path", () => {
    expect(selectProtectedChanges([ORDINARY])).toEqual([]);
  });

  test("does not gate an unprotected file under f/", () => {
    expect(
      selectProtectedChanges([
        { path: "f/factory/lib/config.ts", status: "modified" },
      ]),
    ).toEqual([]);
  });

  test("does not gate a change under infra/, which a person applies with mise run up", () => {
    expect(
      selectProtectedChanges([
        { path: "infra/worker/Dockerfile", status: "modified" },
      ]),
    ).toEqual([]);
  });

  test("does not gate a bun.lock change", () => {
    expect(
      selectProtectedChanges([{ path: "bun.lock", status: "modified" }]),
    ).toEqual([]);
  });

  test("does not gate a change to the agent settings", () => {
    expect(
      selectProtectedChanges([
        { path: ".claude/skills/hold/SKILL.md", status: "modified" },
      ]),
    ).toEqual([]);
  });

  test("does not gate wmill-lock.yaml", () => {
    expect(
      selectProtectedChanges([{ path: "wmill-lock.yaml", status: "modified" }]),
    ).toEqual([]);
  });

  test("does not gate the lock of a protected script", () => {
    expect(
      selectProtectedChanges([
        { path: "f/factory/self_update.script.lock", status: "modified" },
      ]),
    ).toEqual([]);
  });

  test("gates wmill.yaml", () => {
    expect(
      selectProtectedChanges([{ path: "wmill.yaml", status: "modified" }]),
    ).toEqual(["wmill.yaml"]);
  });

  test("gates any migration, which self_update applies by itself", () => {
    expect(
      selectProtectedChanges([
        { path: "migrations/datatable/main/x.up.sql", status: "added" },
      ]),
    ).toEqual(["migrations/datatable/main/x.up.sql"]);
  });

  test("selects a deleted protected path", () => {
    expect(
      selectProtectedChanges([
        { path: "f/factory/lib/claude.ts", status: "deleted" },
      ]),
    ).toEqual(["f/factory/lib/claude.ts"]);
  });

  test("gates a new shell script under f/", () => {
    expect(
      selectProtectedChanges([
        { path: "f/factory/tools/run.sh", status: "added" },
      ]),
    ).toEqual(["f/factory/tools/run.sh"]);
  });

  test("does not gate a new shell script outside the deployment", () => {
    expect(
      selectProtectedChanges([{ path: "tools/run.sh", status: "added" }]),
    ).toEqual([]);
  });

  test("does not gate a modified shell script under f/ outside the protected paths", () => {
    expect(
      selectProtectedChanges([
        { path: "f/factory/tools/run.sh", status: "modified" },
      ]),
    ).toEqual([]);
  });

  test("lists a path once", () => {
    expect(selectProtectedChanges([PROTECTED, PROTECTED])).toEqual([
      PROTECTED.path,
    ]);
  });
});

describe("decideProtectedDeploy", () => {
  test("proceeds when no protected path changed", () => {
    expect(
      decideProtectedDeploy({ protectedPaths: [], approval: null }),
    ).toEqual({
      kind: "proceed",
    });
  });

  test("holds and asks for an approval when no request exists", () => {
    expect(
      decideProtectedDeploy({
        protectedPaths: [PROTECTED.path],
        approval: null,
      }),
    ).toEqual({
      kind: "hold",
      reason: "protected_paths_approval",
      request: true,
    });
  });

  test("proceeds when the request was approved", () => {
    expect(
      decideProtectedDeploy({
        protectedPaths: [PROTECTED.path],
        approval: approval("approved"),
      }),
    ).toEqual({ kind: "proceed" });
  });

  test("holds without a new request while the request waits", () => {
    expect(
      decideProtectedDeploy({
        protectedPaths: [PROTECTED.path],
        approval: approval(null),
      }),
    ).toEqual({
      kind: "hold",
      reason: "protected_paths_approval",
      request: false,
    });
  });

  test("holds without a new request when the request was rejected", () => {
    expect(
      decideProtectedDeploy({
        protectedPaths: [PROTECTED.path],
        approval: approval("rejected"),
      }),
    ).toEqual({
      kind: "hold",
      reason: "protected_paths_approval",
      request: false,
    });
  });
});

describe("buildDeployApprovalNotice", () => {
  test("uses the notice kind of the approval", () => {
    expect(buildDeployApprovalNotice(SHA, 2).notice.kind).toBe(
      "deploy_approval_required",
    );
  });

  test("starts the message with the prefix of the sha", () => {
    expect(
      buildDeployApprovalNotice(SHA, 2).notice.message.startsWith(
        `反映を待つ版: ${SHA}。`,
      ),
    ).toBe(true);
  });

  test("ends the message with the next action", () => {
    expect(
      buildDeployApprovalNotice(SHA, 2).notice.message.endsWith(
        `次の操作: ${DEPLOY_APPROVAL_NEXT_ACTION}`,
      ),
    ).toBe(true);
  });

  test("keeps the paths out of the message, so that the same sha gives the same message", () => {
    expect(buildDeployApprovalNotice(SHA, 2).notice.message).not.toContain(
      "self_update.ts",
    );
  });
});

describe("runDeployApprovalGate", () => {
  test("proceeds without reading the approvals when no protected path changed", async () => {
    let read = false;
    const { deps: gate } = deps({
      listChanges: () => Promise.resolve([ORDINARY]),
      findApproval: () => {
        read = true;
        return Promise.resolve(null);
      },
    });
    const result = await runDeployApprovalGate(SHA, gate);
    expect({ kind: result.kind, read }).toEqual({
      kind: "proceed",
      read: false,
    });
  });

  test("proceeds when the sha was approved", async () => {
    const { deps: gate } = deps({
      findApproval: () => Promise.resolve(approval("approved")),
    });
    expect((await runDeployApprovalGate(SHA, gate)).kind).toBe("proceed");
  });

  test("holds when no request exists", async () => {
    const { deps: gate } = deps();
    expect((await runDeployApprovalGate(SHA, gate)).kind).toBe("hold");
  });

  test("requests an approval with the protected paths only", async () => {
    const { deps: gate, recorded } = deps();
    await runDeployApprovalGate(SHA, gate);
    expect(recorded.requested).toEqual([[PROTECTED.path]]);
  });

  test("resolves the older notices before it raises the new one", async () => {
    const { deps: gate, recorded } = deps();
    await runDeployApprovalGate(SHA, gate);
    expect(recorded.order).toEqual([
      "request",
      "supersede",
      "notice",
      "notify",
    ]);
  });

  test("sends the notice url and the cause to Discord", async () => {
    const { deps: gate, recorded } = deps();
    await runDeployApprovalGate(SHA, gate);
    expect(recorded.events).toEqual([
      {
        kind: "deploy_approval_required",
        instance_name: "local",
        cause: buildDeployApprovalNotice(SHA, 1).cause,
        next_action: DEPLOY_APPROVAL_NEXT_ACTION,
        url: "https://factory.example/console/?notice=41",
      },
    ]);
  });

  test("does not notify Discord when the same notice is already open", async () => {
    const { deps: gate, recorded } = deps({
      addNotice: () => Promise.resolve(null),
    });
    await runDeployApprovalGate(SHA, gate);
    expect(recorded.events).toEqual([]);
  });

  test("raises no notice when another run created the request first", async () => {
    const { deps: gate, recorded } = deps({
      requestApproval: () => Promise.resolve(false),
    });
    await runDeployApprovalGate(SHA, gate);
    expect(recorded.notices).toEqual([]);
  });

  test("raises no notice while the request waits", async () => {
    const { deps: gate, recorded } = deps({
      findApproval: () => Promise.resolve(approval(null)),
    });
    await runDeployApprovalGate(SHA, gate);
    expect({
      requested: recorded.requested,
      notices: recorded.notices,
    }).toEqual({
      requested: [],
      notices: [],
    });
  });

  test("holds even when the notice cannot be recorded", async () => {
    const { deps: gate } = deps({
      addNotice: () => Promise.reject(new Error("db down")),
    });
    expect((await runDeployApprovalGate(SHA, gate)).kind).toBe("hold");
  });

  test("holds even when Discord fails", async () => {
    const { deps: gate } = deps({
      notify: () => Promise.reject(new Error("429")),
    });
    expect((await runDeployApprovalGate(SHA, gate)).kind).toBe("hold");
  });

  test("holds even when the older notices cannot be resolved", async () => {
    const { deps: gate } = deps({
      supersedeNotices: () => Promise.reject(new Error("db down")),
    });
    expect((await runDeployApprovalGate(SHA, gate)).kind).toBe("hold");
  });

  test("throws when the changes cannot be listed", async () => {
    const { deps: gate } = deps({
      listChanges: () => Promise.reject(new Error("git failed")),
    });
    await expect(runDeployApprovalGate(SHA, gate)).rejects.toThrow(
      /git failed/,
    );
  });

  test("throws when the approval cannot be read", async () => {
    const { deps: gate } = deps({
      findApproval: () => Promise.reject(new Error("db down")),
    });
    await expect(runDeployApprovalGate(SHA, gate)).rejects.toThrow(/db down/);
  });

  test("throws when the request cannot be written", async () => {
    const { deps: gate } = deps({
      requestApproval: () => Promise.reject(new Error("db down")),
    });
    await expect(runDeployApprovalGate(SHA, gate)).rejects.toThrow(/db down/);
  });
});
