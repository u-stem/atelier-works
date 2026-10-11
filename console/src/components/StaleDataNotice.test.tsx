import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiFailure } from "../api/errors.ts";
import { StaleDataNotice } from "./StaleDataNotice.tsx";

function render(error: unknown): string {
  return renderToStaticMarkup(
    <StaleDataNotice error={error} onRetry={() => undefined} />,
  );
}

describe("StaleDataNotice", () => {
  test("says the shown values are from the previous fetch", () => {
    expect(render(new ApiFailure({ kind: "network" }))).toContain(
      "前回取得した値を表示しています",
    );
  });

  test("offers a retry", () => {
    expect(render(new ApiFailure({ kind: "network" }))).toContain(
      "もう一度取得する",
    );
  });

  test("says the shown values are from the previous fetch for an unknown error", () => {
    expect(render(new Error("x"))).toContain("前回取得した値を表示しています");
  });

  test("shows nothing for a 401 that the banner covers", () => {
    expect(render(new ApiFailure({ kind: "unauthorized" }))).toBe("");
  });
});
