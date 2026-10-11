import { describe, expect, test } from "bun:test";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import {
  buildHostActionNotice,
  extractNoticeSha,
  HOST_ACTION_NOTICE_KIND,
  type HostActionDeps,
  type HostActionNoticeRow,
  type ReconcileDeps,
  reconcileHostActionNotices,
  recordHostAction,
} from "../../f/factory/lib/host_action.ts";
import { logger } from "../../f/factory/lib/log.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

describe("buildHostActionNotice", () => {
  test("uses the host action notice kind", () => {
    expect(
      buildHostActionNotice(SHA_A, ["infra/docker-compose.yml"]).notice.kind,
    ).toBe(HOST_ACTION_NOTICE_KIND);
  });

  test("names the deployed sha in the message", () => {
    expect(
      buildHostActionNotice(SHA_A, ["infra/docker-compose.yml"]).notice.message,
    ).toContain(`反映した版: ${SHA_A}`);
  });

  test("lists the changed host paths in the cause", () => {
    expect(
      buildHostActionNotice(SHA_A, ["infra/docker-compose.yml", "mise.toml"])
        .cause,
    ).toContain("infra/docker-compose.yml, mise.toml");
  });

  test("tells the operator to run mise run up", () => {
    expect(buildHostActionNotice(SHA_A, ["mise.toml"]).next_action).toContain(
      "mise run up",
    );
  });

  test("shortens a long path list and counts the rest", () => {
    const paths = Array.from({ length: 13 }, (_, i) => `infra/f${String(i)}`);
    expect(buildHostActionNotice(SHA_A, paths).cause).toContain("ほか3件");
  });

  test("produces the same message for the same sha and paths", () => {
    const paths = ["infra/a", "mise.toml"];
    expect(buildHostActionNotice(SHA_A, paths).notice).toEqual(
      buildHostActionNotice(SHA_A, paths).notice,
    );
  });

  test("produces a different message for another sha", () => {
    expect(buildHostActionNotice(SHA_A, ["mise.toml"]).notice.message).not.toBe(
      buildHostActionNotice(SHA_B, ["mise.toml"]).notice.message,
    );
  });
});

describe("extractNoticeSha", () => {
  test("reads the sha back from a built message", () => {
    const { notice } = buildHostActionNotice(SHA_A, ["mise.toml"]);
    expect(extractNoticeSha(notice.message)).toBe(SHA_A);
  });

  test("returns null when the message has no sha", () => {
    expect(extractNoticeSha("something else")).toBeNull();
  });
});

function recordHarness(
  overrides: Partial<HostActionDeps> & {
    inserted?: boolean;
  } = {},
) {
  const notices: NoticeRecord[] = [];
  const events: NotifyEvent[] = [];
  const lines: string[] = [];
  const deps: HostActionDeps = {
    addNotice: async (record) => {
      notices.push(record);
      return overrides.inserted === false ? null : 7;
    },
    notify: async (event) => {
      events.push(event);
      return { status: "sent" };
    },
    instanceName: "local",
    log: logger("test", { sink: (line) => lines.push(line) }),
    ...overrides,
  };
  return { deps, notices, events, lines };
}

describe("recordHostAction", () => {
  test("adds the notice", async () => {
    const h = recordHarness();
    await recordHostAction(h.deps, SHA_A, ["mise.toml"]);
    expect(h.notices).toEqual([
      buildHostActionNotice(SHA_A, ["mise.toml"]).notice,
    ]);
  });

  test("returns recorded when the notice is new", async () => {
    const h = recordHarness();
    expect(await recordHostAction(h.deps, SHA_A, ["mise.toml"])).toBe(
      "recorded",
    );
  });

  test("sends the same content to Discord when the notice is new", async () => {
    const h = recordHarness();
    const built = buildHostActionNotice(SHA_A, ["mise.toml"]);
    await recordHostAction(h.deps, SHA_A, ["mise.toml"]);
    expect(h.events).toEqual([
      {
        kind: "host_action_required",
        instance_name: "local",
        cause: built.cause,
        next_action: built.next_action,
      },
    ]);
  });

  test("does not send Discord while the same notice is unresolved", async () => {
    const h = recordHarness({ inserted: false });
    await recordHostAction(h.deps, SHA_A, ["mise.toml"]);
    expect(h.events).toEqual([]);
  });

  test("returns already_open while the same notice is unresolved", async () => {
    const h = recordHarness({ inserted: false });
    expect(await recordHostAction(h.deps, SHA_A, ["mise.toml"])).toBe(
      "already_open",
    );
  });

  test("returns failed without throwing when the notice cannot be recorded", async () => {
    const h = recordHarness({
      addNotice: async () => {
        throw new Error("db down");
      },
    });
    expect(await recordHostAction(h.deps, SHA_A, ["mise.toml"])).toBe("failed");
  });

  test("keeps the result when Discord throws", async () => {
    const h = recordHarness({
      notify: async () => {
        throw new Error("discord down");
      },
    });
    expect(await recordHostAction(h.deps, SHA_A, ["mise.toml"])).toBe(
      "recorded",
    );
  });
});

