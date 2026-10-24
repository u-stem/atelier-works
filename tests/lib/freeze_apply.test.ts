import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chooseFreezeAction,
  type FreezeInputs,
  type FreezePorts,
  finishFrozenPush,
  loadFreezeInputs,
  mutateFreezeState,
  prepareFrozenPush,
  readActiveDeployFreezes,
  sdkFreezePorts,
  shouldHoldDeploy,
} from "../../f/factory/lib/freeze_apply.ts";
import {
  type DeployFreezeEntry,
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
  const state: FreezeState = { version: 1, freezes, deploy_freezes: [] };
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
      value: { ...state, freezes: state.freezes.slice(0, 0) },
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
    const seen: Date[] = [];

    await mutateFreezeState(ports, (state, now) => {
      seen.push(now);
      return { ok: true, value: state };
    });

    expect(seen).toEqual([NOW]);
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

describe("prepareFrozenPush with the self_update target", () => {
  const SELF = entry({ target: "f/factory/self_update" });

  test("does not exclude the self_update schedule", async () => {
    const result = await prepareFrozenPush(fake(text(SELF)).ports, INPUTS);

    expect(result.ok && result.value.excludesArg).not.toContain("self_update");
  });

  test("warns about the self_update freeze", async () => {
    const result = await prepareFrozenPush(fake(text(SELF)).ports, INPUTS);

    expect(result.ok && result.value.warnings.length).toBe(1);
  });
});

describe("chooseFreezeAction", () => {
  const ready = (ids: string[]) => ({
    ok: true as const,
    value: {
      excludesArg: "--excludes=a",
      excludedTargets: [],
      readyIds: ids,
      deployFreezes: [],
      warnings: [],
    },
  });
  const broken = { ok: false as const, reason: "x" };

  test("skips an unchanged clone with nothing to reconcile", () => {
    expect(chooseFreezeAction(true, ready([]))).toBe("skip");
  });

  test("skips an unchanged clone when the freezes cannot be read", () => {
    expect(chooseFreezeAction(true, broken)).toBe("skip");
  });

  test("reconciles an unchanged clone with ended freezes", () => {
    expect(chooseFreezeAction(true, ready(["bbbb2222"]))).toBe("reconcile");
  });

  test("deploys a changed clone", () => {
    expect(chooseFreezeAction(false, ready([]))).toBe("deploy");
  });

  test("tries to deploy a changed clone even when the freezes cannot be read", () => {
    expect(chooseFreezeAction(false, broken)).toBe("deploy");
  });
});

function deployEntry(
  overrides: Partial<DeployFreezeEntry> = {},
): DeployFreezeEntry {
  return {
    id: "d0a1b2c3",
    reason: "migrate",
    holder_kind: "session",
    holder: "session:x",
    created_at: new Date(NOW.getTime() - HOUR).toISOString(),
    expires_at: new Date(NOW.getTime() + HOUR).toISOString(),
    released_at: null,
    ...overrides,
  };
}

function textWithDeploy(
  freezes: readonly FreezeEntry[],
  deploy: readonly DeployFreezeEntry[],
): string {
  return serializeFreezeState({
    version: 1,
    freezes,
    deploy_freezes: deploy,
  });
}

const EXPIRED_DEPLOY = deployEntry({
  id: "bbbb9999",
  expires_at: new Date(NOW.getTime() - 1).toISOString(),
});

describe("prepareFrozenPush with deploy freezes", () => {
  test("lists an active deploy freeze with its id and expiry", async () => {
    const result = await prepareFrozenPush(
      fake(textWithDeploy([], [deployEntry()])).ports,
      INPUTS,
    );

    expect(result.ok && result.value.deployFreezes).toEqual([
      { id: "d0a1b2c3", expires_at: deployEntry().expires_at },
    ]);
  });

  test("does not list an expired deploy freeze", async () => {
    const result = await prepareFrozenPush(
      fake(textWithDeploy([], [EXPIRED_DEPLOY])).ports,
      INPUTS,
    );

    expect(result.ok && result.value.deployFreezes).toEqual([]);
  });

  test("does not list a released deploy freeze", async () => {
    const released = deployEntry({
      released_at: new Date(NOW.getTime() - 1).toISOString(),
    });
    const result = await prepareFrozenPush(
      fake(textWithDeploy([], [released])).ports,
      INPUTS,
    );

    expect(result.ok && result.value.deployFreezes).toEqual([]);
  });

  test("does not make an ended deploy row ready for reconciliation", async () => {
    const result = await prepareFrozenPush(
      fake(textWithDeploy([], [EXPIRED_DEPLOY])).ports,
      INPUTS,
    );

    expect(result.ok && result.value.readyIds).toEqual([]);
  });

  test("does not exclude any schedule for a deploy freeze", async () => {
    const result = await prepareFrozenPush(
      fake(textWithDeploy([], [deployEntry()])).ports,
      INPUTS,
    );

    expect(result.ok && result.value.excludedTargets).toEqual([]);
  });

  test("is empty when the variable is missing", async () => {
    const result = await prepareFrozenPush(fake(null).ports, INPUTS);

    expect(result.ok && result.value.deployFreezes).toEqual([]);
  });
});

describe("finishFrozenPush with deploy freezes", () => {
  test("keeps the deploy rows when it removes the ended schedule rows", async () => {
    const { ports, writes } = fake(textWithDeploy([EXPIRED], [deployEntry()]));

    await finishFrozenPush(ports, ["bbbb2222"]);

    expect(writes[0]).toBe(textWithDeploy([], [deployEntry()]));
  });
});

describe("readActiveDeployFreezes", () => {
  test("returns the active deploy freezes", async () => {
    const result = await readActiveDeployFreezes(
      fake(textWithDeploy([], [deployEntry(), EXPIRED_DEPLOY])).ports,
    );

    expect(result.ok && result.value.map((e) => e.id)).toEqual(["d0a1b2c3"]);
  });

  test("returns none for a variable without deploy freezes", async () => {
    const result = await readActiveDeployFreezes(fake(text(entry())).ports);

    expect(result.ok && result.value).toEqual([]);
  });

  test("returns none when the variable is missing", async () => {
    const result = await readActiveDeployFreezes(fake(null).ports);

    expect(result.ok && result.value).toEqual([]);
  });

  test("fails when the variable cannot be read", async () => {
    const result = await readActiveDeployFreezes(
      fake(new Error("connection refused")).ports,
    );

    expect(result.ok).toBe(false);
  });

  test("fails when the variable is corrupt", async () => {
    const result = await readActiveDeployFreezes(fake("{").ports);

    expect(result.ok).toBe(false);
  });

  test("does not write", async () => {
    const { ports, writes } = fake(textWithDeploy([], [deployEntry()]));

    await readActiveDeployFreezes(ports);

    expect(writes).toEqual([]);
  });
});

describe("shouldHoldDeploy", () => {
  test("is true when a deploy freeze is active", () => {
    expect(
      shouldHoldDeploy({
        deployFreezes: [{ id: "d0a1b2c3", expires_at: "x" }],
      }),
    ).toBe(true);
  });

  test("is false when no deploy freeze is active", () => {
    expect(shouldHoldDeploy({ deployFreezes: [] })).toBe(false);
  });
});

describe("a row with an impossible time", () => {
  const future = deployEntry({
    created_at: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    expires_at: new Date(NOW.getTime() + 70 * 60_000).toISOString(),
  });

  test("makes the preparation of a push fail", async () => {
    const result = await prepareFrozenPush(
      fake(textWithDeploy([], [future])).ports,
      INPUTS,
    );

    expect(result.ok).toBe(false);
  });

  test("makes the read of the deploy freezes fail", async () => {
    const result = await readActiveDeployFreezes(
      fake(textWithDeploy([], [future])).ports,
    );

    expect(result.ok).toBe(false);
  });
});
