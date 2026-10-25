import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiFailure } from "../api/errors.ts";
import { connectionStore } from "./connectionState.ts";
import { OfflineBanner, OfflineBannerView } from "./OfflineBanner.tsx";

function withUnreachable<T>(unreachable: boolean, run: () => T): T {
  if (unreachable) {
    connectionStore.reportError(new ApiFailure({ kind: "network" }));
  }
  try {
    return run();
  } finally {
    connectionStore.reportSuccess();
  }
}

describe("OfflineBannerView", () => {
  test("shows nothing while Windmill is reachable", () => {
    expect(
      renderToStaticMarkup(<OfflineBannerView unreachable={false} />),
    ).toBe("");
  });

  test("tells the user that Windmill cannot be reached", () => {
    expect(renderToStaticMarkup(<OfflineBannerView unreachable />)).toContain(
      "Windmillに接続できません",
    );
  });

  test("says that fetching resumes by itself", () => {
    expect(renderToStaticMarkup(<OfflineBannerView unreachable />)).toContain(
      "接続が戻ると、自動で取り直します",
    );
  });

  test("is announced politely", () => {
    expect(renderToStaticMarkup(<OfflineBannerView unreachable />)).toContain(
      'role="status"',
    );
  });
});

describe("OfflineBanner", () => {
  test("follows the connection state of the fetches", () => {
    expect(
      withUnreachable(true, () => renderToStaticMarkup(<OfflineBanner />)),
    ).toContain("Windmillに接続できません");
  });

  test("shows nothing once a fetch has succeeded again", () => {
    expect(
      withUnreachable(false, () => renderToStaticMarkup(<OfflineBanner />)),
    ).toBe("");
  });
});
