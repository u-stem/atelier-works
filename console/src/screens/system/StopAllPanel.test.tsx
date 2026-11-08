import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { StopAllRead } from "../../api/guards/holds.ts";
import { StopAllPanel } from "./StopAllPanel.tsx";
import type { SectionArrival } from "./useSectionArrival.ts";

const NOOP = () => undefined;

const IDLE: SectionArrival = {
  pending: null,
  highlighted: null,
  onArrived: NOOP,
};

function render(
  view: StopAllRead | undefined,
  locked = false,
  arrival: SectionArrival = IDLE,
): string {
  return renderToStaticMarkup(
    <StopAllPanel
      view={view}
      locked={locked}
      onRequestStop={NOOP}
      onRequestRelease={NOOP}
      arrival={arrival}
    />,
  );
}

const ACTIVE: StopAllRead = {
  kind: "active",
  placed_at: "2026-11-05T03:00:00.000Z",
  placed_by: "operator",
  reason: "a runaway loop",
};

describe("StopAllPanel", () => {
  test("offers the stop while the factory runs", () => {
    expect(render({ kind: "clear" })).toContain("全停止");
  });

  test("shows the reason of a placed stop", () => {
    expect(render(ACTIVE)).toContain("a runaway loop");
  });

  test("shows the operator of a placed stop", () => {
    expect(render(ACTIVE)).toContain("operator");
  });

  test("offers the release of a placed stop", () => {
    expect(render(ACTIVE)).toContain("解除");
  });

  test("disables the button while a write runs", () => {
    // ボタンのクラスにも`disabled:`があるので、属性の形で照合する。
    expect(render(ACTIVE, true)).toContain('disabled=""');
  });

  test("says that the state cannot be read", () => {
    expect(render({ kind: "unreadable", reason: "api down" })).toContain(
      "読めません",
    );
  });

  test("points to the host entry when the state cannot be read", () => {
    expect(render({ kind: "unreadable", reason: "api down" })).toContain(
      "mise run stop:release",
    );
  });

  test("draws nothing for an older backend", () => {
    expect(render(undefined)).toBe("");
  });
});

describe("StopAllPanel as the place to land on", () => {
  const STOP_ID = 'id="system-section-stop-all" tabindex="-1"';

  test("gives the card of a placed stop the id that the arrival looks for", () => {
    expect(render(ACTIVE)).toContain(STOP_ID);
  });

  test("gives the card of a corrupt state the id", () => {
    expect(render({ kind: "corrupt", reason: "bad json" })).toContain(STOP_ID);
  });

  test("gives the row that offers the stop the id", () => {
    expect(render({ kind: "clear" })).toContain(STOP_ID);
  });

  test("gives the note of an unreadable state the id", () => {
    expect(render({ kind: "unreadable", reason: "api down" })).toContain(
      STOP_ID,
    );
  });

  test("marks the card while its section is highlighted", () => {
    expect(
      render(ACTIVE, false, { ...IDLE, highlighted: "stop-all" }),
    ).toContain('data-highlighted=""');
  });

  test("does not mark the card while another section is highlighted", () => {
    expect(
      render(ACTIVE, false, { ...IDLE, highlighted: "holds" }),
    ).not.toContain("data-highlighted");
  });
});
