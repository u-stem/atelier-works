import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiFailure } from "../../api/errors.ts";
import { freshQuery, staleQuery } from "../../api/fakeSectionQuery.testing.ts";
import type {
  ConfigItemView,
  ConfigSnapshotView,
} from "../../api/jobsQueries.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { ConfigList, ConfigSection } from "./ConfigSection.tsx";

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

function renderSection(query = freshQuery(SNAPSHOT)): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <ConfigSection query={query} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("ConfigList", () => {
  test("shows the key of every item", () => {
    expect(renderToStaticMarkup(<ConfigList items={ITEMS} />)).toContain(
      "daily_budget_usd",
    );
  });

  test("shows a scalar as text", () => {
    expect(renderToStaticMarkup(<ConfigList items={ITEMS} />)).toContain(">5<");
  });

  test("shows a boolean as text", () => {
    expect(renderToStaticMarkup(<ConfigList items={ITEMS} />)).toContain(
      ">false<",
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

  test("says when no key matches", () => {
    expect(renderToStaticMarkup(<ConfigList items={[]} />)).toContain(
      "該当する項目はありません",
    );
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

function renderValue(key: string, value: unknown): string {
  return renderToStaticMarkup(
    <ConfigList items={[{ key, kind: "value", value, masked: false }]} />,
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
      "ownersに含まれるリポジトリすべてが対象です(factory_repoは常に対象)",
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

describe("ConfigSection", () => {
  test("has a heading for the section", () => {
    expect(renderSection()).toMatch(/<h2 id="config-heading"[^>]*>設定<\/h2>/);
  });

  test("has a search box labeled by the key name", () => {
    expect(renderSection()).toMatch(/<label[^>]*>キー名で絞り込む<\/label>/);
  });

  test("says that only some items can be changed, and only one way", () => {
    expect(renderSection()).toContain(
      "止める向きと下げる向きの変更だけ、許可した項目でできます",
    );
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
    expect(renderSection(query)).toMatch(
      /設計工程: <\/span><span[^>]*>有効<\/span>/,
    );
  });

  test("shows a closed design stage as off", () => {
    const query = freshQuery({
      ...SNAPSHOT,
      design_stage: { enabled: false, ignored: false, indeterminate: false },
    });
    expect(renderSection(query)).toMatch(
      /設計工程: <\/span><span[^>]*>無効<\/span>/,
    );
  });

  test("tells that the written value is ignored", () => {
    const query = freshQuery({
      ...SNAPSHOT,
      design_stage: { enabled: false, ignored: true, indeterminate: false },
    });
    expect(renderSection(query)).toContain(
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
    expect(renderSection(query)).toMatch(
      /設計工程: <\/span><span[^>]*>判定できない<\/span>/,
    );
  });

  test("tells why the design stage cannot be told", () => {
    const query = freshQuery({
      ...SNAPSHOT,
      design_stage: { enabled: false, ignored: false, indeterminate: true },
    });
    expect(renderSection(query)).toContain(
      "参照で書かれているため、効いている値をここでは判定できません。",
    );
  });

  test("does not call an indeterminate design stage off", () => {
    const query = freshQuery({
      ...SNAPSHOT,
      design_stage: { enabled: false, ignored: false, indeterminate: true },
    });
    expect(renderSection(query)).not.toMatch(
      /設計工程: <\/span><span[^>]*>無効<\/span>/,
    );
  });

  test("shows no design stage when the backend does not send it", () => {
    expect(renderSection(freshQuery(SNAPSHOT))).not.toContain("設計工程");
  });

  test("says the items are stale after a failed refetch", () => {
    expect(
      renderSection(staleQuery(SNAPSHOT, new ApiFailure({ kind: "network" }))),
    ).toContain("前回取得した値を表示しています");
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
