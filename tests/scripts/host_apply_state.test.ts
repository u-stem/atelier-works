import { describe, expect, test } from "bun:test";
import {
  initialState,
  parseState,
  STATE_SCHEMA,
} from "../../scripts/host_apply/state.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function validJson(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...initialState(SHA), ...patch });
}

describe("initialState", () => {
  test("starts with the applied sha and no attempts", () => {
    const state = initialState(SHA);
    expect([state.applied_sha, state.attempts]).toEqual([SHA, 0]);
  });

  test("allows an unknown applied sha", () => {
    expect(initialState(null).applied_sha).toBeNull();
  });

  test("carries the schema version", () => {
    expect(initialState(SHA).schema).toBe(STATE_SCHEMA);
  });
});

describe("parseState", () => {
  test("reads a state it wrote", () => {
    expect(parseState(validJson()).kind).toBe("ok");
  });

  test("round-trips the fields", () => {
    const result = parseState(
      validJson({
        attempts: 2,
        rejected: {
          [SHA]: {
            kind: "tree_forbidden",
            at: "2026-10-17T00:00:00Z",
            executor_version: "v1",
          },
        },
        converging: { sha: SHA, started_at: "t", drained: ["windmill_worker"] },
      }),
    );
    expect(result.kind === "ok" ? result.state.rejected[SHA]?.kind : null).toBe(
      "tree_forbidden",
    );
  });

  test("is state_unreadable for text that is not JSON", () => {
    expect(parseState("{").kind).toBe("state_unreadable");
  });

  test("is state_unreadable for an empty file", () => {
    expect(parseState("").kind).toBe("state_unreadable");
  });

  test("is state_unreadable for an empty object, not an empty state", () => {
    expect(parseState("{}").kind).toBe("state_unreadable");
  });

  test("is state_unreadable for an unknown schema version", () => {
    expect(parseState(validJson({ schema: 99 })).kind).toBe("state_unreadable");
  });

  test("is state_unreadable when the schema version is missing", () => {
    const { schema: _schema, ...rest } = initialState(SHA);
    expect(parseState(JSON.stringify(rest)).kind).toBe("state_unreadable");
  });

  test("is state_unreadable when the applied sha is not a sha", () => {
    expect(parseState(validJson({ applied_sha: "main" })).kind).toBe(
      "state_unreadable",
    );
  });

  test("is state_unreadable when attempts is not a count", () => {
    expect(parseState(validJson({ attempts: -3 })).kind).toBe(
      "state_unreadable",
    );
  });

  test("is state_unreadable when attempts is a string", () => {
    expect(parseState(validJson({ attempts: "2" })).kind).toBe(
      "state_unreadable",
    );
  });

  test("is state_unreadable for an unknown rejection kind", () => {
    expect(
      parseState(
        validJson({
          rejected: {
            [SHA]: { kind: "weird", at: "t", executor_version: "v1" },
          },
        }),
      ).kind,
    ).toBe("state_unreadable");
  });

  test("is state_unreadable when a rejection has no executor version", () => {
    expect(
      parseState(
        validJson({
          rejected: { [SHA]: { kind: "compose_forbidden", at: "t" } },
        }),
      ).kind,
    ).toBe("state_unreadable");
  });

  test("is state_unreadable when converging has the wrong shape", () => {
    expect(parseState(validJson({ converging: { sha: 5 } })).kind).toBe(
      "state_unreadable",
    );
  });

  test("is state_unreadable when drain has the wrong shape", () => {
    expect(
      parseState(validJson({ drain: { windmill_worker: "x" } })).kind,
    ).toBe("state_unreadable");
  });

  test("is state_unreadable when applied_images has the wrong shape", () => {
    expect(
      parseState(validJson({ applied_images: { [SHA]: { a: 1 } } })).kind,
    ).toBe("state_unreadable");
  });

  test("is state_unreadable when notified has the wrong shape", () => {
    expect(
      parseState(validJson({ notified: { drift: { last_at: "t" } } })).kind,
    ).toBe("state_unreadable");
  });

  test("is state_unreadable for an array", () => {
    expect(parseState("[]").kind).toBe("state_unreadable");
  });

  test("gives a reason that does not echo the file contents", () => {
    const result = parseState('{"secret":"hunter2hunter2"}');
    expect(
      result.kind === "state_unreadable" ? result.reason : "",
    ).not.toContain("hunter2");
  });
});
