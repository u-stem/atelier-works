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

  test("shows a structure as indented text in a preformatted block", () => {
    expect(renderToStaticMarkup(<ConfigList items={ITEMS} />)).toMatch(
      /<pre[^>]*>\[\n {2}&quot;a&quot;/,
    );
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
