import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FreezeInputs,
  type FreezePorts,
  finishFrozenPush,
  loadFreezeInputs,
  mutateFreezeState,
  prepareFrozenPush,
  sdkFreezePorts,
} from "../../f/factory/lib/freeze_apply.ts";
import {
  FREEZE_REQUIRED_EXCLUDES,
  type FreezeEntry,
  type FreezeState,
  serializeFreezeState,
} from "../../f/factory/lib/freezes.ts";

const NOW = new Date("2026-10-18T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const INPUTS: FreezeInputs = {
  baseExcludes: FREEZE_REQUIRED_EXCLUDES,
  known: new Set(["f/factory/collect_github", "f/factory/poll_issues"]),
};

function entry(overrides: Partial<FreezeEntry> = {}): FreezeEntry {
  return {
    id: "0a1b2c3d",
    target: "f/factory/collect_github",
    reason: "verify",
    holder_kind: "session",
    holder: "session:x",
    created_at: new Date(NOW.getTime() - HOUR).toISOString(),
    expires_at: new Date(NOW.getTime() + HOUR).toISOString(),
    released_at: null,
    ...overrides,
  };
}

function text(...freezes: FreezeEntry[]): string {
  const state: FreezeState = { version: 1, freezes };
  return serializeFreezeState(state);
}

type Fake = { ports: FreezePorts; writes: string[] };

function fake(value: string | null | Error): Fake {
  const writes: string[] = [];
  const ports: FreezePorts = {
    readVariable: async () => {
      if (value instanceof Error) throw value;
      return value;
    },
    writeVariable: async (next) => {
      writes.push(next);
    },
    now: () => NOW,
  };
  return { ports, writes };
}

const EXPIRED = entry({
  id: "bbbb2222",
  expires_at: new Date(NOW.getTime() - 1).toISOString(),
});

describe("prepareFrozenPush", () => {
  test("passes only the base excludes when nothing is frozen", async () => {
    const result = await prepareFrozenPush(fake(null).ports, INPUTS);

    expect(result.ok && result.value.excludesArg).toBe(
      `--excludes=${FREEZE_REQUIRED_EXCLUDES.join(",")}`,
    );
  });

  test("adds the schedule file of an active freeze", async () => {
    const result = await prepareFrozenPush(fake(text(entry())).ports, INPUTS);

    expect(result.ok && result.value.excludesArg).toContain(
      "f/factory/collect_github.schedule.yaml",
    );
  });

  test("does not add the schedule file of an expired freeze", async () => {
    const result = await prepareFrozenPush(fake(text(EXPIRED)).ports, INPUTS);

    expect(result.ok && result.value.excludesArg).not.toContain(
      "collect_github",
    );
  });

  test("lists the ended rows as ready for reconciliation", async () => {
    const result = await prepareFrozenPush(
      fake(text(EXPIRED, entry())).ports,
      INPUTS,
    );

    expect(result.ok && result.value.readyIds).toEqual(["bbbb2222"]);
  });

  test("warns about an active target without a schedule file but still excludes it", async () => {
    const ghost = entry({ target: "f/factory/removed" });
    const result = await prepareFrozenPush(fake(text(ghost)).ports, INPUTS);

    expect(result.ok && result.value.warnings.length).toBe(1);
  });

  test("fails when the variable cannot be read", async () => {
    const result = await prepareFrozenPush(
      fake(new Error("connection refused")).ports,
      INPUTS,
    );

    expect(result.ok).toBe(false);
  });

  test("fails when the variable is corrupt", async () => {
    const result = await prepareFrozenPush(fake("{").ports, INPUTS);

    expect(result.ok).toBe(false);
  });

  test("fails when the base excludes lose a required pattern", async () => {
    const result = await prepareFrozenPush(fake(null).ports, {
      ...INPUTS,
      baseExcludes: [],
    });

    expect(result.ok).toBe(false);
  });
});

describe("finishFrozenPush", () => {
  test("removes the named rows and keeps the others", async () => {
    const { ports, writes } = fake(text(EXPIRED, entry()));

    await finishFrozenPush(ports, ["bbbb2222"]);

    expect(writes[0]).toBe(text(entry()));
  });

  test("keeps a row placed after the preparation", async () => {
    const placedMeanwhile = entry({
      id: "cccc3333",
      target: "f/factory/poll_issues",
    });
    const { ports, writes } = fake(text(EXPIRED, placedMeanwhile));

    await finishFrozenPush(ports, ["bbbb2222"]);

    expect(writes[0]).toBe(text(placedMeanwhile));
  });

  test("does not write when no named row remains", async () => {
    const { ports, writes } = fake(text(entry()));

    await finishFrozenPush(ports, ["bbbb2222"]);

    expect(writes).toEqual([]);
  });

  test("does not write when there is nothing to remove", async () => {
    const { ports, writes } = fake(text(EXPIRED));

    await finishFrozenPush(ports, []);

    expect(writes).toEqual([]);
  });

  test("throws when the variable cannot be read", async () => {
    const { ports } = fake(new Error("down"));

    await expect(finishFrozenPush(ports, ["bbbb2222"])).rejects.toThrow();
  });
});