function noticeRow(id: number, sha: string): HostActionNoticeRow {
  return {
    id,
    message: buildHostActionNotice(sha, ["mise.toml"]).notice.message,
  };
}

function reconcileHarness(options: {
  applied?: string | Error;
  rows?: HostActionNoticeRow[];
  ancestors?: Array<[string, string]>;
  isAncestorThrows?: boolean;
  listThrows?: boolean;
}) {
  const resolved: number[] = [];
  const lines: string[] = [];
  const deps: ReconcileDeps = {
    readAppliedSha: async () => {
      const applied = options.applied ?? new Error("ENOENT");
      if (applied instanceof Error) throw applied;
      return applied;
    },
    listUnresolved: async () => {
      if (options.listThrows === true) throw new Error("db down");
      return options.rows ?? [];
    },
    isAncestor: async (ancestor, descendant) => {
      if (options.isAncestorThrows === true) throw new Error("git failed");
      return (options.ancestors ?? []).some(
        ([a, d]) => a === ancestor && d === descendant,
      );
    },
    resolve: async (id) => {
      resolved.push(id);
      return true;
    },
    log: logger("test", { sink: (line) => lines.push(line) }),
  };
  return { deps, resolved, lines };
}

describe("reconcileHostActionNotices", () => {
  test("resolves a notice for the sha the host applied", async () => {
    const h = reconcileHarness({
      applied: `${SHA_A}\n`,
      rows: [noticeRow(1, SHA_A)],
    });
    await reconcileHostActionNotices(h.deps);
    expect(h.resolved).toEqual([1]);
  });

  test("resolves a notice whose sha is an ancestor of the applied sha", async () => {
    const h = reconcileHarness({
      applied: SHA_B,
      rows: [noticeRow(1, SHA_A)],
      ancestors: [[SHA_A, SHA_B]],
    });
    await reconcileHostActionNotices(h.deps);
    expect(h.resolved).toEqual([1]);
  });

  test("keeps a notice for a sha newer than the applied sha", async () => {
    const h = reconcileHarness({
      applied: SHA_A,
      rows: [noticeRow(1, SHA_B)],
    });
    await reconcileHostActionNotices(h.deps);
    expect(h.resolved).toEqual([]);
  });

  test("resolves only the notices the applied sha covers", async () => {
    const h = reconcileHarness({
      applied: SHA_B,
      rows: [noticeRow(1, SHA_A), noticeRow(2, SHA_C)],
      ancestors: [[SHA_A, SHA_B]],
    });
    await reconcileHostActionNotices(h.deps);
    expect(h.resolved).toEqual([1]);
  });

  test("returns the number of resolved notices", async () => {
    const h = reconcileHarness({ applied: SHA_A, rows: [noticeRow(1, SHA_A)] });
    expect(await reconcileHostActionNotices(h.deps)).toBe(1);
  });

  test("resolves nothing when the host has not recorded a sha", async () => {
    const h = reconcileHarness({
      applied: new Error("ENOENT"),
      rows: [noticeRow(1, SHA_A)],
    });
    await reconcileHostActionNotices(h.deps);
    expect(h.resolved).toEqual([]);
  });

  test("resolves nothing when the recorded value is not a sha", async () => {
    const h = reconcileHarness({
      applied: "garbage",
      rows: [noticeRow(1, SHA_A)],
    });
    await reconcileHostActionNotices(h.deps);
    expect(h.resolved).toEqual([]);
  });

  test("skips a notice whose message has no sha", async () => {
    const h = reconcileHarness({
      applied: SHA_A,
      rows: [{ id: 1, message: "no sha here" }],
    });
    await reconcileHostActionNotices(h.deps);
    expect(h.resolved).toEqual([]);
  });

  test("keeps the notice when the ancestry check fails", async () => {
    const h = reconcileHarness({
      applied: SHA_B,
      rows: [noticeRow(1, SHA_A)],
      isAncestorThrows: true,
    });
    await reconcileHostActionNotices(h.deps);
    expect(h.resolved).toEqual([]);
  });

  test("does not throw when listing fails", async () => {
    const h = reconcileHarness({ applied: SHA_A, listThrows: true });
    expect(await reconcileHostActionNotices(h.deps)).toBe(0);
  });
});
