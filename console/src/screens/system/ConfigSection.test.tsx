import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { ApiFailure } from "../../api/errors.ts";
import { freshQuery, staleQuery } from "../../api/fakeSectionQuery.testing.ts";
import type {
  ConfigItemView,
  ConfigSnapshotView,
  DesignStageView,
} from "../../api/jobsQueries.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { CONFIG_GROUP_DEFINITIONS } from "../../lib/configGroups.ts";
import { ConfigList, ConfigSection } from "./ConfigSection.tsx";
import { ListChangeButton } from "./EditableListValue.tsx";
import { configNoticeStore } from "./useConfigChange.ts";

const ITEMS: ConfigItemView[] = [
  { key: "daily_budget_usd", kind: "value", value: 5, masked: false },
  { key: "owners", kind: "value", value: ["a", "b"], masked: false },
  { key: "implement_enabled", kind: "value", value: false, masked: false },
  { key: "webhook", kind: "reference" },
  { key: "secret_like", kind: "value", value: "hunter2", masked: true },
];

const SNAPSHOT: ConfigSnapshotView = {
  path: "f/factory/factory_config",
  items: ITEMS,
};

function snapshotOf(items: ConfigItemView[]): ConfigSnapshotView {
  return { path: "f/factory/factory_config", items };
}

function snapshotWithStage(
  items: ConfigItemView[],
  design_stage: DesignStageView,
): ConfigSnapshotView {
  return { path: "f/factory/factory_config", items, design_stage };
}

