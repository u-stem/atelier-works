import { describe, expect, test } from "bun:test";
import { redirectLegacyDeepLink } from "./legacyRedirect.ts";

type Call = { state: unknown; unused: string; url: string };

function fakeHistory(): {
  history: {
    replaceState: (state: unknown, unused: string, url: string) => void;
  };
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    history: {
      replaceState: (state, unused, url) => {
        calls.push({ state, unused, url });
      },
    },
  };
}

describe("redirectLegacyDeepLink", () => {
  test("replaces the URL for a requirements fragment", () => {
    const { history, calls } = fakeHistory();
    redirectLegacyDeepLink({ hash: "#requirements/12" }, history);
    expect(calls.map((call) => call.url)).toEqual([
      "/console/items/12/requirements",
    ]);
  });

  test("keeps the attempt", () => {
    const { history, calls } = fakeHistory();
    redirectLegacyDeepLink({ hash: "#requirements/12/attempt-2" }, history);
    expect(calls[0]?.url).toBe("/console/items/12/requirements?attempt=2");
  });

  test("replaces the URL for an audit fragment", () => {
    const { history, calls } = fakeHistory();
    redirectLegacyDeepLink({ hash: "#audit/5" }, history);
    expect(calls[0]?.url).toBe("/console/reports/audit/5");
  });

  test("does nothing for another fragment", () => {
    const { history, calls } = fakeHistory();
    redirectLegacyDeepLink({ hash: "#h-1" }, history);
    expect(calls).toEqual([]);
  });

  test("does nothing without a fragment", () => {
    const { history, calls } = fakeHistory();
    redirectLegacyDeepLink({ hash: "" }, history);
    expect(calls).toEqual([]);
  });

  test("does not touch the history state", () => {
    const { history, calls } = fakeHistory();
    redirectLegacyDeepLink({ hash: "#audit/5" }, history);
    expect(calls[0]?.state).toBeNull();
  });
});
