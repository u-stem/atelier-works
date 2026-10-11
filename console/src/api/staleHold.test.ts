import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { holdUntilFresh } from "./staleHold.ts";

const SUMMARY_KEY = ["console", "summary"] as const;

describe("holdUntilFresh", () => {
  test("does not release before the data is fresh", () => {
    const client = new QueryClient();
    let released = false;
    holdUntilFresh(client.getQueryCache(), [SUMMARY_KEY], () => {
      released = true;
    });
    expect(released).toBe(false);
  });

  test("releases when a watched query gets fresh data", () => {
    const client = new QueryClient();
    let released = false;
    holdUntilFresh(client.getQueryCache(), [SUMMARY_KEY], () => {
      released = true;
    });
    client.setQueryData(SUMMARY_KEY, { counts: 1 });
    expect(released).toBe(true);
  });

  test("does not release for a query it does not watch", () => {
    const client = new QueryClient();
    let released = false;
    holdUntilFresh(client.getQueryCache(), [SUMMARY_KEY], () => {
      released = true;
    });
    client.setQueryData(["console", "deployments"], []);
    expect(released).toBe(false);
  });

  test("releases only once", () => {
    const client = new QueryClient();
    let releases = 0;
    holdUntilFresh(client.getQueryCache(), [SUMMARY_KEY], () => {
      releases += 1;
    });
    client.setQueryData(SUMMARY_KEY, 1);
    client.setQueryData(SUMMARY_KEY, 2);
    expect(releases).toBe(1);
  });

  test("does not release after it is cancelled", () => {
    const client = new QueryClient();
    let released = false;
    const cancel = holdUntilFresh(client.getQueryCache(), [SUMMARY_KEY], () => {
      released = true;
    });
    cancel();
    client.setQueryData(SUMMARY_KEY, 1);
    expect(released).toBe(false);
  });

  test("does not release until every watched query has fresh data", () => {
    const client = new QueryClient();
    let released = false;
    holdUntilFresh(
      client.getQueryCache(),
      [SUMMARY_KEY, ["console", "deployments"]],
      () => {
        released = true;
      },
    );
    client.setQueryData(SUMMARY_KEY, 1);
    expect(released).toBe(false);
  });

  test("releases once every watched query has fresh data", () => {
    const client = new QueryClient();
    let released = false;
    holdUntilFresh(
      client.getQueryCache(),
      [SUMMARY_KEY, ["console", "deployments"]],
      () => {
        released = true;
      },
    );
    client.setQueryData(SUMMARY_KEY, 1);
    client.setQueryData(["console", "deployments"], []);
    expect(released).toBe(true);
  });

  test("releases at once when nothing is watched", () => {
    const client = new QueryClient();
    let released = false;
    holdUntilFresh(client.getQueryCache(), [], () => {
      released = true;
    });
    expect(released).toBe(true);
  });
});
