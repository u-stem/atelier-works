import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { StopAllRead } from "../../api/guards/holds.ts";
import { StopAllPanel } from "./StopAllPanel.tsx";

const NOOP = () => undefined;

function render(view: StopAllRead | undefined, locked = false): string {
  return renderToStaticMarkup(
    <StopAllPanel
      view={view}
      locked={locked}
      onRequestStop={NOOP}
      onRequestRelease={NOOP}
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

  test("draws nothing for an older backend", () => {
    expect(render(undefined)).toBe("");
  });
});
