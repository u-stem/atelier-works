import { describe, expect, test } from "bun:test";
import {
  type FreezeReleaseDeps,
  releaseFreezeFromConsole,
} from "../../f/factory/freeze_release.ts";
import {
  type DeployFreezeEntry,
  type FreezeEntry,
  type FreezeState,
  parseFreezeState,
  serializeFreezeState,
} from "../../f/factory/lib/freezes.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";

const NOW = new Date("2026-10-24T03:04:05.000Z");
const HOUR = 60 * 60 * 1000;

function schedule(overrides: Partial<FreezeEntry> = {}): FreezeEntry {
  return {
    id: "0a1b2c3d",
    target: "f/factory/poll_issues",
    reason: "SECRET-REASON",
    holder_kind: "session",
    holder: "session:SECRET-HOLDER",
    created_at: new Date(NOW.getTime() - HOUR).toISOString(),
    expires_at: new Date(NOW.getTime() + HOUR).toISOString(),
    released_at: null,
    ...overrides,
  };
}

function deploy(overrides: Partial<DeployFreezeEntry> = {}): DeployFreezeEntry {
  return {
    id: "1b2c3d4e",
    reason: "SECRET-REASON",
    holder_kind: "human",
    holder: "human",
    created_at: new Date(NOW.getTime() - HOUR).toISOString(),
    expires_at: new Date(NOW.getTime() + HOUR).toISOString(),
    released_at: null,
    ...overrides,
  };
}

function text(freezes: FreezeEntry[], deployFreezes: DeployFreezeEntry[] = []) {
  const state: FreezeState = {
    version: 1,
    freezes,
    deploy_freezes: deployFreezes,
  };
  return serializeFreezeState(state);
}

type Harness = {
  readonly deps: FreezeReleaseDeps;
  readonly store: { value: string | null };
  readonly calls: string[];
  readonly writes: string[];
  readonly notices: NoticeRecord[];
  readonly warnings: string[];
};

type Options = {
  /** 書き込みの直後に、別の書き手が変数を置き換える。 */
  readonly afterWrite?: (store: { value: string | null }) => void;
  /** 書き込みの後の読み直しを失敗させる。 */
  readonly rereadFails?: boolean;
  readonly writeFails?: boolean;
  readonly readFails?: boolean;
  readonly approver?: () => string;
  readonly noticeFails?: boolean;
};

function harness(initial: string | null, options: Options = {}): Harness {
  const store = { value: initial };
  const calls: string[] = [];
  const writes: string[] = [];
  const notices: NoticeRecord[] = [];
  const warnings: string[] = [];
  let wrote = false;
  const deps: FreezeReleaseDeps = {
    deriveApprover:
      options.approver ??
      (() => {
        calls.push("deriveApprover");
        return "operator";
      }),
    ports: {
      readVariable: async () => {
        calls.push("read");
        if (options.readFails === true) throw new Error("variable unreadable");
        if (wrote && options.rereadFails === true) {
          throw new Error("variable unreadable after the write");
        }
        return store.value;
      },
      writeVariable: async (next) => {
        calls.push("write");
        if (options.writeFails === true) throw new Error("write refused");
        writes.push(next);
        store.value = next;
        wrote = true;
        options.afterWrite?.(store);
      },
      now: () => NOW,
    },
    addNotice: async (record) => {
      calls.push("notice");
      if (options.noticeFails === true) throw new Error("notice down");
      notices.push(record);
      return 1;
    },
    warn: (message, fields) => {
      warnings.push(JSON.stringify({ message, fields }));
    },
  };
  return { deps, store, calls, writes, notices, warnings };
}

function stateOf(value: string | null): FreezeState {
  const parsed = parseFreezeState(value);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.value;
}

describe("releaseFreezeFromConsole input", () => {
  test.each(["", "0A1B2C3D", "0a1b2c3", "0a1b2c3d4", "zzzzzzzz", "0a1b 2c3"])(
    "rejects the id %p",
    async (id) => {
      const h = harness(text([schedule()]));

      await expect(releaseFreezeFromConsole(id, h.deps)).rejects.toThrow(
        "freeze_release:",
      );
    },
  );

  test("calls nothing for a malformed id", async () => {
    const h = harness(text([schedule()]));

    await releaseFreezeFromConsole("nope", h.deps).catch(() => undefined);

    expect(h.calls).toEqual([]);
  });

  test("refuses when the operator cannot be derived", async () => {
    const h = harness(text([schedule()]), {
      approver: () => {
        throw new Error("cannot determine approver identity");
      },
    });

    await expect(releaseFreezeFromConsole("0a1b2c3d", h.deps)).rejects.toThrow(
      "approver",
    );
  });

  test("calls nothing when the operator cannot be derived", async () => {
    const h = harness(text([schedule()]), {
      approver: () => {
        throw new Error("cannot determine approver identity");
      },
    });

    await releaseFreezeFromConsole("0a1b2c3d", h.deps).catch(() => undefined);

    expect(h.calls).toEqual([]);
  });
});

