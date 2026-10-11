import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CheckImageStaleError,
  CheckRuntimeUnsafeError,
} from "../../f/factory/lib/check_sandbox.ts";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import {
  buildCheckImageStaleNotice,
  buildCheckRuntimeUnsafeNotice,
  buildHostActionNotice,
  CHECK_RUNTIME_NOTICE_KIND,
  extractNoticeSha,
  HOST_ACTION_NOTICE_KIND,
  HOST_ACTION_RECONCILE_LIMIT,
  type HostActionDeps,
  type HostActionNoticeRow,
  hostAppliedChecker,
  type ReconcileDeps,
  readHostAppliedSha,
  reconcileHostActionNotices,
  recordCheckEnvironmentNotice,
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
    isApplied: async () => "not_applied",
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

  test("adds no notice when the host already applied the sha", async () => {
    const h = recordHarness({ isApplied: async () => "included" });
    await recordHostAction(h.deps, SHA_A, ["mise.toml"]);
    expect(h.notices).toEqual([]);
  });

  test("sends no Discord message when the host already applied the sha", async () => {
    const h = recordHarness({ isApplied: async () => "included" });
    await recordHostAction(h.deps, SHA_A, ["mise.toml"]);
    expect(h.events).toEqual([]);
  });

  test("returns already_applied when the host already applied the sha", async () => {
    const h = recordHarness({ isApplied: async () => "included" });
    expect(await recordHostAction(h.deps, SHA_A, ["mise.toml"])).toBe(
      "already_applied",
    );
  });

  test("adds no notice when the host applied the same content", async () => {
    const h = recordHarness({ isApplied: async () => "same_content" });
    await recordHostAction(h.deps, SHA_A, ["mise.toml"]);
    expect(h.notices).toEqual([]);
  });

  test("sends no Discord message when the host applied the same content", async () => {
    const h = recordHarness({ isApplied: async () => "same_content" });
    await recordHostAction(h.deps, SHA_A, ["mise.toml"]);
    expect(h.events).toEqual([]);
  });

  test("returns already_applied when the host applied the same content", async () => {
    const h = recordHarness({ isApplied: async () => "same_content" });
    expect(await recordHostAction(h.deps, SHA_A, ["mise.toml"])).toBe(
      "already_applied",
    );
  });

  test("logs that it skipped the notice for the same content", async () => {
    const h = recordHarness({ isApplied: async () => "same_content" });
    await recordHostAction(h.deps, SHA_A, ["mise.toml"]);
    expect(
      h.lines.some((l) =>
        l.includes("skipped: host already applied the same content"),
      ),
    ).toBe(true);
  });

  test("notifies when a host path outside this change differs from the applied sha", async () => {
    // 並行するPRを両方とも先にmise run upしてからマージした回は、この回の変更の外のinfra/も比べる。
    const checker = checkerHarness({
      applied: SHA_B,
      differing: ["infra/worker/Dockerfile"],
    });
    const h = recordHarness({ isApplied: checker.check });
    expect(
      await recordHostAction(h.deps, SHA_A, ["infra/docker-compose.yml"]),
    ).toBe("recorded");
  });

  test("skips the notice when no host path differs from the applied sha", async () => {
    const checker = checkerHarness({
      applied: SHA_B,
      differing: ["f/factory/x.ts"],
    });
    const h = recordHarness({ isApplied: checker.check });
    expect(
      await recordHostAction(h.deps, SHA_A, ["infra/docker-compose.yml"]),
    ).toBe("already_applied");
  });

  test("notifies when the applied check throws", async () => {
    const h = recordHarness({
      isApplied: async () => {
        throw new Error("unexpected");
      },
    });
    expect(await recordHostAction(h.deps, SHA_A, ["mise.toml"])).toBe(
      "recorded",
    );
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

/** 反映済みの版と内容が異なるパスの既定。ホスト側のパスを含むので、内容の比較では反映済みにならない。 */
const DIFFERING_HOST_PATHS = ["infra/docker-compose.yml", "mise.toml"];

function checkerHarness(options: {
  applied?: string | Error;
  ancestors?: Array<[string, string]>;
  isAncestorThrows?: boolean;
  commitExists?: boolean;
  commitExistsThrows?: boolean;
  differing?: readonly string[] | Error;
}) {
  const lines: string[] = [];
  const reads: number[] = [];
  const lookups: string[] = [];
  const compared: Array<[string, string]> = [];
  const check = hostAppliedChecker({
    readAppliedSha: async () => {
      reads.push(1);
      const applied = options.applied ?? new Error("ENOENT");
      if (applied instanceof Error) throw applied;
      return applied;
    },
    commitExists: async (sha) => {
      lookups.push(sha);
      if (options.commitExistsThrows === true) throw new Error("git failed");
      return options.commitExists ?? true;
    },
    isAncestor: async (ancestor, descendant) => {
      if (options.isAncestorThrows === true) throw new Error("git failed");
      return (options.ancestors ?? []).some(
        ([a, d]) => a === ancestor && d === descendant,
      );
    },
    differingPaths: async (from, to) => {
      compared.push([from, to]);
      const differing = options.differing ?? DIFFERING_HOST_PATHS;
      if (differing instanceof Error) throw differing;
      return differing;
    },
    log: logger("test", { sink: (line) => lines.push(line) }),
  });
  return { check, lines, reads, lookups, compared };
}

const missingFile = () =>
  Object.assign(new Error("no such file"), { code: "ENOENT" });

describe("hostAppliedChecker", () => {
  test("covers the same sha", async () => {
    expect(await checkerHarness({ applied: SHA_A }).check(SHA_A)).toBe(
      "included",
    );
  });

  test("covers an ancestor of the applied sha", async () => {
    const h = checkerHarness({ applied: SHA_B, ancestors: [[SHA_A, SHA_B]] });
    expect(await h.check(SHA_A)).toBe("included");
  });

  test("does not compare the content of an ancestor", async () => {
    const h = checkerHarness({ applied: SHA_B, ancestors: [[SHA_A, SHA_B]] });
    await h.check(SHA_A);
    expect(h.compared).toEqual([]);
  });

  test("does not cover a sha that is not an ancestor when the host paths differ", async () => {
    expect(await checkerHarness({ applied: SHA_B }).check(SHA_A)).toBe(
      "not_applied",
    );
  });

  test("compares the applied sha with the sha", async () => {
    const h = checkerHarness({ applied: SHA_B, differing: [] });
    await h.check(SHA_A);
    expect(h.compared).toEqual([[SHA_B, SHA_A]]);
  });

  test("does not cover a sha when the content comparison fails", async () => {
    const h = checkerHarness({
      applied: SHA_B,
      differing: new Error("git diff failed"),
    });
    expect(await h.check(SHA_A)).toBe("not_applied");
  });

  test("warns when the content comparison fails", async () => {
    const h = checkerHarness({
      applied: SHA_B,
      differing: new Error("git diff failed"),
    });
    await h.check(SHA_A);
    expect(h.lines.some((l) => l.includes("could not be compared"))).toBe(true);
  });

  test("covers a sha that is not an ancestor when only paths without host action differ", async () => {
    const h = checkerHarness({
      applied: SHA_B,
      differing: ["f/factory/x.ts", "scripts/up.sh"],
    });
    expect(await h.check(SHA_A)).toBe("same_content");
  });

  test("does not cover a sha that is not an ancestor when an infra path differs", async () => {
    const h = checkerHarness({
      applied: SHA_B,
      differing: ["infra/Caddyfile"],
    });
    expect(await h.check(SHA_A)).toBe("not_applied");
  });

  test("does not cover a sha that is not an ancestor when mise.toml differs", async () => {
    const h = checkerHarness({ applied: SHA_B, differing: ["mise.toml"] });
    expect(await h.check(SHA_A)).toBe("not_applied");
  });

  test("does not cover anything when nothing is recorded", async () => {
    const h = checkerHarness({ applied: missingFile() });
    expect(await h.check(SHA_A)).toBe("not_applied");
  });

  test("stays silent when the file does not exist", async () => {
    const h = checkerHarness({ applied: missingFile() });
    await h.check(SHA_A);
    expect(h.lines).toEqual([]);
  });

  test("warns when the file cannot be read for another reason", async () => {
    const h = checkerHarness({ applied: new Error("EACCES") });
    await h.check(SHA_A);
    expect(h.lines.some((l) => l.includes("could not be read"))).toBe(true);
  });

  test("does not cover anything when the value is not a sha", async () => {
    const h = checkerHarness({ applied: "garbage", differing: [] });
    expect(await h.check(SHA_A)).toBe("not_applied");
  });

  test("does not cover a sha when the ancestry check fails", async () => {
    const h = checkerHarness({
      applied: SHA_B,
      isAncestorThrows: true,
      differing: [],
    });
    expect(await h.check(SHA_A)).toBe("not_applied");
  });

  test("does not cover anything when the applied sha is not in the clone", async () => {
    const h = checkerHarness({
      applied: SHA_B,
      commitExists: false,
      differing: [],
    });
    expect(await h.check(SHA_B)).toBe("not_applied");
  });

  test("warns once about a missing commit however many shas it checks", async () => {
    const h = checkerHarness({ applied: SHA_B, commitExists: false });
    await h.check(SHA_A);
    await h.check(SHA_C);
    expect(
      h.lines.filter((l) => l.includes("not in the self clone")),
    ).toHaveLength(1);
  });

  test("does not cover anything when the commit lookup fails", async () => {
    const h = checkerHarness({
      applied: SHA_B,
      commitExistsThrows: true,
      differing: [],
    });
    expect(await h.check(SHA_B)).toBe("not_applied");
  });

  test("reads the file and looks up the commit only once", async () => {
    const h = checkerHarness({ applied: SHA_B });
    await h.check(SHA_A);
    await h.check(SHA_C);
    expect([h.reads.length, h.lookups.length]).toEqual([1, 1]);
  });
});

describe("readHostAppliedSha", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "host-applied-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("reads the content of a small regular file", async () => {
    const path = join(dir, "marker");
    writeFileSync(path, `${SHA_A}\n`);
    expect((await readHostAppliedSha(path)).trim()).toBe(SHA_A);
  });

  test("rejects a symlink even when it points to a small file", async () => {
    const target = join(dir, "target");
    const link = join(dir, "link");
    writeFileSync(target, SHA_A);
    symlinkSync(target, link);
    await expect(readHostAppliedSha(link)).rejects.toThrow();
  });

  test("rejects a FIFO without blocking", async () => {
    const fifo = join(dir, "fifo");
    Bun.spawnSync(["mkfifo", fifo]);
    await expect(readHostAppliedSha(fifo)).rejects.toThrow();
  });

  test("rejects a file larger than 128 bytes", async () => {
    const path = join(dir, "big");
    writeFileSync(path, "a".repeat(129));
    await expect(readHostAppliedSha(path)).rejects.toThrow();
  });

  test("rejects a missing file", async () => {
    await expect(readHostAppliedSha(join(dir, "none"))).rejects.toThrow();
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
  commitExists?: boolean;
  differing?: readonly string[] | Error;
}) {
  const resolved: number[] = [];
  const lines: string[] = [];
  const checked: string[] = [];
  const log = logger("test", { sink: (line) => lines.push(line) });
  const check = hostAppliedChecker({
    readAppliedSha: async () => {
      const applied = options.applied ?? new Error("ENOENT");
      if (applied instanceof Error) throw applied;
      return applied;
    },
    commitExists: async () => options.commitExists ?? true,
    isAncestor: async (ancestor, descendant) => {
      checked.push(ancestor);
      if (options.isAncestorThrows === true) throw new Error("git failed");
      return (options.ancestors ?? []).some(
        ([a, d]) => a === ancestor && d === descendant,
      );
    },
    differingPaths: async () => {
      const differing = options.differing ?? DIFFERING_HOST_PATHS;
      if (differing instanceof Error) throw differing;
      return differing;
    },
    log,
  });
  const deps: ReconcileDeps = {
    listUnresolved: async () => {
      if (options.listThrows === true) throw new Error("db down");
      return options.rows ?? [];
    },
    isApplied: check,
    resolve: async (id) => {
      resolved.push(id);
      return true;
    },
    log,
  };
  return { deps, resolved, lines, checked };
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

  test("resolves a notice whose sha is not an ancestor but has the same host content", async () => {
    const h = reconcileHarness({
      applied: SHA_B,
      rows: [noticeRow(1, SHA_A)],
      differing: ["f/factory/self_update.ts"],
    });
    await reconcileHostActionNotices(h.deps);
    expect(h.resolved).toEqual([1]);
  });

  test("keeps a notice whose sha is not an ancestor and has different host content", async () => {
    const h = reconcileHarness({
      applied: SHA_B,
      rows: [noticeRow(1, SHA_A)],
      differing: ["infra/docker-compose.yml"],
    });
    await reconcileHostActionNotices(h.deps);
    expect(h.resolved).toEqual([]);
  });

  test("keeps a notice when the content comparison fails", async () => {
    const h = reconcileHarness({
      applied: SHA_B,
      rows: [noticeRow(1, SHA_A)],
      differing: new Error("git diff failed"),
    });
    await reconcileHostActionNotices(h.deps);
    expect(h.resolved).toEqual([]);
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

  test("checks only the oldest notices up to the limit", async () => {
    const shas = Array.from({ length: 8 }, (_, i) => i.toString(16).repeat(40));
    const h = reconcileHarness({
      applied: "f".repeat(40),
      rows: shas.map((sha, i) => noticeRow(i + 1, sha)),
      ancestors: shas.map((sha): [string, string] => [sha, "f".repeat(40)]),
    });
    await reconcileHostActionNotices(h.deps);
    expect(h.resolved).toEqual(
      Array.from({ length: HOST_ACTION_RECONCILE_LIMIT }, (_, i) => i + 1),
    );
  });

  test("makes at most one ancestry check per examined notice", async () => {
    const shas = Array.from({ length: 8 }, (_, i) => i.toString(16).repeat(40));
    const h = reconcileHarness({
      applied: "f".repeat(40),
      rows: shas.map((sha, i) => noticeRow(i + 1, sha)),
    });
    await reconcileHostActionNotices(h.deps);
    expect(h.checked).toHaveLength(HOST_ACTION_RECONCILE_LIMIT);
  });

  test("does not let notices without a readable sha fill the limit", async () => {
    const unreadable = Array.from(
      { length: HOST_ACTION_RECONCILE_LIMIT },
      (_, i) => ({ id: i + 1, message: "rewritten" }),
    );
    const h = reconcileHarness({
      applied: SHA_A,
      rows: [...unreadable, noticeRow(100, SHA_A)],
    });
    await reconcileHostActionNotices(h.deps);
    expect(h.resolved).toEqual([100]);
  });

  test("resolves nothing when the applied sha is not in the clone", async () => {
    const h = reconcileHarness({
      applied: SHA_A,
      rows: [noticeRow(1, SHA_A)],
      commitExists: false,
    });
    await reconcileHostActionNotices(h.deps);
    expect(h.resolved).toEqual([]);
  });

  test("warns once for several notices when the applied sha is not in the clone", async () => {
    const h = reconcileHarness({
      applied: SHA_A,
      rows: [noticeRow(1, SHA_A), noticeRow(2, SHA_B), noticeRow(3, SHA_C)],
      commitExists: false,
    });
    await reconcileHostActionNotices(h.deps);
    expect(
      h.lines.filter((l) => l.includes("not in the self clone")),
    ).toHaveLength(1);
  });
});

describe("buildHostActionNotice paths", () => {
  test("replaces control characters in a path", () => {
    const { notice } = buildHostActionNotice(SHA_A, ["infra/a\nb\u0007c"]);
    expect(notice.message).toContain("infra/a?b?c");
  });

  test("replaces C1 controls, bidi controls and line separators", () => {
    const { notice } = buildHostActionNotice(SHA_A, ["infra/a\u0085b‮c⁦d e f"]);
    expect(notice.message).toContain("infra/a?b?c?d?e?f");
  });

  test("escapes the characters that build a Markdown link", () => {
    const { cause } = buildHostActionNotice(SHA_A, ["[x](https://evil)"]);
    expect(cause).toContain("\\[x\\]\\(https://evil\\)");
  });

  test("escapes a backslash so it cannot cancel the escape of the next character", () => {
    const { cause } = buildHostActionNotice(SHA_A, ["\\[x\\]\\(https://evil)"]);
    const backslashes = /(\\+)\(https/.exec(cause)?.[1]?.length ?? 0;
    expect(backslashes % 2).toBe(1);
  });

  test("escapes the backslash itself", () => {
    const { cause } = buildHostActionNotice(SHA_A, ["a\\b"]);
    expect(cause).toContain("a\\\\b");
  });

  test("keeps the message on one line", () => {
    const { notice } = buildHostActionNotice(SHA_A, ["infra/a\r\nb"]);
    expect(notice.message.includes("\n")).toBe(false);
  });
});

describe("buildCheckImageStaleNotice", () => {
  test("uses the host action notice kind", () => {
    expect(
      buildCheckImageStaleNotice(SHA_A, "/usr/bin/getfacl is missing").kind,
    ).toBe(HOST_ACTION_NOTICE_KIND);
  });

  test("names the deployed sha so that the self update resolves it once the host applied it", () => {
    const notice = buildCheckImageStaleNotice(SHA_A, "x");
    expect(extractNoticeSha(notice.message)).toBe(SHA_A);
  });

  test("carries what the image lacks", () => {
    expect(
      buildCheckImageStaleNotice(SHA_A, "/usr/bin/getfacl is missing").message,
    ).toContain("/usr/bin/getfacl is missing");
  });

  test("tells the operator to run mise run up", () => {
    expect(buildCheckImageStaleNotice(SHA_A, "x").message).toContain(
      "mise run up",
    );
  });

  test("leaves the sha out when the deployed version is unknown", () => {
    expect(
      extractNoticeSha(buildCheckImageStaleNotice(null, "x").message),
    ).toBeNull();
  });

  test("asks the operator to resolve the notice when the deployed version is unknown", () => {
    expect(buildCheckImageStaleNotice(null, "x").message).toContain(
      "この通知を解決",
    );
  });

  test("produces the same message for the same sha and problems", () => {
    expect(buildCheckImageStaleNotice(SHA_A, "x")).toEqual(
      buildCheckImageStaleNotice(SHA_A, "x"),
    );
  });
});

describe("recordCheckEnvironmentNotice", () => {
  const harness = (overrides: {
    readonly sha?: () => Promise<string>;
    readonly addNotice?: (record: NoticeRecord) => Promise<number | null>;
  }) => {
    const notices: NoticeRecord[] = [];
    const lines: string[] = [];
    return {
      notices,
      lines,
      deps: {
        readDeployedSha: overrides.sha ?? (async () => `${SHA_A}\n`),
        addNotice:
          overrides.addNotice ??
          (async (record: NoticeRecord) => {
            notices.push(record);
            return 1;
          }),
        log: logger("test", { sink: (line: string) => lines.push(line) }),
      },
    };
  };

  const STALE = new CheckImageStaleError(["x"]);
  const RUNTIME = new CheckRuntimeUnsafeError(["/tmp/open", "y"]);

  test("adds the notice with the deployed sha", async () => {
    const h = harness({});
    await recordCheckEnvironmentNotice(h.deps, STALE);
    expect(h.notices).toEqual([buildCheckImageStaleNotice(SHA_A, "x")]);
  });

  test("adds the notice without a sha when the deployed sha cannot be read", async () => {
    const h = harness({
      sha: async () => {
        throw new Error("variable not found");
      },
    });
    await recordCheckEnvironmentNotice(h.deps, STALE);
    expect(h.notices).toEqual([buildCheckImageStaleNotice(null, "x")]);
  });

  test("adds the notice without a sha when the deployed value is not a sha", async () => {
    const h = harness({ sha: async () => "main" });
    await recordCheckEnvironmentNotice(h.deps, STALE);
    expect(h.notices).toEqual([buildCheckImageStaleNotice(null, "x")]);
  });

  test("does not throw when the notice cannot be recorded", async () => {
    const h = harness({
      addNotice: async () => {
        throw new Error("db down");
      },
    });
    await recordCheckEnvironmentNotice(h.deps, STALE);
    expect(h.lines.join("\n")).toContain("db down");
  });

  test("adds the runtime notice for a problem of the running worker", async () => {
    const h = harness({});
    await recordCheckEnvironmentNotice(h.deps, RUNTIME);
    expect(h.notices).toEqual([buildCheckRuntimeUnsafeNotice("/tmp/open, y")]);
  });

  test("does not read the deployed sha for a problem of the running worker", async () => {
    let reads = 0;
    const h = harness({
      sha: async () => {
        reads += 1;
        return SHA_A;
      },
    });
    await recordCheckEnvironmentNotice(h.deps, RUNTIME);
    expect(reads).toBe(0);
  });

  // イメージの通知は`mise run up`の後に自己更新が解決するが、ボリュームのマウントポイントは作り直しでは閉じない。
  // 稼働中にできた点を別の通知に残し、人が閉じて止まった作業項目を再実行するまで残す。
  test("adds the runtime notice too when a stale image comes with runtime problems", async () => {
    const h = harness({});
    await recordCheckEnvironmentNotice(
      h.deps,
      new CheckImageStaleError(["x"], ["/workspaces"]),
    );
    expect(h.notices).toEqual([
      buildCheckImageStaleNotice(SHA_A, "x"),
      buildCheckRuntimeUnsafeNotice("/workspaces"),
    ]);
  });

  test("adds the runtime notice even when the image notice cannot be recorded", async () => {
    const kinds: string[] = [];
    const h = harness({
      addNotice: async (record) => {
        if (record.kind === HOST_ACTION_NOTICE_KIND) throw new Error("db down");
        kinds.push(record.kind);
        return 1;
      },
    });
    await recordCheckEnvironmentNotice(
      h.deps,
      new CheckImageStaleError(["x"], ["/workspaces"]),
    );
    expect(kinds).toEqual([CHECK_RUNTIME_NOTICE_KIND]);
  });

  test("does not throw when the runtime notice cannot be recorded", async () => {
    const h = harness({
      addNotice: async () => {
        throw new Error("db down");
      },
    });
    await recordCheckEnvironmentNotice(h.deps, RUNTIME);
    expect(h.lines.join("\n")).toContain("db down");
  });
});

describe("buildCheckRuntimeUnsafeNotice", () => {
  test("uses its own notice kind, not the host action one the self update resolves", () => {
    expect(buildCheckRuntimeUnsafeNotice("/tmp/open").kind).toBe(
      CHECK_RUNTIME_NOTICE_KIND,
    );
  });

  test("carries the paths", () => {
    expect(buildCheckRuntimeUnsafeNotice("/tmp/open").message).toContain(
      "/tmp/open",
    );
  });

  test("names no version, so that nothing resolves it by itself", () => {
    expect(
      extractNoticeSha(buildCheckRuntimeUnsafeNotice(`/tmp/${SHA_A}`).message),
    ).toBeNull();
  });

  test("tells the operator to close the paths", () => {
    expect(buildCheckRuntimeUnsafeNotice("/tmp/open").message).toContain(
      "chmod o-w",
    );
  });

  test("tells the operator how to recreate the worker", () => {
    expect(buildCheckRuntimeUnsafeNotice("/tmp/open").message).toContain(
      "docker compose -f infra/docker-compose.yml up -d --force-recreate windmill_worker",
    );
  });

  test("tells the operator that recreating the worker does not close the volume mount points", () => {
    expect(buildCheckRuntimeUnsafeNotice("/workspaces").message).toContain(
      "/workspacesと/var/lib/factoryは、ボリュームのマウントポイントで、作り直しでは閉じないので、chmodで閉じる",
    );
  });

  test("escapes Markdown in the paths", () => {
    expect(buildCheckRuntimeUnsafeNotice("/tmp/[a](b)").message).toContain(
      "/tmp/\\[a\\]\\(b\\)",
    );
  });
});
