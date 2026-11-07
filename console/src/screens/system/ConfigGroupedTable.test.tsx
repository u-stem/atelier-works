import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { freshQuery } from "../../api/fakeSectionQuery.testing.ts";
import type { ConfigItemView } from "../../api/jobsQueries.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { ConfigList, ConfigSection } from "./ConfigSection.tsx";

function item(key: string, value: unknown): ConfigItemView {
  return { key, kind: "value", value, masked: false };
}

function renderItems(
  items: ConfigItemView[],
  onChoose?: () => undefined,
): string {
  return renderToStaticMarkup(
    <ConfigList
      items={items}
      {...(onChoose === undefined ? {} : { onChoose })}
    />,
  );
}

/** `key`の項目の行の、見出しのセルを除いたセルの中身。 */
function cellsOf(html: string, key: string): string[] {
  const row = (html.match(/<tr[^>]*>.*?<\/tr>/g) ?? []).find(
    (tr) => tr.includes('scope="row"') && tr.includes(`>${key}<`),
  );
  return (row?.split(/<td[^>]*>/).slice(1) ?? []).map((cell) =>
    cell.replace(/<\/td>.*$/, ""),
  );
}

const choose = () => undefined;

describe("ConfigList as grouped tables", () => {
  test("puts a heading over a group", () => {
    expect(renderItems([item("daily_budget_usd", 5)])).toMatch(
      /<h3[^>]*>モデルと予算<\/h3>/,
    );
  });

  test("names a table by the heading of its group", () => {
    const html = renderItems([item("daily_budget_usd", 5)]);
    const id = /<h3 id="([^"]+)"/.exec(html)?.[1];
    expect(html).toMatch(new RegExp(`<table[^>]*aria-labelledby="${id}"`));
  });

  test("gives each group a different heading id", () => {
    const html = renderItems([item("daily_budget_usd", 5), item("owners", [])]);
    const ids = [...html.matchAll(/<h3 id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(2);
  });

  test("names each table by its own heading", () => {
    const html = renderItems([item("daily_budget_usd", 5), item("owners", [])]);
    const ids = [...html.matchAll(/<h3 id="([^"]+)"/g)].map((m) => m[1]);
    const named = [
      ...html.matchAll(/<table[^>]*aria-labelledby="([^"]+)"/g),
    ].map((m) => m[1]);
    expect(named).toEqual(ids);
  });

  test("makes no region landmark of a group", () => {
    expect(renderItems([item("daily_budget_usd", 5)])).not.toContain(
      "<section",
    );
  });

  test("shows no heading for a group that has no item", () => {
    expect(renderItems([item("daily_budget_usd", 5)])).not.toContain(
      "対象リポジトリ",
    );
  });

  test("puts an item that no group holds under その他", () => {
    expect(renderItems([item("brand_new_key", 5)])).toMatch(
      /<h3[^>]*>その他<\/h3>/,
    );
  });

  test("gives a table with a button the columns item, value, and operation", () => {
    expect(renderItems([item("daily_budget_usd", 5)], choose)).toMatch(
      /<th[^>]*scope="col"[^>]*>項目<\/th><th[^>]*scope="col"[^>]*>値<\/th><th[^>]*scope="col"[^>]*>操作<\/th>/,
    );
  });

  test("gives a table without a button the columns item and value", () => {
    expect(renderItems([item("model", "opus")], choose)).toMatch(
      /<th[^>]*scope="col"[^>]*>項目<\/th><th[^>]*scope="col"[^>]*>値<\/th><\/tr>/,
    );
  });

  test("leaves the heading of the operation out of a table without a button", () => {
    expect(renderItems([item("model", "opus")], choose)).not.toContain(
      ">操作<",
    );
  });

  test("leaves the heading of the operation out when nothing can be chosen", () => {
    expect(renderItems([item("daily_budget_usd", 5)])).not.toContain(">操作<");
  });

  test("leaves the heading of the operation out of a group of lists only", () => {
    expect(
      renderItems([item("default_reviewers", ["alice"])], choose),
    ).not.toContain(">操作<");
  });

  test("gives a row of a table without a button one cell", () => {
    const html = renderItems([item("model", "opus")], choose);
    expect(cellsOf(html, "model").length).toBe(1);
  });

  test("keeps the cell of the operation of a row without a button in a table with one", () => {
    const html = renderItems(
      [item("max_turns", "x"), item("daily_budget_usd", 5)],
      choose,
    );
    expect(cellsOf(html, "max_turns").length).toBe(2);
  });

  test("keeps the column headings for a reader when the table is stacked", () => {
    expect(renderItems([item("daily_budget_usd", 5)])).toMatch(
      /<thead[^>]*sr-only[^>]*>/,
    );
  });

  test("makes the key the header of its row", () => {
    expect(renderItems([item("daily_budget_usd", 5)])).toMatch(
      /<th[^>]*scope="row"[^>]*>daily_budget_usd<\/th>/,
    );
  });
});

