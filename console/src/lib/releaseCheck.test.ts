import { describe, expect, test } from "bun:test";
import type { ReleaseNotice } from "./release.ts";
import { checkRelease, type FetchFn } from "./releaseCheck.ts";

const JS = "assets/index-AAAA.js";
const CSS = "assets/index-BBBB.css";
const OWN: ReadonlySet<string> = new Set([JS, CSS]);

type Route = Response | Error;

type Fake = {
  fetchFn: FetchFn;
  calls: { url: string; method: string }[];
  signals: (AbortSignal | null | undefined)[];
};

function manifest(...files: string[]): Response {
  return Response.json({
    version: 1,
    sha: "abc",
    files: Object.fromEntries(files.map((f) => [f, "digest"])),
  });
}

function status(state: "ok" | "failed" | "pinned"): Response {
  return Response.json({
    state,
    sha: "abc",
    checked_at: "2026-10-09T00:00:00.000Z",
    error: null,
  });
}

/** URLごとの応答を返すfetch。HEADの応答は`HEAD <url>`で指定する。 */
function fake(routes: Record<string, Route>): Fake {
  const calls: Fake["calls"] = [];
  const signals: Fake["signals"] = [];
  const fetchFn: FetchFn = async (input, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url: input, method });
    signals.push(init?.signal);
    const route =
      method === "GET" ? routes[input] : routes[`${method} ${input}`];
    if (route === undefined) {
      return new Response("not found", { status: 404 });
    }
    if (route instanceof Error) {
      throw route;
    }
    return route.clone();
  };
  return { fetchFn, calls, signals };
}

/**
 * 指定の無いHEADは、`signal`が中断されるまで応答しない(中断で拒否する)fetch。
 * 中断されたURLを`aborted`に記録する。
 */