describe("releaseFreezeFromConsole release", () => {
  test("releases a schedule freeze and says so", async () => {
    const h = harness(text([schedule()]));

    const result = await releaseFreezeFromConsole("0a1b2c3d", h.deps);

    expect(result).toEqual({
      ok: true,
      status: "released",
      freeze_id: "0a1b2c3d",
      scope: "schedule",
      audit: "recorded",
    });
  });

  test("releases a deploy freeze and says so", async () => {
    const h = harness(text([], [deploy()]));

    const result = await releaseFreezeFromConsole("1b2c3d4e", h.deps);

    expect(result).toEqual({
      ok: true,
      status: "released",
      freeze_id: "1b2c3d4e",
      scope: "deploy",
      audit: "recorded",
    });
  });

  test("writes the release time into the freeze", async () => {
    const h = harness(text([schedule()]));

    await releaseFreezeFromConsole("0a1b2c3d", h.deps);

    expect(stateOf(h.store.value).freezes[0]?.released_at).toBe(
      NOW.toISOString(),
    );
  });

  test("leaves the other rows as they were", async () => {
    const other = schedule({ id: "2c3d4e5f", target: "f/factory/poll_prs" });
    const h = harness(text([schedule(), other], [deploy()]));

    await releaseFreezeFromConsole("0a1b2c3d", h.deps);

    const after = stateOf(h.store.value);
    expect([after.freezes[1], after.deploy_freezes[0]]).toEqual([
      other,
      deploy(),
    ]);
  });

  test("releases a freeze that a session placed", async () => {
    const h = harness(text([schedule({ holder_kind: "session" })]));

    expect((await releaseFreezeFromConsole("0a1b2c3d", h.deps)).status).toBe(
      "released",
    );
  });

  test("reads the variable again after the write", async () => {
    const h = harness(text([schedule()]));

    await releaseFreezeFromConsole("0a1b2c3d", h.deps);

    expect(h.calls.slice(h.calls.indexOf("write"))).toContain("read");
  });

  test("writes once", async () => {
    const h = harness(text([schedule()]));

    await releaseFreezeFromConsole("0a1b2c3d", h.deps);

    expect(h.writes.length).toBe(1);
  });
});

describe("releaseFreezeFromConsole freezes that already ended", () => {
  test("returns already_ended when the row is gone", async () => {
    const h = harness(text([schedule({ id: "2c3d4e5f" })]));

    expect(await releaseFreezeFromConsole("0a1b2c3d", h.deps)).toEqual({
      ok: true,
      status: "already_ended",
      freeze_id: "0a1b2c3d",
    });
  });

  test("returns already_ended when no variable exists", async () => {
    const h = harness(null);

    expect((await releaseFreezeFromConsole("0a1b2c3d", h.deps)).status).toBe(
      "already_ended",
    );
  });

  test("returns already_ended for a released row", async () => {
    const h = harness(text([schedule({ released_at: NOW.toISOString() })]));

    expect((await releaseFreezeFromConsole("0a1b2c3d", h.deps)).status).toBe(
      "already_ended",
    );
  });

  test("returns already_ended for an expired row", async () => {
    const h = harness(
      text([
        schedule({
          expires_at: new Date(NOW.getTime() - 1).toISOString(),
        }),
      ]),
    );

    expect((await releaseFreezeFromConsole("0a1b2c3d", h.deps)).status).toBe(
      "already_ended",
    );
  });

  test("does not write for an ended row", async () => {
    const h = harness(text([schedule({ released_at: NOW.toISOString() })]));

    await releaseFreezeFromConsole("0a1b2c3d", h.deps);

    expect(h.writes).toEqual([]);
  });

  test("leaves no notice for an ended row", async () => {
    const h = harness(text([schedule({ released_at: NOW.toISOString() })]));

    await releaseFreezeFromConsole("0a1b2c3d", h.deps);

    expect(h.notices).toEqual([]);
  });
});

