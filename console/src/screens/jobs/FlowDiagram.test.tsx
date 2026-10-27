import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { StepViewData } from "../../api/jobsQueries.ts";
import { entryText, flowDiagramModel } from "../../lib/flowDiagram.ts";
import type { GraphPresentation } from "../../lib/flowGraphFit.ts";
import { FLOWS_DATA, findFlow } from "../../lib/flowsData.ts";
import { FlowDiagramFrame } from "./FlowDiagram.tsx";

const STEP_JOB = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";

/** 実行中のステップの箱の面と枠。 */
const HIGHLIGHT = "fill-selected stroke-primary";

function flowOf(name: string) {
  const flow = findFlow(FLOWS_DATA, name);
  if (flow === null) throw new Error(`no flow ${name}`);
  return flow;
}

function step(
  id: string,
  state: string,
  options: { skipped?: boolean; jobId?: string | null } = {},
): StepViewData {
  return {
    id,
    state,
    job_id: options.jobId ?? null,
    iterations: null,
    skipped: options.skipped ?? false,
  };
}

function render(
  name: string,
  options: {
    progress?: readonly StepViewData[] | null;
    presentation?: GraphPresentation;
  } = {},
): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <FlowDiagramFrame
        model={flowDiagramModel(flowOf(name), options.progress ?? null)}
        presentation={options.presentation ?? "fit"}
      />
    </MemoryRouter>,
  );
}

function countOf(html: string, word: string): number {
  return html.split(word).length - 1;
}

