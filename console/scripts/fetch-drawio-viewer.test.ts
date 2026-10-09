import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { DrawioViewerPin } from "./drawio-viewer.ts";
import {
  fetchViewer,
  MAX_RETRIES,
  MAX_VIEWER_BYTES,
} from "./fetch-drawio-viewer.ts";

const COMMIT = "9034053fba80a435e27d68d374bc564b83917ae9";
const BODY = new TextEncoder().encode("viewer body");
const SHA256 = createHash("sha256").update(BODY).digest("hex");
const pin: DrawioViewerPin = {
  version: "32.4.1",
  commit: COMMIT,
  url: `https://raw.githubusercontent.com/jgraph/drawio/${COMMIT}/src/main/webapp/js/viewer-static.min.js`,
  sha256: SHA256,
};

type Step = Response | Error;

/** 呼ばれた順に、決めた応答を返すfetchと、書き込みと待ちの記録を作る。 */
function setup(steps: readonly Step[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const writes: { name: string; bytes: Uint8Array }[] = [];
  const sleeps: number[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const step = steps[Math.min(calls.length, steps.length) - 1];
    if (step === undefined || step instanceof Error) {
      throw step ?? new Error("no step");
    }
    return step.clone();
  };
  const writeImpl = async (name: string, bytes: Uint8Array) => {
    writes.push({ name, bytes });
  };
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  const run = () => fetchViewer(pin, fetchImpl, writeImpl, sleep);
  return { calls, writes, sleeps, run };
}

const okResponse = () => new Response(BODY, { status: 200 });

describe("fetchViewer: success", () => {
  test("writes the verified viewer once", async () => {
    const t = setup([okResponse()]);
    await t.run();
    expect(t.writes).toHaveLength(1);
  });

  test("writes it under the name derived from the pinned sha256", async () => {
    const t = setup([okResponse()]);
    await t.run();
    expect(t.writes[0]?.name).toBe(`drawio-viewer-${SHA256.slice(0, 8)}.js`);
  });

  test("returns ok", async () => {
    const t = setup([okResponse()]);
    expect((await t.run()).ok).toBe(true);
  });

  test("requests the pinned url without following redirects", async () => {
    const t = setup([okResponse()]);
    await t.run();
    expect([t.calls[0]?.url, t.calls[0]?.init.redirect]).toEqual([
      pin.url,
      "manual",
    ]);
  });
});

describe("fetchViewer: rejected content", () => {
  test("does not write when the sha256 does not match", async () => {
    const t = setup([new Response("tampered", { status: 200 })]);
    await t.run();
    expect(t.writes).toHaveLength(0);
  });

  test("fails when the sha256 does not match", async () => {
    const t = setup([new Response("tampered", { status: 200 })]);
    expect((await t.run()).ok).toBe(false);
  });

  test("does not retry a sha256 mismatch", async () => {
    const t = setup([new Response("tampered", { status: 200 })]);
    await t.run();
    expect(t.calls).toHaveLength(1);
  });
});

describe("fetchViewer: HTTP failures", () => {
  test("does not write on a 404", async () => {
    const t = setup([new Response("no", { status: 404 })]);
    await t.run();
    expect(t.writes).toHaveLength(0);
  });

  test("does not retry a 404", async () => {
    const t = setup([new Response("no", { status: 404 })]);
    await t.run();
    expect(t.calls).toHaveLength(1);
  });

  test("does not write on a redirect", async () => {
    const t = setup([
      new Response(null, {
        status: 302,
        headers: { location: "https://example.com/x.js" },
      }),
    ]);
    await t.run();
    expect(t.writes).toHaveLength(0);
  });

  test("fails on a redirect even if the target would match", async () => {
    const t = setup([
      new Response(BODY, {
        status: 302,
        headers: { location: "https://example.com/x.js" },
      }),
    ]);
    expect((await t.run()).ok).toBe(false);
  });

  test("does not retry a redirect", async () => {
    const t = setup([new Response(null, { status: 301 })]);
    await t.run();
    expect(t.calls).toHaveLength(1);
  });
});

describe("fetchViewer: size limits", () => {
  test("does not write when Content-Length is over the limit", async () => {
    const t = setup([
      new Response(BODY, {
        status: 200,
        headers: { "content-length": String(MAX_VIEWER_BYTES + 1) },
      }),
    ]);
    await t.run();
    expect(t.writes).toHaveLength(0);
  });

  test("reports the size limit", async () => {
    const t = setup([
      new Response(BODY, {
        status: 200,
        headers: { "content-length": String(MAX_VIEWER_BYTES + 1) },
      }),
    ]);
    const result = await t.run();
    expect(result.ok ? "" : result.reason).toContain("too large");
  });

  test("does not write when the body is over the limit without Content-Length", async () => {
    const t = setup([
      new Response(new Uint8Array(MAX_VIEWER_BYTES + 1), { status: 200 }),
    ]);
    await t.run();
    expect(t.writes).toHaveLength(0);
  });

  test("does not retry an oversized body", async () => {
    const t = setup([
      new Response(new Uint8Array(MAX_VIEWER_BYTES + 1), { status: 200 }),
    ]);
    await t.run();
    expect(t.calls).toHaveLength(1);
  });
});

describe("fetchViewer: retries", () => {
  test("retries a 503 and then writes", async () => {
    const t = setup([new Response("busy", { status: 503 }), okResponse()]);
    await t.run();
    expect(t.writes).toHaveLength(1);
  });

  test("retries a 429", async () => {
    const t = setup([new Response("slow", { status: 429 }), okResponse()]);
    expect((await t.run()).ok).toBe(true);
  });

  test("retries a network error", async () => {
    const t = setup([new Error("ECONNRESET"), okResponse()]);
    expect((await t.run()).ok).toBe(true);
  });

  test("waits one second before the first retry", async () => {
    const t = setup([new Response("busy", { status: 503 }), okResponse()]);
    await t.run();
    expect(t.sleeps).toEqual([1000]);
  });

  test("doubles the wait for each retry", async () => {
    const t = setup([new Error("down")]);
    await t.run();
    expect(t.sleeps).toEqual([1000, 2000, 4000]);
  });

  test("gives up after three retries", async () => {
    const t = setup([new Error("down")]);
    await t.run();
    expect(t.calls).toHaveLength(MAX_RETRIES + 1);
  });

  test("fails after the last retry", async () => {
    const t = setup([new Response("busy", { status: 500 })]);
    expect((await t.run()).ok).toBe(false);
  });

  test("does not write when every attempt failed", async () => {
    const t = setup([new Response("busy", { status: 502 })]);
    await t.run();
    expect(t.writes).toHaveLength(0);
  });

  test("allows three retries", () => {
    expect(MAX_RETRIES).toBe(3);
  });

  test("limits the viewer to 10MB", () => {
    expect(MAX_VIEWER_BYTES).toBe(10 * 1024 * 1024);
  });
});