describe("releaseFreezeFromConsole failures", () => {
  test("throws when the variable is corrupt", async () => {
    const h = harness("{not json");

    await expect(releaseFreezeFromConsole("0a1b2c3d", h.deps)).rejects.toThrow(
      "freeze:reset",
    );
  });

  test("does not write when the variable is corrupt", async () => {
    const h = harness("{not json");

    await releaseFreezeFromConsole("0a1b2c3d", h.deps).catch(() => undefined);

    expect(h.writes).toEqual([]);
  });

  test("throws when the variable cannot be read", async () => {
    const h = harness(text([schedule()]), { readFails: true });

    await expect(releaseFreezeFromConsole("0a1b2c3d", h.deps)).rejects.toThrow(
      "freeze_release:",
    );
  });

  test("throws with the script prefix when the write fails", async () => {
    const h = harness(text([schedule()]), { writeFails: true });

    await expect(releaseFreezeFromConsole("0a1b2c3d", h.deps)).rejects.toThrow(
      "freeze_release: write refused",
    );
  });

  test("leaves no notice when the write fails", async () => {
    const h = harness(text([schedule()]), { writeFails: true });

    await releaseFreezeFromConsole("0a1b2c3d", h.deps).catch(() => undefined);

    expect(h.notices).toEqual([]);
  });
});

describe("releaseFreezeFromConsole confirmation", () => {
  test("returns unconfirmed when another writer restored the old state", async () => {
    const original = text([schedule()]);
    const h = harness(original, {
      afterWrite: (store) => {
        store.value = original;
      },
    });

    expect(await releaseFreezeFromConsole("0a1b2c3d", h.deps)).toEqual({
      ok: true,
      status: "unconfirmed",
      freeze_id: "0a1b2c3d",
    });
  });

  test("returns unconfirmed when another row disappeared", async () => {
    const other = schedule({ id: "2c3d4e5f", target: "f/factory/poll_prs" });
    const h = harness(text([schedule(), other]), {
      afterWrite: (store) => {
        store.value = text([schedule({ released_at: NOW.toISOString() })]);
      },
    });

    expect((await releaseFreezeFromConsole("0a1b2c3d", h.deps)).status).toBe(
      "unconfirmed",
    );
  });

  test("returns unconfirmed when the released row disappeared", async () => {
    const h = harness(text([schedule()]), {
      afterWrite: (store) => {
        store.value = null;
      },
    });

    expect((await releaseFreezeFromConsole("0a1b2c3d", h.deps)).status).toBe(
      "unconfirmed",
    );
  });

  test("returns unconfirmed when the variable cannot be read again", async () => {
    const h = harness(text([schedule()]), { rereadFails: true });

    expect((await releaseFreezeFromConsole("0a1b2c3d", h.deps)).status).toBe(
      "unconfirmed",
    );
  });

  test("leaves no notice when it cannot confirm", async () => {
    const original = text([schedule()]);
    const h = harness(original, {
      afterWrite: (store) => {
        store.value = original;
      },
    });

    await releaseFreezeFromConsole("0a1b2c3d", h.deps);

    expect(h.notices).toEqual([]);
  });

  test("accepts the loss of a released row that another writer cleaned up", async () => {
    const ended = schedule({
      id: "2c3d4e5f",
      target: "f/factory/poll_prs",
      released_at: new Date(NOW.getTime() - HOUR).toISOString(),
    });
    const h = harness(text([schedule(), ended]), {
      afterWrite: (store) => {
        store.value = text([schedule({ released_at: NOW.toISOString() })]);
      },
    });

    expect((await releaseFreezeFromConsole("0a1b2c3d", h.deps)).status).toBe(
      "released",
    );
  });

  test("accepts the loss of an expired row that another writer cleaned up", async () => {
    const expired = deploy({
      created_at: new Date(NOW.getTime() - 2 * HOUR).toISOString(),
      expires_at: new Date(NOW.getTime() - HOUR).toISOString(),
    });
    const h = harness(text([schedule()], [expired]), {
      afterWrite: (store) => {
        store.value = text([schedule({ released_at: NOW.toISOString() })]);
      },
    });

    expect((await releaseFreezeFromConsole("0a1b2c3d", h.deps)).status).toBe(
      "released",
    );
  });

  test("accepts the loss of a row whose expiry passed between the write and the read", async () => {
    const soon = deploy({
      expires_at: new Date(NOW.getTime() + 1000).toISOString(),
    });
    const h = harness(text([schedule()], [soon]), {
      afterWrite: (store) => {
        store.value = text([schedule({ released_at: NOW.toISOString() })]);
      },
    });
    let ticks = 0;
    const deps: FreezeReleaseDeps = {
      ...h.deps,
      ports: {
        ...h.deps.ports,
        now: () => new Date(NOW.getTime() + 2000 * ticks++),
      },
    };

    expect((await releaseFreezeFromConsole("0a1b2c3d", deps)).status).toBe(
      "released",
    );
  });

  test("returns unconfirmed when a row that is still valid disappeared", async () => {
    const later = deploy({
      expires_at: new Date(NOW.getTime() + 10 * HOUR).toISOString(),
    });
    const h = harness(text([schedule()], [later]), {
      afterWrite: (store) => {
        store.value = text([schedule({ released_at: NOW.toISOString() })]);
      },
    });
    let ticks = 0;
    const deps: FreezeReleaseDeps = {
      ...h.deps,
      ports: {
        ...h.deps.ports,
        now: () => new Date(NOW.getTime() + 2000 * ticks++),
      },
    };

    expect((await releaseFreezeFromConsole("0a1b2c3d", deps)).status).toBe(
      "unconfirmed",
    );
  });

  test("accepts a row that another writer added after the release", async () => {
    const h = harness(text([schedule()]), {
      afterWrite: (store) => {
        store.value = text([
          schedule({ released_at: NOW.toISOString() }),
          schedule({ id: "3d4e5f60", target: "f/factory/poll_prs" }),
        ]);
      },
    });

    expect((await releaseFreezeFromConsole("0a1b2c3d", h.deps)).status).toBe(
      "released",
    );
  });
});

