import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { FlowGraph } from "../../lib/flowGraph.ts";
import type {
  FlowGraphState,
  NodeActivity,
  ScheduleRun,
} from "../../lib/flowOverlay.ts";
import { FlowGraphDiagram, FlowGraphList } from "./FlowGraphDiagram.tsx";

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

const GRAPH: FlowGraph = {
  nodes: [
    {
      id: "schedule:poll_issues",
      kind: "schedule",
      label: "poll_issues",
      note: "0 */5 * * * *",
    },
    {
      id: "script:poll_issues",
      kind: "script",
      label: "poll_issues",
      note: "",
    },
    {
      id: "flow:pipeline",
      kind: "flow",
      label: "pipeline",
      note: "要件定義の生成と承認",
    },
    { id: "flow:pr_fix", kind: "flow", label: "pr_fix", note: "" },
  ],
  edges: [
    {
      from: "schedule:poll_issues",
      to: "script:poll_issues",
      kind: "schedule",
    },
    { from: "script:poll_issues", to: "flow:pipeline", kind: "run" },
  ],
};

function state(
  activity: Record<string, NodeActivity> = {},
  options: {
    lowerBound?: boolean;
    runs?: Record<string, ScheduleRun>;
    activeFailed?: boolean;
  } = {},
): FlowGraphState {
  return {
    overlay: {
      activity: new Map(Object.entries(activity)),
      lowerBound: options.lowerBound ?? false,
    },
    scheduleRuns: new Map(Object.entries(options.runs ?? {})),
    activeFailed: options.activeFailed ?? false,
    schedulesFailed: false,
  };
}

function render(element: ReactElement): string {
  return renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>);
}

const RUNNING: NodeActivity = { running: 1, queued: 0, runningJobId: ID };

/** 1つのノードのリンクの中身。 */
function nodeOf(html: string, href: string): string {
  const match = new RegExp(`<a[^>]*href="${href}"[^>]*>([\\s\\S]*?)</a>`).exec(
    html,
  );
  return match?.[1] ?? "";
}

describe("flowOverlay on the diagram", () => {
  test("marks a running flow with a word", () => {
    const html = render(
      <FlowGraphDiagram
        graph={GRAPH}
        state={state({ "flow:pipeline": RUNNING })}
      />,
    );
    expect(nodeOf(html, `/jobs/${ID}`)).toContain("実行中");
  });

  test("marks a running flow with a symbol that assistive technology skips", () => {
    const html = render(
      <FlowGraphDiagram
        graph={GRAPH}
        state={state({ "flow:pipeline": RUNNING })}
      />,
    );
    expect(nodeOf(html, `/jobs/${ID}`)).toMatch(/aria-hidden="true"/);
  });

  test("does not mark a flow that does not run", () => {
    const html = render(
      <FlowGraphDiagram
        graph={GRAPH}
        state={state({ "flow:pipeline": RUNNING })}
      />,
    );
    expect(
      nodeOf(html, "/jobs\\?tab=history&amp;script=f%2Ffactory%2Fpr_fix"),
    ).toMatch(/^(?![\s\S]*実行中)[\s\S]*pr_fix/);
  });

  test("shows how many jobs wait for a flow", () => {
    const html = render(
      <FlowGraphDiagram
        graph={GRAPH}
        state={state({
          "flow:pr_fix": { running: 0, queued: 2, runningJobId: null },
        })}
      />,
    );
    expect(html).toContain("待ち2");
  });

  test("shows a lower bound when the queue was truncated", () => {
    const html = render(
      <FlowGraphDiagram
        graph={GRAPH}
        state={state(
          { "flow:pr_fix": { running: 0, queued: 2, runningJobId: null } },
          { lowerBound: true },
        )}
      />,
    );
    expect(html).toContain("待ち2以上");
  });

  test("shows the last run of a schedule entry", () => {
    const html = render(
      <FlowGraphDiagram
        graph={GRAPH}
        state={state(
          {},
          { runs: { "schedule:poll_issues": { success: false } } },
        )}
      />,
    );
    expect(html).toContain("直近 失敗・取消");
  });

  test("draws no mark when nothing runs", () => {
    const html = render(<FlowGraphDiagram graph={GRAPH} state={state()} />);
    expect(html).toMatch(/^(?![\s\S]*実行中)[\s\S]*pipeline/);
  });

  test("draws no mark while the state is not read", () => {
    const html = render(
      <FlowGraphDiagram
        graph={GRAPH}
        state={{
          overlay: null,
          scheduleRuns: null,
          activeFailed: true,
          schedulesFailed: false,
        }}
      />,
    );
    expect(html).toMatch(/^(?![\s\S]*実行中)[\s\S]*pipeline/);
  });
});

describe("FlowGraphDiagram", () => {
  const html = render(<FlowGraphDiagram graph={GRAPH} state={state()} />);

  test("is a labeled group of drawn nodes", () => {
    expect(html).toMatch(/<svg[^>]*aria-label="起動の関係の図"/);
  });

  test("writes the name of every node", () => {
    expect(
      ["poll_issues", "pipeline", "pr_fix"].every((name) =>
        html.includes(name),
      ),
    ).toBe(true);
  });

  test("writes the note of a node", () => {
    expect(html).toContain("要件定義の生成と承認");
  });

  test("links a flow to its history", () => {
    expect(html).toContain(
      'href="/jobs?tab=history&amp;script=f%2Ffactory%2Fpipeline"',
    );
  });

  test("links a schedule entry to the schedules", () => {
    expect(html).toContain('href="/jobs?tab=schedules"');
  });

  test("draws a schedule edge dashed", () => {
    expect(html).toMatch(/<line[^>]*stroke-dasharray="6 4"/);
  });

  test("draws a run edge solid", () => {
    expect(html).toMatch(/<line(?![^>]*stroke-dasharray)[^>]*>/);
  });

  test("takes every color from the tokens, so light and dark both work", () => {
    expect(html).not.toMatch(/(?:fill|stroke)="(?:#|rgb|hsl|oklch)/);
  });

  test("uses a token for the border of a node", () => {
    expect(html).toMatch(/class="[^"]*stroke-input/);
  });
});

describe("FlowGraphList", () => {
  test("lists each flow by name", () => {
    const html = render(<FlowGraphList graph={GRAPH} state={state()} />);
    expect(html).toContain("pr_fix");
  });

  test("does not list a script or a schedule", () => {
    const html = render(<FlowGraphList graph={GRAPH} state={state()} />);
    expect(html).toMatch(/^(?![\s\S]*0 \*\/5)[\s\S]*pr_fix/);
  });

  test("shows a running flow in words", () => {
    const html = render(
      <FlowGraphList
        graph={GRAPH}
        state={state({ "flow:pipeline": RUNNING })}
      />,
    );
    expect(html).toContain("実行中");
  });

  test("shows the waiting jobs with a lower bound", () => {
    const html = render(
      <FlowGraphList
        graph={GRAPH}
        state={state(
          { "flow:pr_fix": { running: 0, queued: 4, runningJobId: null } },
          { lowerBound: true },
        )}
      />,
    );
    expect(html).toContain("待ち4以上");
  });

  test("draws no svg", () => {
    const html = render(<FlowGraphList graph={GRAPH} state={state()} />);
    expect(html).toMatch(/^(?![\s\S]*<svg)[\s\S]*pr_fix/);
  });
});