describe("ConfigList roles of a stacked table", () => {
  const html = renderItems([item("daily_budget_usd", 5)], choose);

  test("says the table role outright", () => {
    expect(html).toMatch(/<table[^>]*role="table"/);
  });

  test("says the row role outright", () => {
    expect(html).toMatch(/<tr[^>]*role="row"/);
  });

  test("says the group of rows role outright", () => {
    expect(html).toMatch(/<tbody[^>]*role="rowgroup"/);
  });

  test("says the group of the heading row role outright", () => {
    expect(html).toMatch(/<thead[^>]*role="rowgroup"/);
  });

  test("says the column header role outright", () => {
    expect(html).toMatch(/<th(?=[^>]*scope="col")[^>]*role="columnheader"/);
  });

  test("says the row header role outright", () => {
    expect(html).toMatch(/<th(?=[^>]*scope="row")[^>]*role="rowheader"/);
  });

  test("says the cell role outright", () => {
    expect(html).toMatch(/<td[^>]*role="cell"/);
  });
});

describe("ConfigList values of a switch", () => {
  test("draws a true switch as the word 有効", () => {
    const html = renderItems([item("implement_enabled", true)]);
    expect(cellsOf(html, "implement_enabled")[0]).toContain("有効");
  });

  test("draws a false switch as the word 無効", () => {
    const html = renderItems([item("implement_enabled", false)]);
    expect(cellsOf(html, "implement_enabled")[0]).toContain("無効");
  });

  test("keeps the raw value of a true switch for a reader", () => {
    const html = renderItems([item("implement_enabled", true)]);
    expect(cellsOf(html, "implement_enabled")[0]).toMatch(
      /sr-only[^>]*>\(true\)</,
    );
  });

  test("hides the mark beside the word of a switch from a reader", () => {
    const html = renderItems([item("implement_enabled", true)]);
    expect(cellsOf(html, "implement_enabled")[0]).toMatch(
      /<svg[^>]*aria-hidden="true"/,
    );
  });

  test("keeps a true switch out of the color of success", () => {
    const html = renderItems([item("implement_enabled", true)]);
    expect(cellsOf(html, "implement_enabled")[0]).not.toContain("success");
  });

  test("keeps a false switch out of the color of success", () => {
    const html = renderItems([item("implement_enabled", false)]);
    expect(cellsOf(html, "implement_enabled")[0]).not.toContain("success");
  });

  test("draws a true switch with a strong border", () => {
    const html = renderItems([item("implement_enabled", true)]);
    expect(cellsOf(html, "implement_enabled")[0]).toContain(
      "border-foreground",
    );
  });

  test("draws a false switch with a faint border", () => {
    const html = renderItems([item("implement_enabled", false)]);
    expect(cellsOf(html, "implement_enabled")[0]).toMatch(
      /class="[^"]*border-border/,
    );
  });

  test("marks a true switch with a check", () => {
    const html = renderItems([item("implement_enabled", true)]);
    expect(cellsOf(html, "implement_enabled")[0]).toContain("lucide-check");
  });

  test("marks a false switch with a hyphen", () => {
    const html = renderItems([item("implement_enabled", false)]);
    expect(cellsOf(html, "implement_enabled")[0]).toContain("lucide-minus");
  });

  test("shows a string that spells true as the string", () => {
    const html = renderItems([item("factory_branch", "true")]);
    expect(cellsOf(html, "factory_branch")[0]).not.toContain("有効");
  });
});