describe("FlowDiagramFrame: the content", () => {
  test("is a labeled group named after the flow", () => {
    expect(render("pr_fix")).toContain('role="group" aria-label="pr_fixの図"');
  });

  test("writes the summary of every step", () => {
    const html = render("pr_fix");

    expect(
      flowOf("pr_fix").steps.filter(
        (s) => !html.includes(s.summary.slice(0, 6)),
      ),
    ).toEqual([]);
  });

  test("writes the id of every step", () => {
    const html = render("pr_fix");

    expect(flowOf("pr_fix").steps.filter((s) => !html.includes(s.id))).toEqual(
      [],
    );
  });

  test("draws the steps in the order of the definition", () => {
    const html = render("pr_fix");
    const positions = flowOf("pr_fix").steps.map((s) => html.indexOf(s.id));

    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test("writes every entry", () => {
    const html = render("pr_fix");

    expect(
      flowOf("pr_fix").entries.filter(
        (entry) => !html.includes(entryText(entry)),
      ),
    ).toEqual([]);
  });

  test("marks a conditional step with the word 条件で飛ぶ", () => {
    expect(render("pipeline")).toContain("条件で飛ぶ");
  });

  test("draws no word of a state when nothing overlays", () => {
    expect(render("pipeline")).not.toContain("実行中");
  });
});

describe("FlowDiagramFrame: the exits", () => {
  test("writes the approve exit of pipeline", () => {
    expect(render("pipeline")).toContain("承認の後: implement");
  });

  test("writes the reject exit of pipeline", () => {
    expect(render("pipeline")).toContain("却下の後: pipeline");
  });

  test("links the approve exit to the diagram of implement", () => {
    expect(render("pipeline")).toContain('href="/jobs/flows/implement"');
  });

  test("links the reject exit to the diagram of pipeline itself", () => {
    expect(render("pipeline")).toContain('href="/jobs/flows/pipeline"');
  });

  test("draws no approval exit on design", () => {
    expect(render("design")).not.toContain("承認の後");
  });

  test("shows no mark of implement_enabled on an exit", () => {
    expect(render("pipeline")).not.toContain("設定で");
  });

  test("links the exit of a launching step to the next flow", () => {
    expect(render("pr_fix")).toContain('href="/jobs/flows/pipeline"');
  });
});

describe("FlowDiagramFrame: the state of a running job", () => {
  const steps = [
    step("prepare", "success"),
    step("generate", "running", { jobId: STEP_JOB }),
    step("request_approval", "waiting"),
  ];

  test("marks the running step with the word", () => {
    expect(render("pipeline", { progress: steps })).toContain("実行中");
  });

  test("marks the running step with a symbol that screen readers skip", () => {
    expect(render("pipeline", { progress: steps })).toContain(
      'aria-hidden="true" points=',
    );
  });

  test("highlights the frame of the running step", () => {
    expect(render("pipeline", { progress: steps })).toContain(HIGHLIGHT);
  });

  test("highlights only the running step", () => {
    expect(countOf(render("pipeline", { progress: steps }), HIGHLIGHT)).toBe(1);
  });

  test("names the word of a waiting step", () => {
    expect(render("pipeline", { progress: steps })).toContain("待機中");
  });

  test("shows a failed step with the word 失敗", () => {
    expect(
      render("pipeline", { progress: [step("prepare", "failure")] }),
    ).toContain("失敗");
  });

  test("does not highlight a failed step as a running one", () => {
    expect(
      render("pipeline", { progress: [step("prepare", "failure")] }),
    ).not.toContain(HIGHLIGHT);
  });

  test("names a step that the condition skipped スキップ", () => {
    expect(
      render("pipeline", {
        progress: [step("generate", "success", { skipped: true })],
      }),
    ).toContain("スキップ");
  });

  test("links a step to its job", () => {
    expect(render("pipeline", { progress: steps })).toContain(
      `href="/jobs/${STEP_JOB}"`,
    );
  });

  test("names the link of a step by the step", () => {
    expect(render("pipeline", { progress: steps })).toContain(
      "generateのログと結果を見る",
    );
  });

  test("does not link a step that has no job", () => {
    expect(
      render("pipeline", { progress: [step("prepare", "success")] }),
    ).not.toContain('href="/jobs/0');
  });
});

describe("FlowDiagramFrame: the steps that the definition lacks", () => {
  const lacking = [step("prepare", "success"), step("old_step", "failure")];

  test("puts them after the diagram", () => {
    const html = render("pipeline", { progress: lacking });

    expect(html.indexOf("old_step")).toBeGreaterThan(html.indexOf("</svg>"));
  });

  test("says that they are not in the definition", () => {
    expect(render("pipeline", { progress: lacking })).toContain(
      "定義に無いステップ",
    );
  });

  test("shows their state", () => {
    const html = render("pipeline", { progress: lacking });

    expect(html.slice(html.indexOf("定義に無いステップ"))).toContain("失敗");
  });

  test("says nothing when every step is in the definition", () => {
    expect(
      render("pipeline", { progress: [step("prepare", "success")] }),
    ).not.toContain("定義に無いステップ");
  });

  test("puts them after the list in the narrow presentation", () => {
    const html = render("pipeline", {
      progress: lacking,
      presentation: "list",
    });

    expect(html.indexOf("old_step")).toBeGreaterThan(
      html.indexOf('aria-label="出口"'),
    );
  });
});

describe("FlowDiagramFrame: the keyboard and assistive technology", () => {
  test("gives every link a visible ring on focus", () => {
    const html = render("pipeline");
    const links = html.match(/<a [^>]*>/g) ?? [];

    expect(links.filter((tag) => !tag.includes("focus-visible"))).toEqual([]);
  });

  test("has links to reach", () => {
    expect(render("pipeline")).toContain("<a ");
  });

  test("names the link of an exit", () => {
    expect(render("pipeline")).toContain("承認の後: implementの図を開く");
  });

  test("scrolls inside a focusable region when the diagram does not fit", () => {
    expect(render("pr_fix", { presentation: "scroll" })).toMatch(
      /role="region"[^>]*tabindex="0"|tabindex="0"[^>]*role="region"/,
    );
  });

  test("tells with the name of the region that it scrolls", () => {
    expect(render("pr_fix", { presentation: "scroll" })).toContain(
      "横にスクロールできます",
    );
  });

  test("draws no scroll region when the diagram fits", () => {
    expect(render("pr_fix", { presentation: "fit" })).not.toContain(
      'role="region"',
    );
  });
});

describe("FlowDiagramFrame: light and dark", () => {
  test("takes every color from the tokens", () => {
    expect(
      render("pipeline", { progress: [step("prepare", "running")] }),
    ).not.toMatch(/(?:fill|stroke)="(?:#|rgb|hsl|oklch)/);
  });

  test("uses a token for the border of a box", () => {
    expect(render("pipeline")).toMatch(/class="[^"]*stroke-input/);
  });

  test("uses no color utility that ignores the theme", () => {
    expect(
      render("pipeline", { progress: [step("prepare", "failure")] }),
    ).not.toMatch(
      /\b(?:fill|stroke|bg|text)-(?:white|black|(?:slate|gray|zinc|red|green|blue)-\d+)\b/,
    );
  });
});

describe("FlowDiagramFrame: the narrow presentation", () => {
  test("draws a list instead of a diagram", () => {
    expect(render("pipeline", { presentation: "list" })).not.toContain("<svg");
  });

  test("lists the steps in order", () => {
    expect(render("pr_fix", { presentation: "list" })).toContain(
      'aria-label="pr_fixのステップ"',
    );
  });

  test("lists the entries before the steps and the exits after them", () => {
    const html = render("pipeline", { presentation: "list" });
    const entries = html.indexOf('aria-label="入口"');
    const steps = html.indexOf('aria-label="pipelineのステップ"');
    const exits = html.indexOf('aria-label="出口"');

    expect([entries < steps, steps < exits]).toEqual([true, true]);
  });

  test("groups the entries that come from the step of another flow in one item", () => {
    expect(render("pipeline", { presentation: "list" })).toContain(
      "他のflowのステップ: design、implement、manual_intake、pr_fix",
    );
  });

  test("does not list the grouped flows one by one", () => {
    expect(render("pipeline", { presentation: "list" })).not.toContain(
      "designのステップ",
    );
  });

  test("keeps the entry from a rejection apart from the group", () => {
    expect(render("pipeline", { presentation: "list" })).toContain(
      "pipelineの却下",
    );
  });

  test("shows the state of a step with a word", () => {
    expect(
      render("pipeline", {
        presentation: "list",
        progress: [step("prepare", "failure")],
      }),
    ).toContain("失敗");
  });

  test("links an exit in the list", () => {
    expect(render("pipeline", { presentation: "list" })).toContain(
      'href="/jobs/flows/implement"',
    );
  });

  test("links the job of a step in the list", () => {
    expect(
      render("pipeline", {
        presentation: "list",
        progress: [step("prepare", "success", { jobId: STEP_JOB })],
      }),
    ).toContain(`href="/jobs/${STEP_JOB}"`);
  });

  test("marks a conditional step in the list", () => {
    expect(render("pipeline", { presentation: "list" })).toContain(
      "条件で飛ぶ",
    );
  });
});
