import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ConfigItemView, DesignStageView } from "../../api/jobsQueries.ts";
import { STOPPABLE_SWITCHES } from "../../lib/configChange.ts";
import { ChangeButton } from "./ChangeButton.tsx";
import { ConfigSwitchTable } from "./ConfigSwitchTable.tsx";

function flag(key: string, value: boolean): ConfigItemView {
  return { key, kind: "value", value, masked: false };
}

const ALL_ON: ConfigItemView[] = STOPPABLE_SWITCHES.map((key) =>
  flag(key, true),
);

function render(
  items: readonly ConfigItemView[],
  options: {
    designStage?: DesignStageView;
    isLocked?: () => boolean;
  } = {},
): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ConfigSwitchTable
        items={items}
        designStage={options.designStage}
        onChoose={() => undefined}
        isLocked={options.isLocked ?? (() => false)}
      />
    </MemoryRouter>,
  );
}

/** キーは折り返しの位置(wbr)を含むので外して読む。 */
function plain(html: string): string {
  return html.replaceAll("<wbr/>", "");
}

function rowOfKey(html: string, key: string): string {
  const rows = plain(html).match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? [];
  return rows.find((row) => row.includes(`>${key}<`)) ?? "";
}

describe("ConfigSwitchTable", () => {
  test("is named by a heading", () => {
    expect(render(ALL_ON)).toMatch(
      /<h3 id="([^"]+)"[^>]*>機能のスイッチ<\/h3>[\s\S]*<table[^>]*aria-labelledby="\1"/,
    );
  });

  test("has a header for each column", () => {
    expect(render(ALL_ON)).toMatch(
      /<th[^>]*scope="col"[^>]*>項目<\/th><th[^>]*scope="col"[^>]*>状態<\/th><th[^>]*scope="col"[^>]*>操作<\/th>/,
    );
  });

  test.each([...STOPPABLE_SWITCHES])("has a row for %s", (key) => {
    expect(rowOfKey(render(ALL_ON), key)).not.toBe("");
  });

  test("makes the key the header of its row", () => {
    expect(rowOfKey(render(ALL_ON), "implement_enabled")).toMatch(
      /<th[^>]*scope="row"/,
    );
  });

  test("shows the word 有効 for a switch that is on", () => {
    expect(rowOfKey(render(ALL_ON), "implement_enabled")).toContain("有効");
  });

  test("shows the word 無効 for a switch that is off", () => {
    expect(
      rowOfKey(render([flag("implement_enabled", false)]), "implement_enabled"),
    ).toContain("無効");
  });

  test("shows 未設定 for a switch that the config does not have", () => {
    expect(rowOfKey(render([]), "implement_enabled")).toContain("未設定");
  });

  test("shows 参照(出さない) for a switch that is a reference", () => {
    expect(
      rowOfKey(
        render([{ key: "implement_enabled", kind: "reference" }]),
        "implement_enabled",
      ),
    ).toContain("参照(出さない)");
  });

  test("keeps the raw value of a switch for a reader", () => {
    expect(rowOfKey(render(ALL_ON), "implement_enabled")).toMatch(
      /sr-only[^>]*>\(true\)</,
    );
  });

  test("puts a button to stop in the row of a switch that is on", () => {
    expect(rowOfKey(render(ALL_ON), "implement_enabled")).toContain(">止める<");
  });

  test("names the item in the label of the button", () => {
    expect(rowOfKey(render(ALL_ON), "implement_enabled")).toContain(
      'aria-label="implement_enabledを止める"',
    );
  });

  test("puts no button in the row of a switch that is off", () => {
    expect(
      rowOfKey(render([flag("implement_enabled", false)]), "implement_enabled"),
    ).not.toContain("<button");
  });

  test("puts no button in the row of a switch that the config does not have", () => {
    expect(rowOfKey(render([]), "implement_enabled")).not.toContain("<button");
  });

  test("keeps the button off while the item is being changed", () => {
    expect(
      rowOfKey(render(ALL_ON, { isLocked: () => true }), "implement_enabled"),
    ).toMatch(/<button[^>]*disabled/);
  });

  test("leaves the button on while nothing is being changed", () => {
    expect(rowOfKey(render(ALL_ON), "implement_enabled")).not.toMatch(
      /<button[^>]*disabled/,
    );
  });

  test("says that the written true of design_enabled is ignored", () => {
    expect(
      rowOfKey(
        render([flag("design_enabled", true)], {
          designStage: { enabled: false, ignored: true, indeterminate: false },
        }),
        "design_enabled",
      ),
    ).toContain("無視中");
  });

  test("still shows the word 有効 beside the note of the ignoring", () => {
    expect(
      rowOfKey(
        render([flag("design_enabled", true)], {
          designStage: { enabled: false, ignored: true, indeterminate: false },
        }),
        "design_enabled",
      ),
    ).toContain("有効");
  });

  test("says nothing about ignoring when the design stage is in effect", () => {
    expect(
      rowOfKey(
        render([flag("design_enabled", true)], {
          designStage: { enabled: true, ignored: false, indeterminate: false },
        }),
        "design_enabled",
      ),
    ).not.toContain("無視中");
  });

  test("links to the stop-all section of the status tab", () => {
    expect(render(ALL_ON)).toMatch(
      /<a [^>]*href="\/system\?section=stop-all"[^>]*>全停止<\/a>/,
    );
  });

  test("writes a key as text, not as markup", () => {
    expect(
      render([
        {
          key: "implement_enabled",
          kind: "value",
          value: "<b>x</b>",
          masked: false,
        },
      ]),
    ).not.toContain("<b>x</b>");
  });
});

describe("ChangeButton", () => {
  const STOP = { kind: "stop", key: "implement_enabled" } as const;

  test("hands the offer to the handler when it is pressed", () => {
    const chosen: unknown[] = [];
    ChangeButton({
      offer: STOP,
      locked: false,
      onChoose: (offer) => {
        chosen.push(offer);
      },
    }).props.onClick();
    expect(chosen).toEqual([STOP]);
  });

  test("keeps the button off while the item is being changed", () => {
    expect(
      ChangeButton({ offer: STOP, locked: true, onChoose: () => undefined })
        .props.disabled,
    ).toBe(true);
  });
});
