import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { JobSummaryView } from "../../api/jobsQueries.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { REDACTION_LIMIT_NOTE } from "../../lib/jobsView.ts";
import {
  ArgList,
  FailureCauses,
  JobOverview,
  OutputSection,
  StepList,
} from "./JobDetailParts.tsx";

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const CHILD = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const PARENT = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d";
const NOW = Date.parse("2026-10-26T05:10:00.000Z");

function render(element: ReactElement): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <MemoryRouter>{element}</MemoryRouter>
    </TooltipProvider>,
  );
}

const JOB: JobSummaryView = {
  id: ID,
  state: "failure",
  script_path: "f/factory/implement",
  job_kind: "flow",
  created_at: "2026-10-26T05:00:00.000000Z",
  started_at: "2026-10-26T05:00:01.000000Z",
  completed_at: "2026-10-26T05:00:03.000000Z",
  scheduled_for: null,
  duration_ms: 2000,
  schedule_path: "f/factory/collect_github",
  parent_job: PARENT,
  tag: "periodic",
  is_flow_step: false,
};

describe("JobOverview", () => {
  const html = render(
    <JobOverview job={JOB} now={NOW} relatedItemId={7} back={undefined} />,
  );

  test("says the state in words", () => {
    expect(html).toContain("失敗");
  });

  test("shows the whole script path", () => {
    expect(html).toContain("f/factory/implement");
  });

  test("shows the duration", () => {
    expect(html).toContain("2秒");
  });

  test("shows the schedule", () => {
    expect(html).toContain("f/factory/collect_github");
  });

  test("links the parent job to its detail", () => {
    expect(html).toContain(`href="/jobs/${PARENT}"`);
  });

  test("links the related work item built from its id", () => {
    expect(html).toContain('href="/items/7"');
  });

  test("offers Windmill only as a small secondary link", () => {
    expect(html).toContain(`href="/run/${ID}"`);
  });

  test("opens Windmill in another tab", () => {
    expect(html).toMatch(/href="\/run\/[^"]*"[^>]*target="_blank"/);
  });

  test("says Windmill in the label of that link", () => {
    expect(html).toContain("Windmillで開く");
  });

  test("shows no work item link without an id", () => {
    expect(
      render(
        <JobOverview
          job={JOB}
          now={NOW}
          relatedItemId={null}
          back={undefined}
        />,
      ),
    ).not.toContain('href="/items/');
  });

  test("shows no parent link for a root job", () => {
    expect(
      render(
        <JobOverview
          job={{ ...JOB, parent_job: null }}
          now={NOW}
          relatedItemId={null}
          back={undefined}
        />,
      ),
    ).not.toContain("親のジョブ");
  });
});