describe("releaseFreezeFromConsole notice", () => {
  test("records the kind hold_released for a schedule freeze", async () => {
    const h = harness(text([schedule()]));

    await releaseFreezeFromConsole("0a1b2c3d", h.deps);

    expect(h.notices.map((notice) => notice.kind)).toEqual(["hold_released"]);
  });

  test("names the schedule, the id and the operator", async () => {
    const h = harness(text([schedule()]));

    await releaseFreezeFromConsole("0a1b2c3d", h.deps);

    expect(h.notices[0]?.message).toBe(
      "凍結(スケジュール f/factory/poll_issues、id 0a1b2c3d)をoperatorが解除しました。(2026-10-24 12:04:05 JST)",
    );
  });

  test("names the deploy freeze without a target", async () => {
    const h = harness(text([], [deploy()]));

    await releaseFreezeFromConsole("1b2c3d4e", h.deps);

    expect(h.notices[0]?.message).toBe(
      "deployの保留(id 1b2c3d4e)をoperatorが解除しました。(2026-10-24 12:04:05 JST)",
    );
  });

  test("leaves the reason and the holder out of the notice", async () => {
    const h = harness(text([schedule()]));

    await releaseFreezeFromConsole("0a1b2c3d", h.deps);

    expect(h.notices[0]?.message).not.toMatch(/SECRET/);
  });

  test("cuts a long operator name at 100 characters", async () => {
    const h = harness(text([schedule()]), { approver: () => "o".repeat(300) });

    await releaseFreezeFromConsole("0a1b2c3d", h.deps);

    expect(h.notices[0]?.message).toContain(`${"o".repeat(100)}が`);
  });

  test("keeps the release when the notice cannot be written", async () => {
    const h = harness(text([schedule()]), { noticeFails: true });

    expect((await releaseFreezeFromConsole("0a1b2c3d", h.deps)).status).toBe(
      "released",
    );
  });

  test("reports the audit as failed when the notice cannot be written", async () => {
    const h = harness(text([schedule()]), { noticeFails: true });

    expect((await releaseFreezeFromConsole("0a1b2c3d", h.deps)).audit).toBe(
      "failed",
    );
  });

  test("keeps the reason and the holder out of the warning", async () => {
    const h = harness(text([schedule()]), { noticeFails: true });

    await releaseFreezeFromConsole("0a1b2c3d", h.deps);

    expect(h.warnings.join("")).not.toMatch(/SECRET/);
  });
});
