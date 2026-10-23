import { describe, expect, test } from "bun:test";
import { ApiFailure } from "./errors.ts";
import { fetchIntakeTargets, intakeTargetsQueryKey } from "./intakeQueries.ts";
import type { FetchLike } from "./windmill.ts";

const TARGETS = [
  { owner: "octo-owner", repo: "atelier-works" },
  { owner: "octo-owner", repo: "widgets" },
];

function respondWith(body: string, status = 200): FetchLike {
  return () => Promise.resolve(new Response(body, { status }));
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof ApiFailure ? error.apiError : error;
  }
}

describe("fetchIntakeTargets", () => {
  test("returns the targets", async () => {
    expect(
      await fetchIntakeTargets({
        fetchFn: respondWith(JSON.stringify(TARGETS)),
      }),
    ).toEqual(TARGETS);
  });

  test("asks console_query for the intake_targets view", async () => {
    let sent = "";
    const fetchFn: FetchLike = (_input, init) => {
      sent = String(init.body);
      return Promise.resolve(new Response("[]"));
    };
    await fetchIntakeTargets({ fetchFn });
    expect(JSON.parse(sent)).toEqual({ view: "intake_targets" });
  });

  test("fails with invalid_response when an entry lost its repo", async () => {
    expect(
      await failureOf(
        fetchIntakeTargets({
          fetchFn: respondWith(JSON.stringify([{ owner: "octo-owner" }])),
        }),
      ),
    ).toEqual({ kind: "invalid_response" });
  });

  test("fails with the classified error when the request is refused", async () => {
    expect(
      await failureOf(
        fetchIntakeTargets({ fetchFn: respondWith("Unauthorized", 401) }),
      ),
    ).toEqual({ kind: "unauthorized" });
  });
});

describe("intakeTargetsQueryKey", () => {
  test("is its own cache entry", () => {
    expect(intakeTargetsQueryKey).toEqual(["console", "intake_targets"]);
  });
});
