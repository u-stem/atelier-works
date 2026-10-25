import { describe, expect, test } from "bun:test";
import { fetchConsoleStatus } from "./consoleStatus.ts";
import { type FetchLike, setConnectionReporter } from "./windmill.ts";

const OK = {
  state: "ok",
  sha: "0123456789abcdef",
  checked_at: "2026-10-09T11:57:00.000Z",
  error: null,
};

function respondWith(body: string, status = 200): FetchLike {
  return () => Promise.resolve(new Response(body, { status }));
}

describe("fetchConsoleStatus", () => {
  test("returns the parsed status", async () => {
    expect(await fetchConsoleStatus(respondWith(JSON.stringify(OK)))).toEqual(
      OK,
    );
  });

  test("requests status.json under /console/", async () => {
    const urls: string[] = [];
    await fetchConsoleStatus((input) => {
      urls.push(input);
      return Promise.resolve(new Response(JSON.stringify(OK)));
    });
    expect(urls).toEqual(["/console/status.json"]);
  });

  test("returns null on a 404", async () => {
    expect(await fetchConsoleStatus(respondWith("not found", 404))).toBeNull();
  });

  test("returns null for a body that is not JSON", async () => {
    expect(await fetchConsoleStatus(respondWith("<html>"))).toBeNull();
  });

  test("returns null for JSON of the wrong shape", async () => {
    expect(await fetchConsoleStatus(respondWith('{"state":1}'))).toBeNull();
  });

  test("returns null when the request fails", async () => {
    expect(
      await fetchConsoleStatus(() => Promise.reject(new TypeError("offline"))),
    ).toBeNull();
  });
});

describe("fetchConsoleStatus and the connection report", () => {
  test("does not report to the connection state, whether it succeeds", async () => {
    let reports = 0;
    setConnectionReporter(() => {
      reports += 1;
    });
    await fetchConsoleStatus(respondWith(JSON.stringify(OK)));
    setConnectionReporter(null);
    expect(reports).toBe(0);
  });

  test("does not report to the connection state when the fetch fails", async () => {
    let reports = 0;
    setConnectionReporter(() => {
      reports += 1;
    });
    await fetchConsoleStatus(() => Promise.reject(new TypeError("down")));
    setConnectionReporter(null);
    expect(reports).toBe(0);
  });
});
