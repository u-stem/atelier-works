import { describe, expect, test } from "bun:test";
import { checkRelease, type FetchFn } from "./releaseCheck.ts";

const JS = "assets/index-AAAA.js";
const CSS = "assets/index-BBBB.css";
const OWN: ReadonlySet<string> = new Set([JS, CSS]);

type Route = Response | Error;

type Fake = {
  fetchFn: FetchFn;
  calls: { url: string; method: string }[];
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
  const fetchFn: FetchFn = async (input, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url: input, method });
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
  return { fetchFn, calls };
}

describe("checkRelease", () => {
  test("is none when every own asset is in the manifest", async () => {
    const { fetchFn } = fake({
      "/console/manifest.json": manifest("index.html", JS, CSS),
      "/console/status.json": status("ok"),
    });
    expect(await checkRelease(fetchFn, OWN, "none")).toBe("none");
  });

  test("suggests a reload when an own asset is not in the manifest", async () => {
    const { fetchFn } = fake({
      "/console/manifest.json": manifest("index.html", JS),
      "/console/status.json": status("ok"),
      [`HEAD /console/${CSS}`]: new Response(null, { status: 200 }),
    });
    expect(await checkRelease(fetchFn, OWN, "none")).toBe("suggest");
  });

  test("urges a reload when pinned", async () => {
    const { fetchFn } = fake({
      "/console/manifest.json": manifest("index.html"),
      "/console/status.json": status("pinned"),
      [`HEAD /console/${JS}`]: new Response(null, { status: 200 }),
      [`HEAD /console/${CSS}`]: new Response(null, { status: 200 }),
    });
    expect(await checkRelease(fetchFn, OWN, "none")).toBe("urge");
  });

  test("urges a reload when an own asset answers 404", async () => {
    const { fetchFn } = fake({
      "/console/manifest.json": manifest("index.html", JS),
      "/console/status.json": status("ok"),
    });
    expect(await checkRelease(fetchFn, OWN, "none")).toBe("urge");
  });

  test("keeps the previous result when the manifest cannot be fetched", async () => {
    const { fetchFn } = fake({
      "/console/manifest.json": new Error("network down"),
      "/console/status.json": status("pinned"),
    });
    expect(await checkRelease(fetchFn, OWN, "suggest")).toBe("suggest");
  });

  test("keeps the previous result when the manifest answers 404", async () => {
    const { fetchFn } = fake({ "/console/status.json": status("ok") });
    expect(await checkRelease(fetchFn, OWN, "none")).toBe("none");
  });

  test("keeps the previous result when the manifest is broken JSON", async () => {
    const { fetchFn } = fake({
      "/console/manifest.json": new Response("{broken", { status: 200 }),
      "/console/status.json": status("ok"),
    });
    expect(await checkRelease(fetchFn, OWN, "suggest")).toBe("suggest");
  });

  test("keeps the previous result when the manifest has the wrong shape", async () => {
    const { fetchFn } = fake({
      "/console/manifest.json": Response.json({ files: [] }),
      "/console/status.json": status("ok"),
    });
    expect(await checkRelease(fetchFn, OWN, "suggest")).toBe("suggest");
  });

  test("still suggests a reload when the status cannot be fetched", async () => {
    const { fetchFn } = fake({
      "/console/manifest.json": manifest("index.html"),
      "/console/status.json": new Error("network down"),
      [`HEAD /console/${JS}`]: new Response(null, { status: 200 }),
      [`HEAD /console/${CSS}`]: new Response(null, { status: 200 }),
    });
    expect(await checkRelease(fetchFn, OWN, "none")).toBe("suggest");
  });

  test("suggests a reload when the status is broken JSON", async () => {
    const { fetchFn } = fake({
      "/console/manifest.json": manifest("index.html"),
      "/console/status.json": new Response("{broken", { status: 200 }),
      [`HEAD /console/${JS}`]: new Response(null, { status: 200 }),
      [`HEAD /console/${CSS}`]: new Response(null, { status: 200 }),
    });
    expect(await checkRelease(fetchFn, OWN, "none")).toBe("suggest");
  });

  test("does not urge when the HEAD request fails", async () => {
    const { fetchFn } = fake({
      "/console/manifest.json": manifest("index.html", JS),
      "/console/status.json": status("ok"),
      [`HEAD /console/${CSS}`]: new Error("network down"),
    });
    expect(await checkRelease(fetchFn, OWN, "none")).toBe("suggest");
  });

  test("never lowers urge", async () => {
    const { fetchFn } = fake({
      "/console/manifest.json": manifest("index.html", JS, CSS),
      "/console/status.json": status("ok"),
    });
    expect(await checkRelease(fetchFn, OWN, "urge")).toBe("urge");
  });

  test("sends HEAD only for assets missing from the manifest", async () => {
    const { fetchFn, calls } = fake({
      "/console/manifest.json": manifest("index.html", JS),
      "/console/status.json": status("ok"),
      [`HEAD /console/${CSS}`]: new Response(null, { status: 200 }),
    });
    await checkRelease(fetchFn, OWN, "none");
    expect(calls.filter((c) => c.method === "HEAD")).toEqual([
      { url: `/console/${CSS}`, method: "HEAD" },
    ]);
  });

  test("sends no HEAD when every own asset is in the manifest", async () => {
    const { fetchFn, calls } = fake({
      "/console/manifest.json": manifest("index.html", JS, CSS),
      "/console/status.json": status("ok"),
    });
    await checkRelease(fetchFn, OWN, "none");
    expect(calls.filter((c) => c.method === "HEAD")).toEqual([]);
  });

  test("sends no HEAD when the manifest cannot be fetched", async () => {
    const { fetchFn, calls } = fake({
      "/console/manifest.json": new Error("network down"),
      "/console/status.json": status("ok"),
    });
    await checkRelease(fetchFn, OWN, "none");
    expect(calls.filter((c) => c.method === "HEAD")).toEqual([]);
  });

  test("fetches nothing when there is no own asset to watch", async () => {
    const { fetchFn, calls } = fake({});
    await checkRelease(fetchFn, new Set(), "none");
    expect(calls).toEqual([]);
  });
});
