import { describe, expect, test } from "bun:test";
import { onlineManager } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { OfflineBanner, OfflineBannerView } from "./OfflineBanner.tsx";

function withOnline<T>(online: boolean, run: () => T): T {
  onlineManager.setOnline(online);
  try {
    return run();
  } finally {
    onlineManager.setOnline(true);
  }
}

describe("OfflineBannerView", () => {
  test("shows nothing while online", () => {
    expect(renderToStaticMarkup(<OfflineBannerView online />)).toBe("");
  });

  test("tells the user the connection is lost while offline", () => {
    expect(
      renderToStaticMarkup(<OfflineBannerView online={false} />),
    ).toContain("オフラインです");
  });

  test("says that fetching resumes by itself", () => {
    expect(
      renderToStaticMarkup(<OfflineBannerView online={false} />),
    ).toContain("接続が戻ると、自動で取り直します");
  });

  test("is announced politely", () => {
    expect(
      renderToStaticMarkup(<OfflineBannerView online={false} />),
    ).toContain('role="status"');
  });
});

describe("OfflineBanner", () => {
  test("follows the online state of the query client", () => {
    expect(
      withOnline(false, () => renderToStaticMarkup(<OfflineBanner />)),
    ).toContain("オフラインです");
  });

  test("shows nothing once the query client is online again", () => {
    expect(
      withOnline(true, () => renderToStaticMarkup(<OfflineBanner />)),
    ).toBe("");
  });
});