function renderSection(query = freshQuery(SNAPSHOT)): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <ConfigSection query={query} />
        </TooltipProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("ConfigList", () => {
  test("shows the key of every item", () => {
    expect(
      renderToStaticMarkup(<ConfigList items={ITEMS} />).replaceAll(
        "<wbr/>",
        "",
      ),
    ).toContain("daily_budget_usd");
  });

  test("shows a scalar as text", () => {
    expect(renderToStaticMarkup(<ConfigList items={ITEMS} />)).toContain(">5<");
  });

  test("keeps the raw value of a switch for a reader", () => {
    expect(renderToStaticMarkup(<ConfigList items={ITEMS} />)).toMatch(
      /sr-only[^>]*>\(false\)</,
    );
  });

  test("shows a mixed structure as indented text in a preformatted block", () => {
    expect(
      renderToStaticMarkup(
        <ConfigList
          items={[
            { key: "k", kind: "value", value: ["a", { b: 1 }], masked: false },
          ]}
        />,
      ),
    ).toMatch(/<pre[^>]*>\[\n {2}&quot;a&quot;/);
  });

  test("hides a reference", () => {
    expect(renderToStaticMarkup(<ConfigList items={ITEMS} />)).toContain(
      "参照(出さない)",
    );
  });

  test("hides a value that was masked, whatever it was", () => {
    expect(renderToStaticMarkup(<ConfigList items={ITEMS} />)).not.toContain(
      "hunter2",
    );
  });

  test("says when nothing matches the query", () => {
    expect(renderToStaticMarkup(<ConfigList items={[]} queried />)).toContain(
      "当たる項目がありません",
    );
  });

  test("does not say that nothing matches when no query was typed", () => {
    expect(renderToStaticMarkup(<ConfigList items={[]} />)).not.toContain(
      "当たる項目がありません",
    );
  });

  test("says that the config has no item when no query was typed", () => {
    expect(renderToStaticMarkup(<ConfigList items={[]} />)).toContain(
      "項目がありません",
    );
  });

  test("does not say that nothing matches while the design stage row is shown", () => {
    expect(
      renderToStaticMarkup(
        <ConfigList
          items={[]}
          queried
          designStage={{
            enabled: true,
            ignored: false,
            indeterminate: false,
          }}
        />,
      ),
    ).not.toContain("当たる項目がありません");
  });

  test("writes a string as text, not as markup", () => {
    expect(
      renderToStaticMarkup(
        <ConfigList
          items={[
            { key: "k", kind: "value", value: "<b>x</b>", masked: false },
          ]}
        />,
      ),
    ).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("ConfigList for the description of a group", () => {
  const ALL_KEYS: ConfigItemView[] = CONFIG_GROUP_DEFINITIONS.flatMap((group) =>
    group.keys.map((key) => ({
      key,
      kind: "value" as const,
      value: "x",
      masked: false,
    })),
  );

  test.each(
    CONFIG_GROUP_DEFINITIONS.map((group) => [group.id, group.description]),
  )("shows the description of the group %s", (_id, description) => {
    expect(renderToStaticMarkup(<ConfigList items={ALL_KEYS} />)).toContain(
      `>${description}<`,
    );
  });

  test("puts the description under the heading of the group", () => {
    const html = renderToStaticMarkup(
      <ConfigList
        items={[{ key: "owners", kind: "value", value: [], masked: false }]}
      />,
    );
    expect(html).toMatch(/<h3[^>]*>対象リポジトリ<\/h3><p[^>]*>[^<]+<\/p>/);
  });

  test("ties the table to its description for a reader", () => {
    const html = renderToStaticMarkup(
      <ConfigList
        items={[{ key: "owners", kind: "value", value: [], masked: false }]}
      />,
    );
    expect(html).toMatch(
      /<p id="([^"]+)"[^>]*>[^<]+<\/p>[\s\S]*<table[^>]*aria-describedby="\1"/,
    );
  });
});

function renderValue(key: string, value: unknown): string {
  return renderToStaticMarkup(
    <ConfigList items={[{ key, kind: "value", value, masked: false }]} />,
  );
}

/** オブジェクトの値で、`key`の行を包む要素の`class`。 */
function entryClassOf(html: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return (
    html.match(
      new RegExp(`<div class="([^"]*)"><dt[^>]*>${escaped}</dt>`),
    )?.[1] ?? ""
  );
}

describe("ConfigList values by type", () => {
  test("shows an array of strings as a list with one row per element", () => {
    expect(
      renderValue("allowed_check_commands", [
        "mise run check",
        "mise run lint",
      ]),
    ).toMatch(
      /<ul[^>]*><li[^>]*>mise run check<\/li><li[^>]*>mise run lint<\/li><\/ul>/,
    );
  });

  test("shows no preformatted block for an array of strings", () => {
    expect(renderValue("allowed_check_commands", ["a", "b"])).not.toContain(
      "<pre",
    );
  });

  test("writes an element of a list as text, not as markup", () => {
    expect(renderValue("k", ["<b>x</b>"])).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  test("shows owners as a table with a header for each column", () => {
    expect(
      renderValue("owners", [
        { name: "u-stem", kind: "user", id: 1 },
        { name: "acme", kind: "org", id: 2 },
      ]),
    ).toMatch(
      /<th[^>]*scope="col"[^>]*>name<\/th><th[^>]*scope="col"[^>]*>kind<\/th><th[^>]*scope="col"[^>]*>id<\/th>/,
    );
  });

  test("shows a cell of the table in a row", () => {
    expect(
      renderValue("owners", [{ name: "u-stem", kind: "user", id: 1 }]),
    ).toMatch(/<td[^>]*>u-stem<\/td><td[^>]*>user<\/td><td[^>]*>1<\/td>/);
  });

  test("marks a cell that a row does not have", () => {
    expect(
      renderValue("owners", [
        { name: "u-stem", kind: "user", id: 1 },
        { name: "acme", kind: "org" },
      ]),
    ).toMatch(
      /<td[^>]*>acme<\/td><td[^>]*>org<\/td><td[^>]*><span[^>]*>未設定<\/span><\/td>/,
    );
  });

  test("shows an object as a term and a description for each key", () => {
    expect(renderValue("allowed_labeler_ids", { alice: 12 })).toMatch(
      /<dt[^>]*>alice<\/dt><dd[^>]*><span[^>]*>12<\/span><\/dd>/,
    );
  });

  test("shows an array inside an object as a list", () => {
    expect(
      renderValue("check_commands_by_repo", {
        "u-stem/app": ["mise run check"],
      }),
    ).toMatch(
      /<dt[^>]*>u-stem\/app<\/dt><dd[^>]*><ul[^>]*><li[^>]*>mise run check<\/li>/,
    );
  });

  test("puts the key of an array on a line above the array", () => {
    const html = renderValue("check_commands_by_repo", {
      "u-stem/app": ["mise run check"],
    });
    expect(entryClassOf(html, "u-stem/app")).not.toContain("grid-cols");
  });

  test("indents the array under its key", () => {
    const html = renderValue("check_commands_by_repo", {
      "u-stem/app": ["mise run check"],
    });
    expect(html).toMatch(
      /<dt[^>]*>u-stem\/app<\/dt><dd class="[^"]*\bpl-4\b[^"]*"><ul/,
    );
  });

  test("measures an object against the width of its own cell", () => {
    const html = renderValue("allowed_labeler_ids", { alice: 12 });
    expect(html).toMatch(/<div class="[^"]*@container[^"]*"><dl/);
  });

  test("lets a cell of a table shrink below a long string without a break", () => {
    const html = renderValue("owners", [{ name: "x" }]);
    expect(html).toMatch(
      /<td class="[^"]*\[overflow-wrap:anywhere\][^"]*">x<\/td>/,
    );
  });

  test("puts the key and a scalar value of an object side by side", () => {
    const html = renderValue("allowed_labeler_ids", { alice: 12 });
    expect(entryClassOf(html, "alice")).toContain("grid-cols");
  });

  test("says an empty array inside an object is empty", () => {
    expect(renderValue("check_commands_by_repo", { "u-stem/app": [] })).toMatch(
      /<dt[^>]*>u-stem\/app<\/dt><dd[^>]*>[^<]*<[^>]*>空です/,
    );
  });

  test("says an empty array is empty", () => {
    expect(renderValue("allowed_check_commands", [])).toContain("空です");
  });

  test("says an empty object is empty", () => {
    expect(renderValue("check_commands_by_repo", {})).toContain("空です");
  });

  test("adds what an empty repo_allowlist means", () => {
    expect(renderValue("repo_allowlist", [])).toContain(
      "mainのCIの監視とdependabotは、factory_repoだけを見ます。",
    );
  });

  test("adds nothing about the meaning for an empty list of an unknown key", () => {
    expect(renderValue("allowed_check_commands", [])).not.toContain(
      "空のときは",
    );
  });

  test("writes a key of an object, a column, and a cell as text without hidden characters", () => {
    expect(
      renderValue("k", [{ "a‮b": "c‮d" }]) + renderValue("k", { "a‮b": "c‮d" }),
    ).not.toContain("‮");
  });

  test("marks an element of a list that is an empty string", () => {
    expect(renderValue("repo_allowlist", [""])).toMatch(
      /<li[^>]*><span[^>]*>\(空の文字列\)<\/span><\/li>/,
    );
  });

  test("marks an element of a list that is only whitespace", () => {
    expect(renderValue("repo_allowlist", [" "])).toMatch(
      /<li[^>]*><span[^>]*>\(空の文字列\)<\/span><\/li>/,
    );
  });

  test("marks a cell of a table that is an empty string", () => {
    expect(renderValue("k", [{ name: "" }])).toMatch(
      /<td[^>]*><span[^>]*>\(空の文字列\)<\/span><\/td>/,
    );
  });

  test("marks a value of an object that is an empty string", () => {
    expect(renderValue("k", { a: "" })).toMatch(
      /<dd[^>]*><span[^>]*><span[^>]*>\(空の文字列\)<\/span><\/span><\/dd>/,
    );
  });

  test("marks an element of a list inside an object that is an empty string", () => {
    expect(renderValue("k", { a: [""] })).toMatch(
      /<dd[^>]*><ul[^>]*><li[^>]*><span[^>]*>\(空の文字列\)<\/span><\/li>/,
    );
  });

  test("marks a column header of a table that is an empty string", () => {
    expect(renderValue("owners", [{ "": "x" }])).toMatch(
      /<th[^>]*scope="col"[^>]*><span[^>]*>\(空の文字列\)<\/span><\/th>/,
    );
  });

  test("marks a key of an object that is an empty string", () => {
    expect(renderValue("k", { "": 5 })).toMatch(
      /<dt[^>]*><span[^>]*>\(空の文字列\)<\/span><\/dt>/,
    );
  });

  test("adds no meaning to an empty object of a key that means something when empty as a list", () => {
    expect(renderValue("repo_allowlist", {})).not.toContain("空のときは");
  });

  test("still says an empty object of that key is empty", () => {
    expect(renderValue("repo_allowlist", {})).toContain("空です");
  });

  test("shows a string that spells the marker without the marker's style", () => {
    expect(renderValue("k", ["(空の文字列)"])).toMatch(
      /<li[^>]*>\(空の文字列\)<\/li>/,
    );
  });

  test("keeps a reference hidden when the value is a list", () => {
    expect(
      renderToStaticMarkup(
        <ConfigList
          items={[{ key: "k", kind: "value", value: ["secret"], masked: true }]}
        />,
      ),
    ).not.toContain("secret");
  });

  test("keeps the button of a change next to a value that is a list", () => {
    expect(
      renderToStaticMarkup(
        <ConfigList
          items={[
            { key: "daily_budget_usd", kind: "value", value: 5, masked: false },
            {
              key: "repo_allowlist",
              kind: "value",
              value: ["a"],
              masked: false,
            },
          ]}
          onChoose={() => undefined}
        />,
      ),
    ).toContain("daily_budget_usdを下げる");
  });
});

const DESIGN_ROW_LABEL = "設計工程(実際の状態)";

/** 設計工程の判定の行(`tr`)。無ければ空。 */
function designRowOf(html: string): string {
  return (
    html.match(
      /<tr[^>]*>(?:(?!<\/tr>)[\s\S])*設計工程\(実際の状態\)[\s\S]*?<\/tr>/,
    )?.[0] ?? ""
  );
}

/** 設計工程の判定の行の見出しのセル(`th`)。無ければ空。 */
function designRowHeaderOf(html: string): string {
  return (
    designRowOf(html).match(
      /<th[^>]*>[^<]*設計工程\(実際の状態\)<\/th>/,
    )?.[0] ?? ""
  );
}

afterEach(() => {
  configNoticeStore.dismiss();
});

describe("ConfigSection", () => {
  test("has a heading for the section", () => {
    expect(renderSection()).toMatch(/<h2 id="config-heading"[^>]*>設定<\/h2>/);
  });

  test("has a search box that says what it searches", () => {
    expect(renderSection()).toMatch(
      /<label[^>]*>キー名、グループ名、値で絞り込む<\/label>/,
    );
  });

  test("says that a reference and a masked value are shown as hidden", () => {
    expect(renderSection()).toContain(
      "参照と伏せた値は「参照(出さない)」として表示します",
    );
  });

  test("says which changes can be made in the Console", () => {
    expect(renderSection()).toContain(
      "Consoleで変えられるのは、機能を止める向き、値を下げる向き、3つの一覧の追加と削除です",
    );
  });

  test("says that the other changes are made from a terminal", () => {
    expect(renderSection()).toContain(
      "それ以外の変更(有効にする向き、値の引き上げ、ownersなど)は、端末から行います(wmill resource pushなど)",
    );
  });

  test("points to the stop-all section from the table of the switches", () => {
    expect(renderSection()).toMatch(
      /全部を止めるときは、システムの「状態」タブの<a [^>]*href="\/system\?section=stop-all"[^>]*>全停止<\/a>を使います/,
    );
  });

  test("says where to stop everything only once", () => {
    expect(renderSection().split("全部を止めるときは").length - 1).toBe(1);
  });

  test("lists the changes in the description as items", () => {
    expect(renderSection()).toMatch(/<li[^>]*>Consoleで変えられるのは/);
  });

  test("puts the table of the switches above the tables of the groups", () => {
    const html = renderSection();
    const switches = html.indexOf("機能のスイッチ");
    expect([switches >= 0, switches < html.indexOf("対象リポジトリ")]).toEqual([
      true,
      true,
    ]);
  });

  test("shows the table of the switches once", () => {
    expect(renderSection().split("機能のスイッチ").length - 1).toBe(1);
  });

  test("offers the same stop in the table of the switches and in the table of the group", () => {
    const query = freshQuery(
      snapshotOf([
        { key: "implement_enabled", kind: "value", value: true, masked: false },
      ]),
    );
    expect(
      renderSection(query).split('aria-label="implement_enabledを止める"')
        .length - 1,
    ).toBe(2);
  });

  test("shows the notice that is kept until it is closed above the search box", () => {
    configNoticeStore.pin("implement_enabled", {
      tone: "info",
      message: "変更しませんでした。",
      nextStep: "端末から変更します。",
    });
    const html = renderSection();
    const notice = html.indexOf("変更しませんでした。");
    expect([
      notice >= 0,
      notice < html.indexOf("キー名、グループ名、値で絞り込む"),
    ]).toEqual([true, true]);
  });

  test("shows no notice while nothing is kept", () => {
    expect(renderSection()).not.toContain('role="alert"');
  });

  test("offers to lower a number that is on the list", () => {
    expect(renderSection()).toContain(">下げる<");
  });

  test("offers to stop a switch that is on", () => {
    const query = freshQuery(
      snapshotOf([
        { key: "implement_enabled", kind: "value", value: true, masked: false },
      ]),
    );
    expect(renderSection(query)).toContain(">止める<");
  });

  test("offers to stop design_enabled while it is on", () => {
    const query = freshQuery(
      snapshotOf([
        { key: "design_enabled", kind: "value", value: true, masked: false },
      ]),
    );
    expect(renderSection(query)).toContain("design_enabledを止める");
  });

  test("offers nothing for design_enabled_since", () => {
    const query = freshQuery(
      snapshotOf([
        {
          key: "design_enabled_since",
          kind: "value",
          value: "2026-11-01T00:00:00Z",
          masked: false,
        },
      ]),
    );
    expect(renderSection(query)).not.toContain(">止める<");
  });

  test("offers nothing for a switch that is already off", () => {
    const query = freshQuery(
      snapshotOf([
        {
          key: "implement_enabled",
          kind: "value",
          value: false,
          masked: false,
        },
      ]),
    );
    expect(renderSection(query)).not.toContain(">止める<");
  });

  test("offers nothing for an item that is not on the list", () => {
    const query = freshQuery(
      snapshotOf([
        { key: "owners", kind: "value", value: true, masked: false },
      ]),
    );
    expect(renderSection(query)).not.toContain(">止める<");
  });

  test("keeps the sentences of the confirmation out of the page until the dialog opens", () => {
    expect(renderSection()).not.toContain("元に戻すには");
  });

  test("shows the items", () => {
    expect(renderSection()).toContain("owners");
  });

  test("shows the design stage that is in effect", () => {
    const query = freshQuery({
      ...SNAPSHOT,
      design_stage: { enabled: true, ignored: false, indeterminate: false },
    });
    expect(designRowOf(renderSection(query))).toContain(">有効<");
  });

  test("shows a closed design stage as off", () => {
    const query = freshQuery({
      ...SNAPSHOT,
      design_stage: { enabled: false, ignored: false, indeterminate: false },
    });
    expect(designRowOf(renderSection(query))).toContain(">無効<");
  });

  test("tells that the written value is ignored", () => {
    const query = freshQuery({
      ...SNAPSHOT,
      design_stage: { enabled: false, ignored: true, indeterminate: false },
    });
    expect(designRowOf(renderSection(query))).toContain(
      "design_enabled_sinceが無いか日時として読めないため、無視しています。",
    );
  });

  test("does not tell that a value is ignored when it is not", () => {
    const query = freshQuery({
      ...SNAPSHOT,
      design_stage: { enabled: true, ignored: false, indeterminate: false },
    });
    expect(renderSection(query)).not.toContain("無視しています");
  });

  test("shows that the design stage cannot be told when a reference holds it", () => {
    const query = freshQuery({
      ...SNAPSHOT,
      design_stage: { enabled: false, ignored: false, indeterminate: true },
    });
    expect(designRowOf(renderSection(query))).toContain(">判定できない<");
  });

  test("tells why the design stage cannot be told", () => {
    const query = freshQuery({
      ...SNAPSHOT,
      design_stage: { enabled: false, ignored: false, indeterminate: true },
    });
    expect(designRowOf(renderSection(query))).toContain(
      "参照で書かれているため、効いている値をここでは判定できません。",
    );
  });

  test("does not call an indeterminate design stage off", () => {
    const query = freshQuery({
      ...SNAPSHOT,
      design_stage: { enabled: false, ignored: false, indeterminate: true },
    });
    const row = designRowOf(renderSection(query));
    expect([row.includes(">判定できない<"), row.includes(">無効<")]).toEqual([
      true,
      false,
    ]);
  });

  test("shows no design stage when the backend does not send it", () => {
    expect(renderSection(freshQuery(SNAPSHOT))).not.toContain("設計工程");
  });

  test("has no card for the design stage above the groups", () => {
    const query = freshQuery({
      ...SNAPSHOT,
      design_stage: { enabled: true, ignored: false, indeterminate: false },
    });
    const html = renderSection(query);
    expect(html.slice(0, html.indexOf("<h3"))).not.toContain("設計工程");
  });

  test("puts the design stage first in the design group", () => {
    const query = freshQuery(
      snapshotWithStage(
        [
          { key: "design_enabled", kind: "value", value: true, masked: false },
          {
            key: "max_design_attempts",
            kind: "value",
            value: 3,
            masked: false,
          },
        ],
        { enabled: true, ignored: false, indeterminate: false },
      ),
    );
    const whole = renderSection(query).replaceAll("<wbr/>", "");
    const html = whole.slice(whole.indexOf('id="config-group-design"'));
    const stageAt = html.indexOf(DESIGN_ROW_LABEL);
    expect(stageAt >= 0 && stageAt < html.indexOf("design_enabled")).toBe(true);
  });

  test("shows the design group for the design stage when the config has no design item", () => {
    const query = freshQuery(
      snapshotWithStage(
        [{ key: "owners", kind: "value", value: ["a"], masked: false }],
        { enabled: false, ignored: false, indeterminate: false },
      ),
    );
    expect(renderSection(query)).toMatch(
      /<h3 id="config-group-design"[^>]*>設計<\/h3>/,
    );
  });

  test("shows the design stage row in the design group, not under the other groups", () => {
    const query = freshQuery(
      snapshotWithStage(
        [{ key: "owners", kind: "value", value: ["a"], masked: false }],
        { enabled: false, ignored: false, indeterminate: false },
      ),
    );
    const html = renderSection(query);
    expect(html.indexOf(DESIGN_ROW_LABEL)).toBeGreaterThan(
      html.indexOf("config-group-design"),
    );
  });

  test("names the design stage row so that it is not read as a key of the config", () => {
    const query = freshQuery({
      ...SNAPSHOT,
      design_stage: { enabled: true, ignored: false, indeterminate: false },
    });
    const header = designRowHeaderOf(renderSection(query));
    expect([header !== "", header.includes("font-mono")]).toEqual([
      true,
      false,
    ]);
  });

  test("shows no button in the operation column of the design stage row", () => {
    const query = freshQuery(
      snapshotWithStage(
        [{ key: "design_enabled", kind: "value", value: true, masked: false }],
        { enabled: true, ignored: false, indeterminate: false },
      ),
    );
    const row = designRowOf(renderSection(query));
    expect([row !== "", row.includes("<button")]).toEqual([true, false]);
  });

  test("says the items are stale after a failed refetch", () => {
    expect(
      renderSection(staleQuery(SNAPSHOT, new ApiFailure({ kind: "network" }))),
    ).toContain("前回取得した値を表示しています");
  });
});

/** 項目のキーで見つけた行。キーは折り返しの位置(wbr)を含むので外して探す。 */
function rowOfKey(html: string, key: string): string {
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? [];
  return (
    rows.find((row) => row.replaceAll("<wbr/>", "").includes(`>${key}<`)) ?? ""
  );
}

describe("ConfigList for a time", () => {
  const SINCE: ConfigItemView = {
    key: "design_enabled_since",
    kind: "value",
    value: "2026-11-03T00:10:00Z",
    masked: false,
  };

  function rowFor(item: ConfigItemView): string {
    return rowOfKey(
      renderToStaticMarkup(<ConfigList items={[item]} />),
      item.key,
    );
  }

  test("shows the time in Japan time in a short form", () => {
    expect(rowFor(SINCE)).toContain(">11/03 09:10<");
  });

  test("keeps the written string in the datetime attribute", () => {
    expect(rowFor(SINCE)).toContain(`<time dateTime="2026-11-03T00:10:00Z"`);
  });

  test("keeps the written string in the title", () => {
    expect(rowFor(SINCE)).toContain(`title="2026-11-03T00:10:00Z"`);
  });

  test("shows a string that is not a time as it is", () => {
    expect(rowFor({ ...SINCE, value: "soon" })).not.toContain("<time");
  });

  test("shows a time of any other key in the short form too", () => {
    expect(rowFor({ ...SINCE, key: "paused_until" })).toContain(
      ">11/03 09:10<",
    );
  });
});

describe("ConfigList for the notes of design_enabled", () => {
  const ON: ConfigItemView = {
    key: "design_enabled",
    kind: "value",
    value: true,
    masked: false,
  };
  const OFF: ConfigItemView = { ...ON, value: false };
  const IGNORED: DesignStageView = {
    enabled: false,
    ignored: true,
    indeterminate: false,
  };
  const UNKNOWN: DesignStageView = {
    enabled: false,
    ignored: false,
    indeterminate: true,
  };
  const IN_EFFECT: DesignStageView = {
    enabled: true,
    ignored: false,
    indeterminate: false,
  };

  function rowWith(item: ConfigItemView, stage?: DesignStageView): string {
    return rowOfKey(
      renderToStaticMarkup(<ConfigList items={[item]} designStage={stage} />),
      item.key,
    );
  }

  test("says that the written true is ignored", () => {
    expect(rowWith(ON, IGNORED)).toContain("無視中");
  });

  test("gives the reason of the ignoring in the row", () => {
    expect(rowWith(ON, IGNORED)).toContain(
      "design_enabled_since が無いか、日時として読めないためです。",
    );
  });

  test("still shows the badge of the written value", () => {
    expect(rowWith(ON, IGNORED)).toContain("有効");
  });

  test("says that the written true cannot be told", () => {
    expect(rowWith(ON, UNKNOWN)).toContain("判定できません");
  });

  test("says nothing when the written true is in effect", () => {
    expect(rowWith(ON, IN_EFFECT)).not.toMatch(/無視中|判定できません/);
  });

  test("says nothing about ignoring when the backend sends no stage", () => {
    expect(rowWith(ON)).not.toContain("無視中");
  });

  test("keeps the note of the ignoring when the row of the stage is hidden", () => {
    const html = renderToStaticMarkup(
      <ConfigList items={[ON]} designStage={IGNORED} hideDesignStageRow />,
    );
    expect([
      html.includes("設計工程(実際の状態)"),
      rowOfKey(html, "design_enabled").includes("無視中"),
    ]).toEqual([false, true]);
  });

  test("tells how to resume while it is written false", () => {
    expect(rowWith(OFF, IN_EFFECT)).toContain(
      "再開は端末から行います。design_enabled を true にし、design_enabled_since に新しい時刻を書きます",
    );
  });

  test("tells how to resume while the backend sends no stage", () => {
    expect(rowWith(OFF)).toContain("再開は端末から行います");
  });

  test("does not tell how to resume while it is written true", () => {
    expect(rowWith(ON, IN_EFFECT)).not.toContain("再開は端末から行います");
  });

  test("does not tell how to resume for another switch", () => {
    expect(
      rowWith({ ...OFF, key: "implement_enabled" }, IN_EFFECT),
    ).not.toContain("再開は端末から行います");
  });

  test("does not tell how to resume for a reference", () => {
    expect(
      rowWith({ key: "design_enabled", kind: "reference" }, IN_EFFECT),
    ).not.toContain("再開は端末から行います");
  });
});

describe("ConfigSection heading and hidden characters", () => {
  test("hides the heading that repeats the name of the tab", () => {
    expect(renderSection()).toMatch(
      /<h2 id="config-heading"[^>]*class="[^"]*sr-only[^"]*"[^>]*>設定<\/h2>/,
    );
  });

  test("replaces them in the key of an item", () => {
    expect(
      renderToStaticMarkup(
        <ConfigList
          items={[{ key: "a\u202Eb", kind: "value", value: 1, masked: false }]}
        />,
      ),
    ).not.toContain("\u202E");
  });

  test("replaces the escape of an ANSI sequence in a value", () => {
    expect(
      renderToStaticMarkup(
        <ConfigList
          items={[
            { key: "k", kind: "value", value: "\u001b[31mred", masked: false },
          ]}
        />,
      ),
    ).not.toContain("\u001b");
  });

  test("replaces them in a value inside a structure", () => {
    expect(
      renderToStaticMarkup(
        <ConfigList
          items={[
            { key: "k", kind: "value", value: ["a\u202Eb"], masked: false },
          ]}
        />,
      ),
    ).not.toContain("\u202E");
  });
});

describe("ConfigList with the changes", () => {
  const offers: string[] = [];

  test("shows no button when no handler is given", () => {
    expect(renderToStaticMarkup(<ConfigList items={ITEMS} />)).not.toContain(
      "下げる",
    );
  });

  test("shows a button for a number that is on the list when a handler is given", () => {
    expect(
      renderToStaticMarkup(
        <ConfigList
          items={ITEMS}
          onChoose={(offer) => {
            offers.push(offer.key);
          }}
        />,
      ),
    ).toContain("下げる");
  });

  test("names the item in the label of the button", () => {
    expect(
      renderToStaticMarkup(
        <ConfigList items={ITEMS} onChoose={() => undefined} />,
      ),
    ).toContain("daily_budget_usdを下げる");
  });
});

describe("ConfigList with the changes of a list", () => {
  const REPOS = [
    "https://github.com/octo-owner/atelier-works",
    "https://github.com/octo-owner/widgets",
  ];

  function listItem(
    key: string,
    value: unknown,
    masked = false,
  ): ConfigItemView {
    return { key, kind: "value", value, masked };
  }

  function renderList(
    items: ConfigItemView[],
    options: { locked?: boolean; editable?: boolean } = {},
  ): string {
    const { locked = false, editable = true } = options;
    return renderToStaticMarkup(
      <ConfigList
        items={items}
        {...(editable
          ? { onChoose: () => undefined, isLocked: () => locked }
          : {})}
      />,
    );
  }

  /** `aria-label`が`label`のボタンの開始タグ。 */
  function buttonTag(html: string, label: string): string | undefined {
    return html
      .match(/<button[^>]*>/g)
      ?.find((tag) => tag.includes(`aria-label="${label}"`));
  }

  test("puts a button to remove beside each element", () => {
    const html = renderList([listItem("repo_allowlist", REPOS)]);
    expect([
      buttonTag(html, `repo_allowlistから${REPOS[0]}を削除`) !== undefined,
      buttonTag(html, `repo_allowlistから${REPOS[1]}を削除`) !== undefined,
    ]).toEqual([true, true]);
  });

  test("puts a button to add under the list", () => {
    const html = renderList([listItem("repo_allowlist", REPOS)]);
    expect(buttonTag(html, "repo_allowlistに追加")).toBeDefined();
  });

  test("labels the button to remove with the word for the action", () => {
    const html = renderList([listItem("default_reviewers", ["alice"])]);
    expect(html).toContain(">削除<");
  });

  test("labels the button to add with the word for the action", () => {
    const html = renderList([listItem("default_reviewers", ["alice"])]);
    expect(html).toContain(">追加<");
  });

  test("offers only to add to an empty list, and still says it is empty", () => {
    const html = renderList([listItem("dependabot_other_repos", [])]);
    expect([
      html.includes("空です。"),
      buttonTag(html, "dependabot_other_reposに追加") !== undefined,
      html.includes(">削除<"),
    ]).toEqual([true, true, false]);
  });

  test("keeps the meaning of an empty list beside the button to add", () => {
    const html = renderList([listItem("repo_allowlist", [])]);
    expect(html).toContain("ownersのアカウントのリポジトリすべてが対象です");
  });

  test("shows no button to remove the last element of repo_allowlist", () => {
    const html = renderList([listItem("repo_allowlist", [REPOS[0]])]);
    expect(html).not.toContain(">削除<");
  });

  test("tells why the last element of repo_allowlist cannot be removed", () => {
    const html = renderList([listItem("repo_allowlist", [REPOS[0]])]);
    expect(html).toContain(
      "最後の1件は削除できません。空だと owners 配下の全リポジトリが対象になります",
    );
  });

  test("still shows the last element of repo_allowlist", () => {
    const html = renderList([listItem("repo_allowlist", [REPOS[0]])]);
    expect(html).toContain("https://github.com/octo-owner/atelier-works");
  });

  test("tells nothing about the last element when repo_allowlist has two", () => {
    const html = renderList([listItem("repo_allowlist", REPOS)]);
    expect(html).not.toContain("最後の1件は削除できません");
  });

  test("lets the last element of another list be removed", () => {
    const html = renderList([listItem("default_reviewers", ["alice"])]);
    expect(buttonTag(html, "default_reviewersからaliceを削除")).toBeDefined();
  });

  test("keeps every button off while the item is being changed", () => {
    const html = renderList([listItem("default_reviewers", ["alice", "bob"])], {
      locked: true,
    });
    const tags = html.match(/<button[^>]*>/g) ?? [];
    expect(tags.map((tag) => tag.includes('disabled=""'))).toEqual([
      true,
      true,
      true,
    ]);
  });

  test("leaves every button on while nothing is being changed", () => {
    const html = renderList([listItem("default_reviewers", ["alice", "bob"])]);
    const tags = html.match(/<button[^>]*>/g) ?? [];
    expect(tags.map((tag) => tag.includes('disabled=""'))).toEqual([
      false,
      false,
      false,
    ]);
  });

  test("shows no button when no handler is given", () => {
    const html = renderList([listItem("default_reviewers", ["alice"])], {
      editable: false,
    });
    expect(html).not.toContain("<button");
  });

  test("shows the elements as a list when no handler is given", () => {
    const html = renderList([listItem("default_reviewers", ["alice"])], {
      editable: false,
    });
    expect(html).toContain("alice");
  });

  test("shows no button for a list that was masked", () => {
    const html = renderList([listItem("default_reviewers", ["alice"], true)]);
    expect(html).not.toContain("<button");
  });

  test("shows no button for a list that is a reference", () => {
    const html = renderList([{ key: "default_reviewers", kind: "reference" }]);
    expect(html).not.toContain("<button");
  });

  test("shows no button for a list that holds a number", () => {
    const html = renderList([listItem("default_reviewers", ["alice", 1])]);
    expect(html).not.toContain("<button");
  });

  test("shows no button for a list that holds a reference", () => {
    const html = renderList([
      listItem("default_reviewers", ["alice", "$var:f/factory/token"]),
    ]);
    expect(html).not.toContain("<button");
  });

  test("shows no button for a list that is not allowed to change", () => {
    const html = renderList([listItem("allowed_check_commands", ["bun test"])]);
    expect(html).not.toContain("<button");
  });

  test("writes an element as text in the label of its button", () => {
    const html = renderList([
      listItem("default_reviewers", ["<img src=x onerror=alert(1)>", "bob"]),
    ]);
    expect(html).not.toContain("<img");
  });

  test("replaces hidden characters in the label of the button", () => {
    const html = renderList([listItem("default_reviewers", ["a‮b"])]);
    expect(html).not.toContain("‮");
  });
});

describe("ListChangeButton", () => {
  const ADD = {
    kind: "add",
    key: "default_reviewers",
    current: ["alice"],
  } as const;
  const REMOVE = {
    kind: "remove",
    key: "default_reviewers",
    current: ["alice"],
    index: 0,
    element: "alice",
  } as const;

  test("hands the offer to the handler when the button to add is pressed", () => {
    const chosen: unknown[] = [];
    ListChangeButton({
      offer: ADD,
      locked: false,
      onChoose: (offer) => {
        chosen.push(offer);
      },
    }).props.onClick();
    expect(chosen).toEqual([ADD]);
  });

  test("hands the offer to the handler when the button to remove is pressed", () => {
    const chosen: unknown[] = [];
    ListChangeButton({
      offer: REMOVE,
      locked: false,
      onChoose: (offer) => {
        chosen.push(offer);
      },
    }).props.onClick();
    expect(chosen).toEqual([REMOVE]);
  });

  test("keeps the button off while the item is being changed", () => {
    const element = ListChangeButton({
      offer: ADD,
      locked: true,
      onChoose: () => undefined,
    });
    expect(element.props.disabled).toBe(true);
  });
});
