import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { intakeTargetsQueryKey } from "../../api/intakeQueries.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { checkA11y } from "../../lib/a11yRules.ts";
import { NewPrReviewScreen } from "./NewPrReviewScreen.tsx";

function draw(targets?: readonly { owner: string; repo: string }[]): string {
  const client = new QueryClient();
  if (targets !== undefined) {
    client.setQueryData(intakeTargetsQueryKey, targets);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter>
          <NewPrReviewScreen />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** `list`属性を持つ入力、つまりリポジトリ欄の開始タグ。 */
function repoInput(html: string): string {
  return /<input[^>]*\blist="[^"]*"[^>]*>/.exec(html)?.[0] ?? "";
}

const TARGETS = [
  { owner: "octo-owner", repo: "atelier-works" },
  { owner: "octo-owner", repo: "widgets" },
];

describe("the initial state of the PR review intake screen", () => {
  test("starts with an empty repository field even when candidates exist", () => {
    expect(repoInput(draw(TARGETS))).toContain('value=""');
  });

  test("offers the candidates in the datalist", () => {
    expect(draw(TARGETS)).toContain('<option value="octo-owner/widgets"');
  });

  test("has the heading of the screen", () => {
    expect(draw(TARGETS)).toMatch(/<h1[^>]*>PRレビューの投入<\/h1>/);
  });

  test("links back to the list of work items", () => {
    expect(draw(TARGETS)).toContain('href="/items"');
  });

  test("labels the pull request field", () => {
    expect(draw(TARGETS)).toContain("PRの番号またはURL");
  });

  test("labels the submit button to start the review", () => {
    expect(draw(TARGETS)).toMatch(
      /<button[^>]*type="submit"[^>]*>レビューを投入する<\/button>/,
    );
  });

  test("starts with the submit button enabled", () => {
    expect(draw(TARGETS)).not.toMatch(
      /<button[^>]*disabled=""[^>]*type="submit"/,
    );
  });

  test("shows no problem before anything is sent", () => {
    expect(draw(TARGETS)).not.toContain("入力してください。");
  });

  test("shows no result before anything is sent", () => {
    expect(draw(TARGETS)).not.toContain('role="alert"');
  });

  test("has no a11y violations", () => {
    expect(checkA11y(draw(TARGETS))).toEqual([]);
  });
});