function pendingHeads(routes: Record<string, Response>): {
  fetchFn: FetchFn;
  aborted: string[];
} {
  const aborted: string[] = [];
  const fetchFn: FetchFn = (input, init) => {
    const method = init?.method ?? "GET";
    const route = routes[method === "GET" ? input : `${method} ${input}`];
    if (route !== undefined) {
      return Promise.resolve(route.clone());
    }
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => {
          aborted.push(input);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  };
  return { fetchFn, aborted };
}

/** 案内の強さだけを取り出す。 */
async function noticeOf(
  ...args: Parameters<typeof checkRelease>
): Promise<ReleaseNotice> {
  return (await checkRelease(...args)).notice;
}

describe("checkRelease", () => {
  test("is none when every own asset is in the manifest", async () => {
    const { fetchFn } = fake({
      "/console/manifest.json": manifest("index.html", JS, CSS),
      "/console/status.json": status("ok"),
    });
    expect(await noticeOf(fetchFn, OWN, "none")).toBe("none");
  });

  test("suggests a reload when an own asset is not in the manifest", async () => {
    const { fetchFn } = fake({
      "/console/manifest.json": manifest("index.html", JS),
      "/console/status.json": status("ok"),
      [`HEAD /console/${CSS}`]: new Response(null, { status: 200 }),
    });
    expect(await noticeOf(fetchFn, OWN, "none")).toBe("suggest");
  });

  test("urges a reload when pinned", async () => {
    const { fetchFn } = fake({
      "/console/manifest.json": manifest("index.html"),
      "/console/status.json": status("pinned"),
      [`HEAD /console/${JS}`]: new Response(null, { status: 200 }),
      [`HEAD /console/${CSS}`]: new Response(null, { status: 200 }),
    });
    expect(await noticeOf(fetchFn, OWN, "none")).toBe("urge");
  });

  test("urges a reload when an own asset answers 404", async () => {
    const { fetchFn } = fake({
      "/console/manifest.json": manifest("index.html", JS),
      "/console/status.json": status("ok"),
    });
    expect(await noticeOf(fetchFn, OWN, "none")).toBe("urge");
  });

  test("keeps the previous result when the manifest cannot be fetched", async () => {
    const { fetchFn } = fake({
      "/console/manifest.json": new Error("network down"),
      "/console/status.json": status("pinned"),
    });
    expect(await noticeOf(fetchFn, OWN, "suggest")).toBe("suggest");
  });

  test("keeps the previous result when the manifest answers 404", async () => {
    const { fetchFn } = fake({ "/console/status.json": status("ok") });
    expect(await noticeOf(fetchFn, OWN, "none")).toBe("none");
  });

  test("keeps the previous result when the manifest is broken JSON", async () => {
    const { fetchFn } = fake({
      "/console/manifest.json": new Response("{broken", { status: 200 }),
      "/console/status.json": status("ok"),
    });
    expect(await noticeOf(fetchFn, OWN, "suggest")).toBe("suggest");
  });

  test("keeps the previous result when the manifest has the wrong shape", async () => {
    const { fetchFn } = fake({
      "/console/manifest.json": Response.json({ files: [] }),
      "/console/status.json": status("ok"),
    });
    expect(await noticeOf(fetchFn, OWN, "suggest")).toBe("suggest");
  });

  test("still suggests a reload when the status cannot be fetched", async () => {
    const { fetchFn } = fake({
      "/console/manifest.json": manifest("index.html"),
      "/console/status.json": new Error("network down"),
      [`HEAD /console/${JS}`]: new Response(null, { status: 200 }),
      [`HEAD /console/${CSS}`]: new Response(null, { status: 200 }),
    });
    expect(await noticeOf(fetchFn, OWN, "none")).toBe("suggest");
  });

  test("suggests a reload when the status is broken JSON", async () => {
    const { fetchFn } = fake({
      "/console/manifest.json": manifest("index.html"),
      "/console/status.json": new Response("{broken", { status: 200 }),
      [`HEAD /console/${JS}`]: new Response(null, { status: 200 }),
      [`HEAD /console/${CSS}`]: new Response(null, { status: 200 }),
    });
    expect(await noticeOf(fetchFn, OWN, "none")).toBe("suggest");
  });

  test("does not urge when the HEAD request fails", async () => {
    const { fetchFn } = fake({
      "/console/manifest.json": manifest("index.html", JS),
      "/console/status.json": status("ok"),
      [`HEAD /console/${CSS}`]: new Error("network down"),
    });
    expect(await noticeOf(fetchFn, OWN, "none")).toBe("suggest");
  });

  test("never lowers urge", async () => {
    const { fetchFn } = fake({
      "/console/manifest.json": manifest("index.html", JS, CSS),
      "/console/status.json": status("ok"),
    });
    expect(await noticeOf(fetchFn, OWN, "urge")).toBe("urge");
  });

  test("sends HEAD only for assets missing from the manifest", async () => {
    const { fetchFn, calls } = fake({
      "/console/manifest.json": manifest("index.html", JS),
      "/console/status.json": status("ok"),
      [`HEAD /console/${CSS}`]: new Response(null, { status: 200 }),
    });
    await noticeOf(fetchFn, OWN, "none");
    expect(calls.filter((c) => c.method === "HEAD")).toEqual([
      { url: `/console/${CSS}`, method: "HEAD" },
    ]);
  });

  test("sends no HEAD when every own asset is in the manifest", async () => {
    const { fetchFn, calls } = fake({
      "/console/manifest.json": manifest("index.html", JS, CSS),
      "/console/status.json": status("ok"),
    });
    await noticeOf(fetchFn, OWN, "none");
    expect(calls.filter((c) => c.method === "HEAD")).toEqual([]);
  });

  test("sends no HEAD when the manifest cannot be fetched", async () => {
    const { fetchFn, calls } = fake({
      "/console/manifest.json": new Error("network down"),
      "/console/status.json": status("ok"),
    });
    await noticeOf(fetchFn, OWN, "none");
    expect(calls.filter((c) => c.method === "HEAD")).toEqual([]);
  });

  test("fetches nothing when there is no own asset to watch", async () => {
    const { fetchFn, calls } = fake({});
    await noticeOf(fetchFn, new Set(), "none");
    expect(calls).toEqual([]);
  });

  test("keeps the previous result when there is no own asset to watch", async () => {
    const { fetchFn } = fake({});
    expect(await noticeOf(fetchFn, new Set(), "suggest")).toBe("suggest");
  });

  test("passes the abort signal to the manifest and status requests", async () => {
    const controller = new AbortController();
    const { fetchFn, calls, signals } = fake({
      "/console/manifest.json": manifest("index.html", JS, CSS),
      "/console/status.json": status("ok"),
    });
    await checkRelease(fetchFn, OWN, "none", controller.signal);
    expect(
      calls.length === 2 && signals.every((s) => s === controller.signal),
    ).toBe(true);
  });

  test("urges a reload once one HEAD answers 404 while another is pending", async () => {
    const { fetchFn } = pendingHeads({
      "/console/manifest.json": manifest("index.html"),
      "/console/status.json": status("ok"),
      [`HEAD /console/${CSS}`]: new Response(null, { status: 404 }),
    });
    expect((await checkRelease(fetchFn, OWN, "none")).notice).toBe("urge");
  });

  test("aborts the pending HEADs after the first 404", async () => {
    const { fetchFn, aborted } = pendingHeads({
      "/console/manifest.json": manifest("index.html"),
      "/console/status.json": status("ok"),
      [`HEAD /console/${CSS}`]: new Response(null, { status: 404 }),
    });
    await checkRelease(fetchFn, OWN, "none");
    expect(aborted).toEqual([`/console/${JS}`]);
  });

  test("aborts the pending HEADs when the caller aborts", async () => {
    const controller = new AbortController();
    const { fetchFn, aborted } = pendingHeads({
      "/console/manifest.json": manifest("index.html"),
      "/console/status.json": status("ok"),
    });
    const result = checkRelease(fetchFn, OWN, "none", controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await result;
    expect(aborted.sort()).toEqual([`/console/${JS}`, `/console/${CSS}`]);
  });

  test("reports the manifest as reachable when it was parsed", async () => {
    const { fetchFn } = fake({
      "/console/manifest.json": manifest("index.html", JS, CSS),
      "/console/status.json": status("ok"),
    });
    expect((await checkRelease(fetchFn, OWN, "none")).reachable).toBe(true);
  });

  test("reports the manifest as unreachable when the fetch fails", async () => {
    const { fetchFn } = fake({
      "/console/manifest.json": new Error("network down"),
      "/console/status.json": status("ok"),
    });
    expect((await checkRelease(fetchFn, OWN, "none")).reachable).toBe(false);
  });

  test("reports reachable without a request once the notice is urge", async () => {
    const { fetchFn } = fake({});
    expect((await checkRelease(fetchFn, OWN, "urge")).reachable).toBe(true);
  });
});
