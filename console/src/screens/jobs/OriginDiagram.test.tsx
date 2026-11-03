import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { CONDITIONAL_EDGES_NOTE } from "../../lib/flowDiagram.ts";
import { FLOWS_DATA } from "../../lib/flowsData.ts";
import { type OriginRunView, originGraphModel } from "../../lib/originGraph.ts";
import { OriginDiagramView } from "./OriginDiagram.tsx";

const READY: OriginRunView = { kind: "ready", lastRun: "success", marks: [] };

function render(
  name: string,
  options: {
    run?: OriginRunView;
    width?: number;
    expanded?: readonly string[];
  } = {},
): string {
  if (FLOWS_DATA === null) throw new Error("flows.json is unreadable");
  const model = originGraphModel(FLOWS_DATA, name);
  if (model === null) throw new Error(`no schedule ${name}`);
  return renderToStaticMarkup(
    <MemoryRouter>
      <OriginDiagramView
        model={model}
        run={options.run ?? READY}
        width={options.width ?? 1200}
        expanded={new Set(options.expanded ?? [])}
        onToggle={() => {}}
      />
    </MemoryRouter>,
  );
}

/** タグを除いた文字。折り返して複数の行に分けた文字も、元の並びで読める。 */
function plain(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

function countOf(html: string, word: string): number {
  return html.split(word).length - 1;
}

/** 起点が起動するflowの名前。描画から独立に、データの`schedules[].flows`から重複を除いて作る。 */
function launchedBy(name: string): string[] {
  const schedule = FLOWS_DATA?.schedules.find((item) => item.name === name);
  return schedule === undefined ? [] : [...new Set(schedule.flows)];
}

/** 一覧の、起点のカードの出口の行の文字。出口の一覧が無ければ空にする。 */
function originExitsOf(html: string, name: string): string {
  const match = new RegExp(
    `<ul[^>]*aria-label="${name}の出口"[^>]*>(.*?)</ul>`,
  ).exec(html);
  return match === null ? "" : plain(match[1] ?? "");
}

const SCHEDULES_WITH_FLOWS = (FLOWS_DATA?.schedules ?? [])
  .map((schedule) => schedule.name)
  .filter((name) => launchedBy(name).length > 0);

/**
 * 起点から前進の辺(起動、承認、PR経由)でたどれるflowの出口に、PR経由があるか。
 * 描画から独立に、データの`schedules`と`flows[].exits`から作る。
 */
function hasPrExit(name: string): boolean {
  const seen = new Set<string>();
  const queue = [...launchedBy(name)];
  while (queue.length > 0) {
    const flowName = queue.pop();
    if (flowName === undefined || seen.has(flowName)) continue;
    seen.add(flowName);
    const flow = FLOWS_DATA?.flows.find((item) => item.name === flowName);
    for (const exit of flow?.exits ?? []) {
      if (exit.via === "pr") return true;
      if (exit.via === "launch" || exit.via === "approve") {
        queue.push(exit.flow);
      }
    }
  }
  return false;
}

const ALL_SCHEDULES = (FLOWS_DATA?.schedules ?? []).map(
  (schedule) => schedule.name,
);
const SCHEDULES_WITH_PR_EXIT = ALL_SCHEDULES.filter(hasPrExit);
const SCHEDULES_WITHOUT_PR_EXIT = ALL_SCHEDULES.filter(
  (name) => !hasPrExit(name),
);

const FIT = 1200;
const SCROLL = 900;
const LIST = 500;

/** PRを介した線を持たない図の凡例。 */
const LEGEND =
  "実線は起動の流れです。「承認」の線は承認の後の起動で、戻りは各flowの下に注記します。";

/** PRを介した出口を持つ一覧に添える、PR経由の行の説明。 */
const LIST_PR_NOTE =
  "PR経由の行は、定期ジョブがPRのラベルやCIの結果を見て起動する関係で、人のラベルを含みます。";

/** PRを介した線を持つ図の凡例。 */
const LEGEND_WITH_PR =
  "実線は起動の流れ、破線はPRを介した関係です。破線は、定期ジョブがPRのラベルやCIの結果を見て起動する関係で、人のラベルを含みます。「承認」の線は承認の後の起動で、戻りは各flowの下に注記します。";

describe("OriginDiagramView: the diagram", () => {
  test("is a labeled group named after the schedule", () => {
    expect(render("poll_issues")).toContain(
      'role="group" aria-label="poll_issuesの起動の図"',
    );
  });

  test("draws a line for each forward edge", () => {
    expect(countOf(render("poll_issues"), "<polyline")).toBe(6);
  });

  test("keeps the approval word for each approval line", () => {
    expect(countOf(render("poll_issues"), ">承認<")).toBe(3);
  });

  test("draws a dashed line with the word for a PR relation", () => {
    expect(
      render("self_update").match(
        /<polyline[^>]*stroke-dasharray="[^"]+"[^>]*>/g,
      ),
    ).toHaveLength(2);
  });

  test("puts the word on each PR line", () => {
    expect(countOf(render("poll_issues"), ">PR経由<")).toBe(2);
  });

  test("draws the line of a launch and an approval without a dash", () => {
    expect(
      render("poll_issues").match(/<polyline(?![^>]*stroke-dasharray)[^>]*>/g),
    ).toHaveLength(4);
  });

  test("puts no PR word on a diagram without a PR relation", () => {
    expect(render("audit_kickoff")).not.toContain(">PR経由<");
  });

  test("puts no PR word on the diagram that only notes the return", () => {
    expect(render("watch_pr_ci")).not.toContain(">PR経由<");
  });

  test("notes the return to pr_review under pr_fix", () => {
    expect(plain(render("watch_pr_ci"))).toContain("CI修正後の戻り: pr_review");
  });

  test("puts no word on the line that launches a flow", () => {
    expect(render("audit_kickoff")).not.toContain(">承認<");
  });

  test("writes the return to the design flow as a note, not as a line", () => {
    expect(plain(render("self_update"))).toContain("差し戻し: design");
  });

  test("draws the two lines of the origin and the two PR lines for self_update", () => {
    expect(countOf(render("self_update"), "<polyline")).toBe(4);
  });

  test("writes the rework that remakes the same flow", () => {
    expect(plain(render("poll_issues"))).toContain("やり直し");
  });

  test("says that a flow may not start when an approval or a return is drawn", () => {
    expect(plain(render("poll_issues"))).toContain(CONDITIONAL_EDGES_NOTE);
  });

  test("does not say it when every flow always starts", () => {
    expect(plain(render("audit_kickoff"))).not.toContain(
      CONDITIONAL_EDGES_NOTE,
    );
  });

  test("explains the lines in one legend", () => {
    expect(countOf(plain(render("poll_issues")), "実線")).toBe(1);
  });

  test("uses the legend with the dashed line for a diagram that has a PR line", () => {
    expect(plain(render("poll_issues"))).toContain(LEGEND_WITH_PR);
  });

  test.each(["audit_kickoff", "watch_pr_ci"])(
    "keeps the legend without the dashed line for %s",
    (name) => {
      expect(plain(render(name))).toContain(LEGEND);
    },
  );

  test.each(["audit_kickoff", "watch_pr_ci"])(
    "does not mention the dashed line in the diagram of %s",
    (name) => {
      expect(plain(render(name))).not.toContain("破線");
    },
  );

  test("writes the schedule in the origin box", () => {
    expect(plain(render("poll_prs"))).toContain("スケジュール");
  });

  test("writes the name of the schedule in the origin box", () => {
    expect(plain(render("poll_prs"))).toContain("poll_prs");
  });

  test("does not write the cron expression or the time zone in the origin box", () => {
    expect(plain(render("poll_prs"))).not.toContain("Asia/Tokyo");
  });

  test("writes the number of steps of each flow", () => {
    expect(plain(render("audit_kickoff"))).toContain("2ステップ");
  });

  test("draws a button for each flow heading", () => {
    expect(countOf(render("poll_prs"), 'role="button"')).toBe(2);
  });

  test("keeps the number of buttons when every flow is open", () => {
    expect(
      countOf(
        render("poll_prs", { expanded: ["pr_fix", "pr_review"] }),
        'role="button"',
      ),
    ).toBe(2);
  });

  test("makes each heading reachable by the keyboard", () => {
    expect(countOf(render("poll_prs"), 'role="button" tabindex="0"')).toBe(2);
  });

  test("names the button after the steps of the flow", () => {
    expect(render("poll_prs")).toContain('aria-label="pr_fixのステップ"');
  });

  test("tells that a closed flow is closed", () => {
    expect(countOf(render("poll_prs"), 'aria-expanded="false"')).toBe(2);
  });

  test("tells that an open flow is open", () => {
    expect(
      countOf(
        render("poll_prs", { expanded: ["pr_fix"] }),
        'aria-expanded="true"',
      ),
    ).toBe(1);
  });

  test("points to nothing with aria-controls, because a closed flow draws no target", () => {
    expect(render("poll_prs", { expanded: ["pr_fix"] })).not.toContain(
      "aria-controls",
    );
  });

  test("draws no step of a closed flow", () => {
    expect(plain(render("poll_prs"))).not.toContain("pr_fix_collect");
  });

  test("draws the id of every step of an open flow", () => {
    expect(plain(render("poll_prs", { expanded: ["pr_fix"] }))).toContain(
      "pr_fix_collect",
    );
  });

  test("draws the summary of a step of an open flow", () => {
    expect(plain(render("poll_prs", { expanded: ["pr_fix"] }))).toContain(
      "指摘の収集",
    );
  });

  test("links an open flow to the diagram of the flow", () => {
    expect(render("audit_kickoff", { expanded: ["audit"] })).toContain(
      'href="/jobs/flows/audit"',
    );
  });

  test("draws no link to the diagram of a closed flow", () => {
    expect(render("poll_prs")).not.toContain("/jobs/flows/");
  });

  test("names the link by its visible text and the flow", () => {
    expect(render("audit_kickoff", { expanded: ["audit"] })).toContain(
      'aria-label="flowの図: audit"',
    );
  });

  test("names the link of the list by its visible text and the flow", () => {
    expect(
      render("audit_kickoff", { width: LIST, expanded: ["audit"] }),
    ).toContain('aria-label="flowの図: audit"');
  });

  test("keeps the visible text of the heading button to the name that its label contains", () => {
    const button = /<g[^>]*role="button"[^>]*>((?:(?!<\/g>)[\s\S])*)<\/g>/.exec(
      render("poll_prs"),
    );

    expect(countOf(button?.[1] ?? "", "<text")).toBe(1);
  });

  test("keeps the link out of the heading button", () => {
    expect(render("audit_kickoff", { expanded: ["audit"] })).not.toMatch(
      /<g[^>]*role="button"[^>]*>(?:(?!<\/g>)[\s\S])*<a\b/,
    );
  });

  test("puts the heading before the link and the link before the next heading", () => {
    const html = render("poll_issues", {
      expanded: ["pipeline", "design", "implement"],
    });

    expect(
      [
        html.indexOf('aria-label="pipelineのステップ"'),
        html.indexOf('href="/jobs/flows/pipeline"'),
        html.indexOf('aria-label="designのステップ"'),
      ].every(
        (position, index, all) =>
          position >= 0 && position > (all[index - 1] ?? -1),
      ),
    ).toBe(true);
  });

  test("passes no state to the link to the diagram of a flow", () => {
    const source = readFileSync(
      new URL("./OriginDiagram.tsx", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/<Link[^>]*\sstate=/);
  });

  test("draws no select-all control", () => {
    expect(plain(render("poll_prs"))).not.toContain("すべて開く");
  });
});

describe("OriginDiagramView: a schedule that launches no flow", () => {
  test("says that it launches no flow", () => {
    expect(plain(render("cleanup_db"))).toContain(
      "この定期ジョブはflowを起動しません",
    );
  });

  test("draws no diagram", () => {
    expect(render("cleanup_db")).not.toContain("<svg");
  });

  test("draws no legend", () => {
    expect(plain(render("cleanup_db"))).not.toContain("実線");
  });
});

describe("OriginDiagramView: the run of the origin box", () => {
  const words = (run: OriginRunView, width = FIT) =>
    plain(render("poll_prs", { run, width }));

  test("says it is loading", () => {
    expect(words({ kind: "loading" })).toContain("読み込み中");
  });

  test("says the login is needed", () => {
    expect(words({ kind: "login" })).toContain("ログインが必要です");
  });

  test("says it could not be fetched", () => {
    expect(words({ kind: "failed" })).toContain("取得できませんでした");
  });

  test("says the workspace lacks the schedule", () => {
    expect(words({ kind: "missing" })).toContain("Windmillにありません");
  });

  test("says there is no record of a run", () => {
    expect(words({ kind: "ready", lastRun: "none", marks: [] })).toContain(
      "実行の記録がありません",
    );
  });

  test("says the last run succeeded", () => {
    expect(words(READY)).toContain("成功");
  });

  test("says the last run failed", () => {
    expect(words({ kind: "ready", lastRun: "failure", marks: [] })).toContain(
      "失敗・取消",
    );
  });

  test("writes the mark of a schedule that is not running", () => {
    expect(
      words({ kind: "ready", lastRun: "success", marks: ["無効"] }),
    ).toContain("無効");
  });

  test("writes no mark of a stop for a schedule that is running", () => {
    expect(words(READY)).not.toContain("無効");
  });

  test("writes the run in the list too", () => {
    expect(words({ kind: "failed" }, LIST)).toContain("取得できませんでした");
  });

  test("keeps the diagram while the run is loading", () => {
    expect(render("poll_prs", { run: { kind: "loading" } })).toContain(
      'role="group"',
    );
  });
});

describe("OriginDiagramView: the presentation by width", () => {
  test("draws the diagram as it is when it fits", () => {
    expect(render("self_update", { width: FIT })).not.toContain(
      'role="region"',
    );
  });

  test("puts the diagram of poll_issues in a scrollable region even in the widest body", () => {
    expect(render("poll_issues", { width: FIT })).toContain(
      "横にスクロールできます",
    );
  });

  test("puts the diagram in a scrollable region when it does not fit", () => {
    expect(render("poll_issues", { width: SCROLL })).toContain(
      "横にスクロールできます",
    );
  });

  test("keeps the diagram in the scrollable region", () => {
    expect(render("poll_issues", { width: SCROLL })).toContain('role="group"');
  });

  test("draws a list instead of a diagram in a narrow width", () => {
    expect(render("poll_issues", { width: LIST })).not.toContain(
      'role="group"',
    );
  });

  test("draws the list as disclosures", () => {
    expect(countOf(render("poll_prs", { width: LIST }), "<details")).toBe(2);
  });

  test("groups the list by column", () => {
    expect(plain(render("poll_issues", { width: LIST }))).toContain("5段目");
  });

  test("writes the PR relation as an exit in the list", () => {
    expect(plain(render("poll_issues", { width: LIST }))).toContain(
      "PR経由: pr_review",
    );
  });

  test("writes the exits of each flow in the list", () => {
    expect(plain(render("self_update", { width: LIST }))).toContain(
      "差し戻し: design",
    );
  });

  test.each(["self_update", "poll_prs"])(
    "lists the launch of pr_fix from the origin of %s, which skips a column",
    (name) => {
      expect(originExitsOf(render(name, { width: LIST }), name)).toContain(
        "次に起動: pr_fix",
      );
    },
  );

  test.each(SCHEDULES_WITH_FLOWS)(
    "lists every line from the origin of %s in the list",
    (name) => {
      const html = render(name, { width: LIST });

      expect(
        launchedBy(name).filter(
          (flow) => !originExitsOf(html, name).includes(`次に起動: ${flow}`),
        ),
      ).toEqual([]);
    },
  );

  test("writes the launch that a line draws in the diagram as an exit in the list", () => {
    expect(plain(render("poll_issues", { width: LIST }))).toContain(
      "承認の後: implement",
    );
  });

  test("opens in the list the flows that are open in the diagram", () => {
    expect(
      countOf(
        render("poll_prs", { width: LIST, expanded: ["pr_fix"] }),
        ' open=""',
      ),
    ).toBe(1);
  });

  test("opens in the list no flow that is closed", () => {
    expect(countOf(render("poll_prs", { width: LIST }), ' open=""')).toBe(0);
  });

  test("writes the steps in the list when the flow is open", () => {
    expect(
      plain(render("poll_prs", { width: LIST, expanded: ["pr_fix"] })),
    ).toContain("pr_fix_collect");
  });

  test("links an open flow of the list to its diagram", () => {
    expect(
      render("audit_kickoff", { width: LIST, expanded: ["audit"] }),
    ).toContain('href="/jobs/flows/audit"');
  });

  test("draws no select-all control in the list", () => {
    expect(plain(render("poll_prs", { width: LIST }))).not.toContain(
      "すべて開く",
    );
  });

  test("does not explain the lines in the list, which draws none", () => {
    expect(plain(render("poll_issues", { width: LIST }))).not.toContain("実線");
  });

  test.each(SCHEDULES_WITH_PR_EXIT)(
    "explains the PR rows in the list of %s, which has a PR relation",
    (name) => {
      expect(plain(render(name, { width: LIST }))).toContain(LIST_PR_NOTE);
    },
  );

  test.each(SCHEDULES_WITHOUT_PR_EXIT)(
    "does not explain the PR rows in the list of %s, which has no PR relation",
    (name) => {
      expect(plain(render(name, { width: LIST }))).not.toContain(
        "PR経由の行は",
      );
    },
  );

  test("does not explain the PR rows in the diagram, which has the legend", () => {
    expect(plain(render("poll_prs"))).not.toContain("PR経由の行は");
  });

  test("still says a flow may not start in the list", () => {
    expect(plain(render("poll_issues", { width: LIST }))).toContain(
      CONDITIONAL_EDGES_NOTE,
    );
  });
});