describe("ConfigList values of a number", () => {
  test("puts the unit of the key after a number", () => {
    const html = renderItems([item("daily_budget_usd", 5)]);
    expect(cellsOf(html, "daily_budget_usd")[0]).toMatch(
      />5<\/span>\s*<span[^>]*>USD<\/span>/,
    );
  });

  test("shows a number whose key has no unit without one", () => {
    const html = renderItems([item("max_attempts", 3)]);
    expect(cellsOf(html, "max_attempts")[0]?.replace(/<[^>]*>/g, "")).toBe("3");
  });

  test("aligns a number to the right", () => {
    const html = renderItems([item("daily_budget_usd", 5)]);
    expect(cellsOf(html, "daily_budget_usd")[0]).toMatch(
      /class="[^"]*text-right[^"]*"[^>]*>5</,
    );
  });

  test("sets the digits of a number in tabular figures", () => {
    const html = renderItems([item("daily_budget_usd", 5)]);
    expect(cellsOf(html, "daily_budget_usd")[0]).toMatch(
      /class="[^"]*tabular-nums[^"]*"[^>]*>5</,
    );
  });
});

describe("ConfigList cell of the operation", () => {
  test("puts the button to lower a number in the cell of the operation", () => {
    const html = renderItems([item("daily_budget_usd", 5)], choose);
    expect(cellsOf(html, "daily_budget_usd")[1]).toContain(">下げる<");
  });

  test("puts the button to stop a switch in the cell of the operation", () => {
    const html = renderItems([item("implement_enabled", true)], choose);
    expect(cellsOf(html, "implement_enabled")[1]).toContain(">止める<");
  });

  test("keeps the button to lower out of the cell of the value", () => {
    const html = renderItems([item("daily_budget_usd", 5)], choose);
    expect(cellsOf(html, "daily_budget_usd")[0]).not.toContain(">下げる<");
  });

  test("keeps the buttons of a list in the cell of the value", () => {
    const html = renderItems([item("default_reviewers", ["alice"])], choose);
    expect(cellsOf(html, "default_reviewers")[0]).toContain(">削除<");
  });

  test("leaves the cell of the operation of a list without a button", () => {
    const html = renderItems(
      [item("default_reviewers", ["alice"]), item("max_fix_rounds", 3)],
      choose,
    );
    expect(cellsOf(html, "default_reviewers")[1]).not.toContain("<button");
  });

  test("keeps a reference hidden in the cell of the value", () => {
    const html = renderToStaticMarkup(
      <ConfigList items={[{ key: "owners", kind: "reference" }]} />,
    );
    expect(cellsOf(html, "owners")[0]).toContain("参照(出さない)");
  });
});

describe("ConfigSection width and groups", () => {
  const section = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <ConfigSection
          query={freshQuery({
            path: "f/factory/factory_config",
            items: [item("daily_budget_usd", 5)],
          })}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );

  test("widens the section of the config tab", () => {
    expect(section).toMatch(/<section[^>]*class="[^"]*max-w-6xl/);
  });

  test("groups the items under headings", () => {
    expect(section).toMatch(/<h3[^>]*>モデルと予算<\/h3>/);
  });

  test("keeps the description at the readable width", () => {
    expect(section).toMatch(
      /<div class="[^"]*max-w-3xl[^"]*"><h2 id="config-heading"/,
    );
  });

  test("keeps the groups out of the readable width", () => {
    const groups = section.slice(section.indexOf("<h3"));
    expect(groups).not.toContain("max-w-3xl");
  });

  test("keeps the card of the design stage at the readable width", () => {
    const withStage = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <ConfigSection
            query={freshQuery({
              path: "f/factory/factory_config",
              items: [item("daily_budget_usd", 5)],
              design_stage: {
                enabled: true,
                ignored: false,
                indeterminate: false,
              },
            })}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(withStage).toMatch(
      /<div[^>]*class="[^"]*max-w-3xl[^"]*"[^>]*><p><span[^>]*>設計工程/,
    );
  });
});
