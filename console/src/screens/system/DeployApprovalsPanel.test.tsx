import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeployApprovalsView } from "../../lib/deployApprovalsView.ts";
import { DeployApprovalsPanel } from "./DeployApprovalsPanel.tsx";
import type { SectionArrival } from "./useSectionArrival.ts";

const NOW = Date.parse("2026-11-05T02:00:00.000Z");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const PENDING: DeployApprovalsView = {
  kind: "pending",
  items: [
    {
      sha: SHA,
      requestedAt: "2026-11-05T01:00:00.000Z",
      paths: ["f/factory/self_update.ts"],
      hiddenPathCount: 0,
    },
  ],
};

const IDLE: SectionArrival = {
  pending: null,
  highlighted: null,
  onArrived: () => undefined,
};

function render(
  view: DeployApprovalsView,
  locked = false,
  arrival: SectionArrival = IDLE,
): string {
  return renderToStaticMarkup(
    <DeployApprovalsPanel
      view={view}
      now={NOW}
      isLocked={() => locked}
      onRequest={() => undefined}
      arrival={arrival}
    />,
  );
}

describe("DeployApprovalsPanel", () => {
  test("renders nothing when nothing waits", () => {
    expect(render({ kind: "none" })).toBe("");
  });

  test("shows the full sha", () => {
    expect(render(PENDING)).toContain(SHA);
  });

  test("lists the protected paths", () => {
    expect(render(PENDING)).toContain("f/factory/self_update.ts");
  });

  test("tells how many paths the list leaves out", () => {
    const view: DeployApprovalsView = {
      kind: "pending",
      items: [
        {
          sha: SHA,
          requestedAt: "2026-11-05T01:00:00.000Z",
          paths: ["a"],
          hiddenPathCount: 4,
        },
      ],
    };
    expect(render(view)).toContain("ほか4件");
  });

  test("offers both decisions", () => {
    expect(render(PENDING)).toMatch(
      /data-deploy-approve=[\s\S]*data-deploy-reject=/,
    );
  });

  test("disables both buttons while a decision runs", () => {
    expect(render(PENDING, true).match(/disabled=""/g)?.length).toBe(2);
  });

  test("explains the effect of an approval while approvals wait", () => {
    expect(render(PENDING)).toContain("承認すると、次の自己更新");
  });

  test("omits the approval note when the approvals cannot be read", () => {
    expect(render({ kind: "failed", reason: "db down" })).not.toContain(
      "承認すると、次の自己更新",
    );
  });

  test("alerts when the approvals cannot be read", () => {
    expect(render({ kind: "failed", reason: "db down" })).toContain(
      'role="alert"',
    );
  });
});

describe("DeployApprovalsPanel as the place to land on", () => {
  test("gives the heading the id that the arrival looks for", () => {
    expect(render(PENDING)).toMatch(
      /<h3 id="system-section-deploy-approvals" tabindex="-1"/,
    );
  });

  test("marks the panel while its section is highlighted", () => {
    expect(
      render(PENDING, false, { ...IDLE, highlighted: "deploy-approvals" }),
    ).toContain('data-highlighted=""');
  });

  test("does not mark the panel while another section is highlighted", () => {
    expect(
      render(PENDING, false, { ...IDLE, highlighted: "holds" }),
    ).not.toContain("data-highlighted");
  });

  test("draws nothing, whatever is pending, when nothing waits", () => {
    expect(
      render({ kind: "none" }, false, {
        ...IDLE,
        pending: "deploy-approvals",
      }),
    ).toBe("");
  });
});
