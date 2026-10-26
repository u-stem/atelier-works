import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { JobDetailScreen } from "./JobDetailScreen.tsx";

function renderAt(path: string): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/jobs/:id" element={<JobDetailScreen />} />
        </Routes>
      </MemoryRouter>
    </TooltipProvider>,
  );
}

describe("JobDetailScreen with an id that is not a UUID", () => {
  test("says the job was not found", () => {
    expect(renderAt("/jobs/not-a-job")).toContain("ジョブが見つかりません");
  });

  test("gives the heading of the page", () => {
    expect(renderAt("/jobs/not-a-job")).toMatch(/<h1[^>]*>ジョブの詳細<\/h1>/);
  });

  test("goes back to the job list", () => {
    expect(renderAt("/jobs/not-a-job")).toContain('href="/jobs"');
  });

  test("does not echo the id the user typed", () => {
    expect(renderAt("/jobs/%3Cb%3Ex")).not.toContain("<b>x");
  });
});
