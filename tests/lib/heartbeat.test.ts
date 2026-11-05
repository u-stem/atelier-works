import { describe, expect, test } from "bun:test";
import {
  type HeartbeatFetch,
  pingHeartbeat,
} from "../../f/factory/lib/heartbeat.ts";

const URL_TEXT = "https://hc-ping.com/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";

type Seen = { readonly url: string; readonly init: RequestInit };

function responding(status: number, seen: Seen[] = []): HeartbeatFetch {
  return async (url, init) => {
    seen.push({ url, init });
    return new Response(null, { status });
  };
}

describe("pingHeartbeat", () => {
  test("does nothing for an empty url", async () => {
    expect(await pingHeartbeat("", responding(200))).toEqual({
      kind: "disabled",
    });
  });

  test("does not call the service for an empty url", async () => {
    const seen: Seen[] = [];
    await pingHeartbeat("  ", responding(200, seen));
    expect(seen.length).toBe(0);
  });

  test("rejects a url that cannot be parsed", async () => {
    expect(await pingHeartbeat("not a url", responding(200))).toEqual({
      kind: "rejected",
      reason: "invalid_url",
    });
  });

  test("rejects a url that is not https", async () => {
    expect(
      await pingHeartbeat("http://hc-ping.com/abc", responding(200)),
    ).toEqual({ kind: "rejected", reason: "not_https" });
  });

  test("sends a GET", async () => {
    const seen: Seen[] = [];
    await pingHeartbeat(URL_TEXT, responding(200, seen));
    expect(seen[0]?.init.method).toBe("GET");
  });

  test("does not follow a redirect", async () => {
    const seen: Seen[] = [];
    await pingHeartbeat(URL_TEXT, responding(200, seen));
    expect(seen[0]?.init.redirect).toBe("manual");
  });

  test("bounds the request with a signal", async () => {
    const seen: Seen[] = [];
    await pingHeartbeat(URL_TEXT, responding(200, seen));
    expect(seen[0]?.init.signal instanceof AbortSignal).toBe(true);
  });

  test("reports a 2xx answer as sent", async () => {
    expect(await pingHeartbeat(URL_TEXT, responding(204))).toEqual({
      kind: "sent",
    });
  });

  test("reports a redirect as a failure", async () => {
    expect(await pingHeartbeat(URL_TEXT, responding(302))).toEqual({
      kind: "failed",
      reason: "HTTP 302",
    });
  });

  test("reports a server error as a failure", async () => {
    expect(await pingHeartbeat(URL_TEXT, responding(500))).toEqual({
      kind: "failed",
      reason: "HTTP 500",
    });
  });

  test("keeps the url out of the reason of a network failure", async () => {
    const result = await pingHeartbeat(URL_TEXT, async () => {
      throw new Error(`could not connect to ${URL_TEXT}`);
    });
    expect(result.kind === "failed" ? result.reason : "").not.toContain(
      "0f1e2d3c",
    );
  });

  test("reports a request that does not finish in time", async () => {
    const hanging: HeartbeatFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => {
            reject(init.signal?.reason);
          },
          { once: true },
        );
      });
    expect(await pingHeartbeat(URL_TEXT, hanging, 10)).toEqual({
      kind: "failed",
      reason: "timed out",
    });
  });
});