describe("ArgList", () => {
  test("shows the value of an allowed argument", () => {
    expect(
      render(
        <ArgList args={[{ key: "work_item_id", type: "number", value: 7 }]} />,
      ),
    ).toContain("work_item_id");
  });

  test("shows the value next to its key", () => {
    expect(
      render(
        <ArgList args={[{ key: "repo", type: "string", value: "my-repo" }]} />,
      ),
    ).toContain("my-repo");
  });

  test("shows only the key and the type of a hidden value", () => {
    const html = render(<ArgList args={[{ key: "body", type: "string" }]} />);
    expect(html).toContain("値は表示しません");
  });

  test("names the type of a hidden value", () => {
    expect(
      render(<ArgList args={[{ key: "body", type: "string" }]} />),
    ).toContain("string");
  });

  test("says when the job has no argument", () => {
    expect(render(<ArgList args={[]} />)).toContain("引数はありません");
  });

  test("writes a value as text, not as markup", () => {
    expect(
      render(
        <ArgList args={[{ key: "repo", type: "string", value: "<b>x</b>" }]} />,
      ),
    ).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("StepList", () => {
  test("links a step to the detail of its child job", () => {
    expect(
      render(
        <StepList
          steps={[
            {
              id: "prepare",
              state: "success",
              job_id: CHILD,
              iterations: null,
            },
          ]}
          back={undefined}
        />,
      ),
    ).toContain(`href="/jobs/${CHILD}"`);
  });

  test("names the module of the step", () => {
    expect(
      render(
        <StepList
          steps={[
            {
              id: "prepare",
              state: "success",
              job_id: CHILD,
              iterations: null,
            },
          ]}
          back={undefined}
        />,
      ),
    ).toContain("prepare");
  });

  test("says the state of the step in words", () => {
    expect(
      render(
        <StepList
          steps={[
            {
              id: "prepare",
              state: "failure",
              job_id: CHILD,
              iterations: null,
            },
          ]}
          back={undefined}
        />,
      ),
    ).toContain("失敗");
  });

  test("shows no link for a step that has no child job yet", () => {
    expect(
      render(
        <StepList
          steps={[
            { id: "verify", state: "waiting", job_id: null, iterations: null },
          ]}
          back={undefined}
        />,
      ),
    ).not.toContain("href=");
  });

  test("counts the iterations of a loop", () => {
    expect(
      render(
        <StepList
          steps={[
            { id: "each", state: "success", job_id: null, iterations: 4 },
          ]}
          back={undefined}
        />,
      ),
    ).toContain("4回繰り返し");
  });
});

describe("OutputSection", () => {
  function output(text: string, extra: Record<string, unknown> = {}) {
    return { text, truncated: false, masked: false, ...extra };
  }

  function section(
    text: string,
    props: Partial<Parameters<typeof OutputSection>[0]> = {},
  ): string {
    return render(
      <OutputSection
        id="log-heading"
        title="ログ"
        kind="log"
        output={output(text)}
        error={null}
        emptyText="ログはありません"
        {...props}
      />,
    );
  }

  test("writes markup in the output as text", () => {
    expect(section("<img src=x onerror=alert(1)>")).toContain("&lt;img src=x");
  });

  test("does not create an element from the output", () => {
    expect(section("<img src=x onerror=alert(1)>")).not.toContain("<img");
  });

  test("does not turn a URL into a link", () => {
    expect(section("see https://example.com/x")).not.toContain("<a ");
  });

  test("keeps the URL as plain text", () => {
    expect(section("see https://example.com/x")).toContain(
      "see https://example.com/x",
    );
  });

  test("does not read Markdown", () => {
    expect(section("**bold** and `code` and # head")).not.toMatch(
      /<(strong|em|code|h3|li)[ >]/,
    );
  });

  test("keeps the Markdown marks as text", () => {
    expect(section("**bold**")).toContain("**bold**");
  });

  test("does not interpret ANSI colors", () => {
    expect(section("\u001b[31mred\u001b[0m")).not.toContain("\u001b");
  });

  test("shows the rest of an ANSI sequence as plain text", () => {
    expect(section("\u001b[31mred")).toContain("[31mred");
  });

  test("does not style the text by the output", () => {
    expect(section("\u001b[31mred")).not.toContain("style=");
  });

  test("replaces a character that reorders the text", () => {
    expect(section("a‮b")).not.toContain("‮");
  });

  test("always states the limit of the redaction", () => {
    expect(section("x")).toContain(REDACTION_LIMIT_NOTE);
  });

  test("says when something was masked", () => {
    expect(section("x", { output: output("x", { masked: true }) })).toContain(
      "伏せた箇所があります",
    );
  });

  test("says a long log keeps its tail", () => {
    expect(
      section("x", { output: output("x", { truncated: true }) }),
    ).toContain("末尾だけを表示しています");
  });

  test("says a long result keeps its head", () => {
    expect(
      section("x", {
        kind: "result",
        output: output("x", { truncated: true }),
      }),
    ).toContain("先頭だけを表示しています");
  });

  test("counts the lines of the log that are not JSON", () => {
    expect(
      section("x", { output: output("x", { nonJsonLines: 2 }) }),
    ).toContain("JSONでない行が2行あります");
  });

  test("can take focus, so a long output scrolls from the keyboard", () => {
    expect(section("x")).toContain('tabindex="0"');
  });

  test("names the output by its heading", () => {
    expect(section("x")).toMatch(/<h2 id="log-heading"[^>]*>ログ<\/h2>/);
  });

  test("says when there is no output", () => {
    expect(section("", { output: null })).toContain("ログはありません");
  });

  test("says when the output is empty", () => {
    expect(section("")).toContain("ログはありません");
  });

  test("shows why a result could not be read", () => {
    expect(
      section("", { kind: "result", output: null, error: "timeout" }),
    ).toContain("timeout");
  });

  test("writes the reason as text", () => {
    expect(
      section("", { kind: "result", output: null, error: "<b>x</b>" }),
    ).not.toContain("<b>x</b>");
  });

  test("offers to refresh the log when asked to", () => {
    expect(
      section("x", { onRefresh: () => undefined, refreshLabel: "ログを更新" }),
    ).toContain("ログを更新");
  });

  test("offers no refresh otherwise", () => {
    expect(section("x")).not.toContain("<button");
  });
});

describe("FailureCauses", () => {
  test("shows the saved cause as text", () => {
    expect(
      render(
        <FailureCauses
          failures={{
            ok: true,
            items: [
              {
                step: "generate",
                error: "<i>boom</i>",
                occurred_at: "2026-10-26T05:00:02.000Z",
                job_id: CHILD,
              },
            ],
          }}
          now={NOW}
          back={undefined}
        />,
      ),
    ).toContain("&lt;i&gt;boom&lt;/i&gt;");
  });

  test("names the step that failed", () => {
    expect(
      render(
        <FailureCauses
          failures={{
            ok: true,
            items: [
              {
                step: "generate",
                error: "boom",
                occurred_at: "2026-10-26T05:00:02.000Z",
                job_id: null,
              },
            ],
          }}
          now={NOW}
          back={undefined}
        />,
      ),
    ).toContain("generate");
  });

  test("links the job the cause was saved for", () => {
    expect(
      render(
        <FailureCauses
          failures={{
            ok: true,
            items: [
              {
                step: null,
                error: "boom",
                occurred_at: "2026-10-26T05:00:02.000Z",
                job_id: CHILD,
              },
            ],
          }}
          now={NOW}
          back={undefined}
        />,
      ),
    ).toContain(`href="/jobs/${CHILD}"`);
  });

  test("says when no cause was saved", () => {
    expect(
      render(
        <FailureCauses
          failures={{ ok: true, items: [] }}
          now={NOW}
          back={undefined}
        />,
      ),
    ).toContain("保存された失敗の原因はありません");
  });

  test("says the saved causes could not be read", () => {
    expect(
      render(
        <FailureCauses
          failures={{ ok: false, reason: "db down" }}
          now={NOW}
          back={undefined}
        />,
      ),
    ).toContain("保存された原因を読めませんでした");
  });
});
