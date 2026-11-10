import { describe, expect, test } from "bun:test";
import type { ConfigItemView, DesignStageView } from "../api/jobsQueries.ts";
import { changeOffersOf, STOPPABLE_SWITCHES } from "./configChange.ts";
import { switchRowsOf, switchTableShown } from "./configSwitches.ts";

function flag(key: string, value: boolean): ConfigItemView {
  return { key, kind: "value", value, masked: false };
}

function rowOf(
  items: readonly ConfigItemView[],
  key: string,
  designStage?: DesignStageView,
) {
  const row = switchRowsOf(items, designStage).find((r) => r.key === key);
  if (row === undefined) throw new Error(`no row for ${key}`);
  return row;
}

const IGNORED: DesignStageView = {
  enabled: false,
  ignored: true,
  indeterminate: false,
};
const INDETERMINATE: DesignStageView = {
  enabled: false,
  ignored: false,
  indeterminate: true,
};
const IN_EFFECT: DesignStageView = {
  enabled: true,
  ignored: false,
  indeterminate: false,
};

describe("switchRowsOf", () => {
  test("has a row for every switch that the Console can stop, in the order of the list", () => {
    expect(switchRowsOf([], undefined).map((row) => row.key)).toEqual([
      ...STOPPABLE_SWITCHES,
    ]);
  });

  test("includes design_enabled", () => {
    expect(switchRowsOf([], undefined).map((row) => row.key)).toContain(
      "design_enabled",
    );
  });

  test("reads a switch that is true as on", () => {
    expect(
      rowOf([flag("implement_enabled", true)], "implement_enabled").state,
    ).toBe("on");
  });

  test("reads a switch that is false as off", () => {
    expect(
      rowOf([flag("implement_enabled", false)], "implement_enabled").state,
    ).toBe("off");
  });

  test("reads a switch that the config does not have as unset", () => {
    expect(rowOf([], "implement_enabled").state).toBe("unset");
  });

  test("reads a reference as hidden", () => {
    expect(
      rowOf(
        [{ key: "implement_enabled", kind: "reference" }],
        "implement_enabled",
      ).state,
    ).toBe("hidden");
  });

  test("reads a masked value as hidden", () => {
    expect(
      rowOf(
        [
          {
            key: "implement_enabled",
            kind: "value",
            value: true,
            masked: true,
          },
        ],
        "implement_enabled",
      ).state,
    ).toBe("hidden");
  });

  test("reads a value that is not a boolean as not_boolean", () => {
    expect(
      rowOf(
        [
          {
            key: "implement_enabled",
            kind: "value",
            value: "yes",
            masked: false,
          },
        ],
        "implement_enabled",
      ).state,
    ).toBe("not_boolean");
  });

  test("gives the same offer as the table of the group for a switch that is on", () => {
    const item = flag("dependabot_enabled", true);
    expect(rowOf([item], "dependabot_enabled").offer).toEqual(
      changeOffersOf(item)[0] ?? null,
    );
  });

  test("gives no offer for a switch that is off", () => {
    expect(
      rowOf([flag("dependabot_enabled", false)], "dependabot_enabled").offer,
    ).toBeNull();
  });

  test("gives no offer for a switch that is hidden", () => {
    expect(
      rowOf(
        [{ key: "dependabot_enabled", kind: "reference" }],
        "dependabot_enabled",
      ).offer,
    ).toBeNull();
  });

  test("gives no offer for a switch that the config does not have", () => {
    expect(rowOf([], "dependabot_enabled").offer).toBeNull();
  });

  test("does not take a switch that the Console cannot stop", () => {
    expect(
      switchRowsOf([flag("pr_ci_watch_enabled", true)], undefined).map(
        (row) => row.key,
      ),
    ).not.toContain("pr_ci_watch_enabled");
  });
});

describe("switchRowsOf for the design stage", () => {
  const ON = [flag("design_enabled", true)];

  test("says that the written true is ignored", () => {
    expect(rowOf(ON, "design_enabled", IGNORED).stageNote).toBe("無視中");
  });

  test("says that the written true cannot be told", () => {
    expect(rowOf(ON, "design_enabled", INDETERMINATE).stageNote).toBe(
      "判定できません",
    );
  });

  test("keeps the state on while the written true is ignored", () => {
    expect(rowOf(ON, "design_enabled", IGNORED).state).toBe("on");
  });

  test("says nothing while the written true is in effect", () => {
    expect(rowOf(ON, "design_enabled", IN_EFFECT).stageNote).toBeNull();
  });

  test("says nothing when the backend sends no stage", () => {
    expect(rowOf(ON, "design_enabled", undefined).stageNote).toBeNull();
  });

  test("says nothing while the written value is false", () => {
    expect(
      rowOf([flag("design_enabled", false)], "design_enabled", IGNORED)
        .stageNote,
    ).toBeNull();
  });

  test("says nothing for another switch", () => {
    expect(
      rowOf([flag("implement_enabled", true)], "implement_enabled", IGNORED)
        .stageNote,
    ).toBeNull();
  });
});

describe("switchTableShown", () => {
  test("shows the table while the query is empty", () => {
    expect(switchTableShown("", 10)).toBe(true);
  });

  test("shows the table while the query is only spaces", () => {
    expect(switchTableShown("  ", 10)).toBe(true);
  });

  test("hides the table while a query is typed", () => {
    expect(switchTableShown("budget", 10)).toBe(false);
  });

  test("hides the table when the config has no item", () => {
    expect(switchTableShown("", 0)).toBe(false);
  });
});
