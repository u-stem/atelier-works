import { describe, expect, test } from "bun:test";
import {
  DESIGN_ENABLED_IGNORED_NOTICE_KIND,
  DESIGN_ENABLED_IGNORED_NOTICE_MESSAGE,
} from "../../f/factory/lib/config.ts";
import type { LogFields, Logger } from "../../f/factory/lib/log.ts";
import {
  DESIGN_NOTICE_CHECK_TIMEOUT_MS,
  DESIGN_NOTICE_RESOLVE_LIMIT,
  reconcileDesignEnabledNotice,
} from "../../f/factory/lib/self_update_support.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";

type LogCall = { level: "info" | "warn" | "error"; message: string };

/** 呼ばれた回数と引数を記録する、依存の組。 */
function harness(options: {
  ignored: boolean;
  unresolved?: readonly number[];
  addFails?: boolean;
  listFails?: boolean;
  resolveFailsFor?: readonly number[];
}) {
  const added: NoticeRecord[] = [];
  const listed: number[] = [];
  const resolved: number[] = [];
  const logs: LogCall[] = [];
  const record =
    (level: LogCall["level"]) =>
    (message: string, _fields?: LogFields): void => {
      logs.push({ level, message });
    };
  const log: Logger = {
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
  const deps = {
    ignored: options.ignored,
    addNotice: async (notice: NoticeRecord) => {
      added.push(notice);
      if (options.addFails === true) throw new Error("add failed");
      return 1;
    },
    listUnresolved: async () => {
      listed.push(1);
      if (options.listFails === true) throw new Error("list failed");
      return (options.unresolved ?? []).map((id) => ({ id }));
    },
    resolve: async (id: number) => {
      resolved.push(id);
      if (options.resolveFailsFor?.includes(id) === true) {
        throw new Error("resolve failed");
      }
      return true;
    },
    log,
  };
  return { deps, added, listed, resolved, logs };
}

const IGNORED_WARNING =
  "design_enabled is true but the design stage cannot be opened yet; reading it as false";

describe("design notice constants", () => {
  test("the check timeout is five seconds", () => {
    expect(DESIGN_NOTICE_CHECK_TIMEOUT_MS).toBe(5000);
  });

  test("at most three notices are resolved per run", () => {
    expect(DESIGN_NOTICE_RESOLVE_LIMIT).toBe(3);
  });

  test("the notice kind is design_enabled_ignored", () => {
    expect(DESIGN_ENABLED_IGNORED_NOTICE_KIND).toBe("design_enabled_ignored");
  });

  test("the notice message is not empty", () => {
    expect(DESIGN_ENABLED_IGNORED_NOTICE_MESSAGE.length).toBeGreaterThan(0);
  });
});

describe("reconcileDesignEnabledNotice when the setting is ignored", () => {
  test("logs the warning once", async () => {
    const { deps, logs } = harness({ ignored: true });

    await reconcileDesignEnabledNotice(deps);

    expect(logs).toEqual([{ level: "warn", message: IGNORED_WARNING }]);
  });

  test("adds the fixed notice once", async () => {
    const { deps, added } = harness({ ignored: true });

    await reconcileDesignEnabledNotice(deps);

    expect(added).toEqual([
      {
        kind: DESIGN_ENABLED_IGNORED_NOTICE_KIND,
        message: DESIGN_ENABLED_IGNORED_NOTICE_MESSAGE,
      },
    ]);
  });

  test("does not list unresolved notices", async () => {
    const { deps, listed } = harness({ ignored: true });

    await reconcileDesignEnabledNotice(deps);

    expect(listed).toEqual([]);
  });

  test("does not resolve any notice", async () => {
    const { deps, resolved } = harness({ ignored: true, unresolved: [1] });

    await reconcileDesignEnabledNotice(deps);

    expect(resolved).toEqual([]);
  });

  test("does not throw and keeps the warning when adding the notice fails", async () => {
    const { deps, logs } = harness({ ignored: true, addFails: true });

    await reconcileDesignEnabledNotice(deps);

    expect(logs.map((entry) => entry.message)).toContain(IGNORED_WARNING);
  });

  test("logs the failure to add the notice", async () => {
    const { deps, logs } = harness({ ignored: true, addFails: true });

    await reconcileDesignEnabledNotice(deps);

    expect(logs).toHaveLength(2);
  });
});

describe("reconcileDesignEnabledNotice when the setting is not ignored", () => {
  test("does not add a notice", async () => {
    const { deps, added } = harness({ ignored: false, unresolved: [4] });

    await reconcileDesignEnabledNotice(deps);

    expect(added).toEqual([]);
  });

  test("does not log the warning", async () => {
    const { deps, logs } = harness({ ignored: false, unresolved: [4] });

    await reconcileDesignEnabledNotice(deps);

    expect(logs).toEqual([]);
  });

  test("resolves the one unresolved notice", async () => {
    const { deps, resolved } = harness({ ignored: false, unresolved: [4] });

    await reconcileDesignEnabledNotice(deps);

    expect(resolved).toEqual([4]);
  });

  test("stops at the limit when more notices are unresolved", async () => {
    const { deps, resolved } = harness({
      ignored: false,
      unresolved: [1, 2, 3, 4, 5],
    });

    await reconcileDesignEnabledNotice(deps);

    expect(resolved).toEqual([1, 2, 3]);
  });

  test("does not resolve when no notice is unresolved", async () => {
    const { deps, resolved } = harness({ ignored: false, unresolved: [] });

    await reconcileDesignEnabledNotice(deps);

    expect(resolved).toEqual([]);
  });

  test("does not throw and logs a warning when listing fails", async () => {
    const { deps, logs } = harness({ ignored: false, listFails: true });

    await reconcileDesignEnabledNotice(deps);

    expect(logs.map((entry) => entry.level)).toEqual(["warn"]);
  });

  test("keeps resolving the rest when one resolution fails", async () => {
    const { deps, resolved } = harness({
      ignored: false,
      unresolved: [1, 2, 3],
      resolveFailsFor: [1],
    });

    await reconcileDesignEnabledNotice(deps);

    expect(resolved).toEqual([1, 2, 3]);
  });

  test("logs a warning for each failed resolution", async () => {
    const { deps, logs } = harness({
      ignored: false,
      unresolved: [1, 2],
      resolveFailsFor: [1, 2],
    });

    await reconcileDesignEnabledNotice(deps);

    expect(logs.map((entry) => entry.level)).toEqual(["warn", "warn"]);
  });
});
