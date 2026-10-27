import { describe, expect, test } from "bun:test";
import {
  type ChooseEnv,
  chooseItem,
  filterPaletteItems,
  type PaletteItem,
  paletteItems,
  paletteKeyAction,
  paletteSections,
  paletteStatus,
} from "./commandPalette.ts";

const SCREENS = [
  { id: "inbox", label: "要対応", path: "/", destinations: [] },
  {
    id: "items",
    label: "作業項目",
    path: "/items",
    destinations: [{ label: "作業項目 › 新規投入", path: "/items/new" }],
  },
  {
    id: "jobs",
    label: "ジョブ",
    path: "/jobs",
    destinations: [{ label: "ジョブ › 履歴", path: "/jobs?tab=history" }],
  },
];

function recordedEnv(): ChooseEnv & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    close: () => {
      calls.push("close");
    },
    navigate: (path) => {
      calls.push(`navigate:${path}`);
    },
    openHelp: () => {
      calls.push("help");
    },
  };
}

function key(
  name: string,
  override: { isComposing?: boolean; keyCode?: number } = {},
) {
  return { key: name, keyCode: 0, isComposing: false, ...override };
}

describe("palette", () => {
  test("lists the screens, their fixed destinations and the shortcut help only", () => {
    expect(paletteItems(SCREENS).map((item) => item.group)).toEqual([
      "screens",
      "screens",
      "screens",
      "screens",
      "screens",
      "help",
    ]);
  });

  test("takes the names from the table, each destination after its screen", () => {
    expect(
      paletteItems(SCREENS)
        .filter((item) => item.group === "screens")
        .map((item) => item.label),
    ).toEqual([
      "要対応",
      "作業項目",
      "作業項目 › 新規投入",
      "ジョブ",
      "ジョブ › 履歴",
    ]);
  });

  test("moves to the screen's path", () => {
    expect(paletteItems(SCREENS)[1]?.target).toEqual({
      kind: "screen",
      path: "/items",
    });
  });

  test("moves to the path of a fixed destination", () => {
    expect(paletteItems(SCREENS)[4]?.target).toEqual({
      kind: "screen",
      path: "/jobs?tab=history",
    });
  });

  test("gives every item its own id", () => {
    const ids = paletteItems(SCREENS).map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("always carries the help item", () => {
    expect(paletteItems([]).map((item) => item.target)).toEqual([
      { kind: "help" },
    ]);
  });

  test("names the help item", () => {
    expect(paletteItems([])[0]?.label).toBe("ショートカットの一覧を開く");
  });

  test("groups the items under two headings, in order", () => {
    expect(
      paletteSections(paletteItems(SCREENS)).map((section) => section.label),
    ).toEqual(["画面", "ヘルプ"]);
  });

  test("leaves out a heading that has no items", () => {
    const screensOnly = paletteItems(SCREENS).filter(
      (item) => item.group === "screens",
    );
    expect(paletteSections(screensOnly).map((section) => section.id)).toEqual([
      "screens",
    ]);
  });
});

describe("filterPaletteItems", () => {
  const items = paletteItems(SCREENS);

  test("returns every item for an empty query", () => {
    expect(filterPaletteItems(items, "  ")).toEqual(items);
  });

  test("matches part of a label", () => {
    expect(filterPaletteItems(items, "項目").map((item) => item.label)).toEqual(
      ["作業項目", "作業項目 › 新規投入"],
    );
  });

  test("matches a fixed destination by its own words", () => {
    expect(filterPaletteItems(items, "履歴").map((item) => item.label)).toEqual(
      ["ジョブ › 履歴"],
    );
  });

  test("matches the English id of a screen", () => {
    expect(filterPaletteItems(items, "JOBS").map((item) => item.label)).toEqual(
      ["ジョブ", "ジョブ › 履歴"],
    );
  });

  test("matches the help by its keyword", () => {
    expect(
      filterPaletteItems(items, "ヘルプ").map((item) => item.target.kind),
    ).toEqual(["help"]);
  });

  test("requires every word of the query", () => {
    expect(filterPaletteItems(items, "作業 ジョブ")).toEqual([]);
  });

  test("folds full-width letters", () => {
    expect(filterPaletteItems(items, "ＪＯＢＳ").length).toBe(2);
  });
});

describe("paletteKeyAction", () => {
  test("moves down with ArrowDown", () => {
    expect(paletteKeyAction(key("ArrowDown"), 0, 3)).toEqual({
      kind: "move",
      index: 1,
    });
  });

  test("wraps up from the first item", () => {
    expect(paletteKeyAction(key("ArrowUp"), 0, 3)).toEqual({
      kind: "move",
      index: 2,
    });
  });

  test("chooses the active item with Enter", () => {
    expect(paletteKeyAction(key("Enter"), 2, 3)).toEqual({
      kind: "choose",
      index: 2,
    });
  });

  test("ignores the Enter that confirms the IME", () => {
    expect(paletteKeyAction(key("Enter", { isComposing: true }), 2, 3)).toEqual(
      { kind: "ignore" },
    );
  });

  test("ignores an arrow key while composing", () => {
    expect(paletteKeyAction(key("ArrowDown", { keyCode: 229 }), 0, 3)).toEqual({
      kind: "ignore",
    });
  });

  test("ignores Enter when nothing is listed", () => {
    expect(paletteKeyAction(key("Enter"), 0, 0)).toEqual({ kind: "ignore" });
  });

  test("leaves Home and End to the text field", () => {
    expect(paletteKeyAction(key("Home"), 1, 3)).toEqual({ kind: "ignore" });
  });

  test("leaves a letter to the text field", () => {
    expect(paletteKeyAction(key("a"), 0, 3)).toEqual({ kind: "ignore" });
  });
});

describe("paletteStatus", () => {
  test("reads the count", () => {
    expect(paletteStatus(3)).toBe("3件の候補");
  });

  test("reads an empty result", () => {
    expect(paletteStatus(0)).toBe("該当する項目はありません");
  });
});

describe("palette choose", () => {
  const screen: PaletteItem = {
    id: "screen-jobs",
    group: "screens",
    label: "ジョブ",
    keywords: "",
    target: { kind: "screen", path: "/jobs" },
  };
  const help: PaletteItem = { ...screen, target: { kind: "help" } };

  test("closes before it navigates", () => {
    const env = recordedEnv();
    chooseItem(screen, env);
    expect(env.calls).toEqual(["close", "navigate:/jobs"]);
  });

  test("closes before it opens the help", () => {
    const env = recordedEnv();
    chooseItem(help, env);
    expect(env.calls).toEqual(["close", "help"]);
  });
});