describe("mutateFreezeState", () => {
  test("applies the operation to the freshly read state and writes it", async () => {
    const { ports, writes } = fake(text(entry()));

    await mutateFreezeState(ports, (state) => ({
      ok: true,
      value: { version: 1, freezes: state.freezes.slice(0, 0) },
    }));

    expect(writes).toEqual([text()]);
  });

  test("does not write when the operation fails", async () => {
    const { ports, writes } = fake(text(entry()));

    await mutateFreezeState(ports, () => ({ ok: false, reason: "no" }));

    expect(writes).toEqual([]);
  });

  test("passes the clock to the operation", async () => {
    const { ports } = fake(null);
    let seen: Date | null = null;

    await mutateFreezeState(ports, (state, now) => {
      seen = now;
      return { ok: true, value: state };
    });

    expect(seen).toEqual(NOW);
  });
});

describe("loadFreezeInputs", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "freeze-inputs-"));
    mkdirSync(join(dir, "f", "factory", "sub"), { recursive: true });
    writeFileSync(join(dir, "f", "factory", "poll_issues.schedule.yaml"), "x");
    writeFileSync(join(dir, "f", "factory", "sub", "a.schedule.yaml"), "x");
    writeFileSync(join(dir, "f", "factory", "poll_issues.ts"), "x");
    writeFileSync(
      join(dir, "wmill.yaml"),
      `excludes:\n${FREEZE_REQUIRED_EXCLUDES.map((p) => `  - "${p}"`).join("\n")}\n`,
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("lists the schedule paths without the extension", async () => {
    const result = await loadFreezeInputs(dir);

    expect(result.ok && [...result.value.known].sort()).toEqual([
      "f/factory/poll_issues",
      "f/factory/sub/a",
    ]);
  });

  test("reads the excludes of wmill.yaml", async () => {
    const result = await loadFreezeInputs(dir);

    expect(result.ok && result.value.baseExcludes).toEqual(
      FREEZE_REQUIRED_EXCLUDES,
    );
  });

  test("fails when wmill.yaml is missing", async () => {
    rmSync(join(dir, "wmill.yaml"));

    const result = await loadFreezeInputs(dir);

    expect(result.ok).toBe(false);
  });
});

describe("sdkFreezePorts", () => {
  function sdk(overrides: {
    get?: () => Promise<string>;
    exists?: () => Promise<boolean>;
    set?: (path: string, value: string) => Promise<void>;
  }) {
    return {
      getVariable: overrides.get ?? (async () => "{}"),
      setVariable: overrides.set ?? (async () => {}),
      VariableService: {
        existsVariable: overrides.exists ?? (async () => true),
      },
    };
  }

  test("returns the value when the variable is readable", async () => {
    const ports = sdkFreezePorts(sdk({ get: async () => "v" }), "w", () => NOW);

    expect(await ports.readVariable()).toBe("v");
  });

  test("returns null only when the variable is confirmed missing", async () => {
    const ports = sdkFreezePorts(
      sdk({
        get: async () => {
          throw new Error("not found");
        },
        exists: async () => false,
      }),
      "w",
      () => NOW,
    );

    expect(await ports.readVariable()).toBeNull();
  });

  test("throws when the read fails and the variable exists", async () => {
    const ports = sdkFreezePorts(
      sdk({
        get: async () => {
          throw new Error("boom");
        },
        exists: async () => true,
      }),
      "w",
      () => NOW,
    );

    await expect(ports.readVariable()).rejects.toThrow("boom");
  });

  test("throws when the existence check also fails", async () => {
    const ports = sdkFreezePorts(
      sdk({
        get: async () => {
          throw new Error("boom");
        },
        exists: async () => {
          throw new Error("down");
        },
      }),
      "w",
      () => NOW,
    );

    await expect(ports.readVariable()).rejects.toThrow("boom");
  });

  test("writes a non-secret variable at the freeze path", async () => {
    const calls: string[] = [];
    const ports = sdkFreezePorts(
      sdk({
        set: async (path, value) => {
          calls.push(`${path}=${value}`);
        },
      }),
      "w",
      () => NOW,
    );

    await ports.writeVariable("v");

    expect(calls).toEqual(["f/factory/freezes=v"]);
  });
});
