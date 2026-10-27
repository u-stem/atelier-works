import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { TooltipProvider } from "../components/ui/tooltip.tsx";
import { Sidebar } from "./Sidebar.tsx";

function render(): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <TooltipProvider>
          <Sidebar onOpenHelp={() => undefined} />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 「ショートカット」の名前を持つボタンの開始タグ。 */
function helpButtons(html: string): string[] {
  return (
    html.match(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/g) ?? []
  ).filter((button) => button.includes("ショートカット"));
}

describe("Sidebar", () => {
  test("help: opens from the sidebar button, which names the shortcuts", () => {
    expect(helpButtons(render()).length).toBeGreaterThan(0);
  });

  test("announces that the button opens a dialog", () => {
    expect(
      helpButtons(render()).every((button) =>
        button.includes('aria-haspopup="dialog"'),
      ),
    ).toBe(true);
  });

  test("puts the button in the drawer and in the side bar", () => {
    expect(helpButtons(render()).length).toBe(2);
  });
});
