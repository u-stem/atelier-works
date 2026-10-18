import { describe, expect, test } from "bun:test";
import {
  applyCommit,
  type Converging,
  type HostApplyState,
  isAllowedTransition,
  MAX_STATE_BYTES,
  newState,
  parseState,
  STATE_SCHEMA,
  serializeState,
  withCiPass,
  withManualRequired,
  withRejection,
} from "../../scripts/host_apply/state.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const NEXT = "fedcba9876543210fedcba9876543210fedcba98";
const THIRD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const AT = "2026-10-18T00:00:00Z";
const IMAGE_A = `sha256:${"a".repeat(64)}`;
const IMAGE_B = `sha256:${"b".repeat(64)}`;
const CONTAINER_A = "c".repeat(64);
const CONTAINER_B = "d".repeat(64);
const WORKER = "windmill_worker";
const NATIVE = "windmill_worker_native";

function converging(patch: Partial<Converging> = {}): Converging {
  return {
    sha: NEXT,
    started_at: AT,
    executor_version: SHA,
    phase: "drain",
    case: "B",
    forward_only: false,
    candidates: [WORKER],
    recreate: [WORKER],
    tags_changed: false,
    old_images: { [WORKER]: IMAGE_A },
    new_images: { [WORKER]: IMAGE_B },
    latest_before: { [WORKER]: IMAGE_A },
    old_containers: { [WORKER]: CONTAINER_A },
    drained: [],
    rolled: {},
    confirmation: { at: AT, sha: NEXT, candidates: [WORKER] },
    ...patch,
  };
}

function base(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...newState(SHA, { [WORKER]: { image_id: IMAGE_A, build_key: "k1" } }),
    ...patch,
  };
}

function withConverging(patch: Partial<Converging> = {}) {
  return base({ converging: converging(patch) });
}

function kindOf(value: Record<string, unknown>): string {
  return parseState(JSON.stringify(value)).kind;
}

describe("parseState: the stage 2 state", () => {
  test("reads a state with nothing in flight", () => {
    expect(kindOf(base())).toBe("ok");
  });

  test("reads a converging state", () => {
    expect(kindOf(withConverging())).toBe("ok");
  });

  test("carries the schema version", () => {
    expect(STATE_SCHEMA).toBe(2);
  });

  test("round-trips through serialize and parse", () => {
    const state = parseState(JSON.stringify(withConverging()));
    expect(
      state.kind === "ok" ? parseState(serializeState(state.state)) : null,
    ).toEqual(state);
  });

  test("is state_unreadable for schema 1", () => {
    expect(kindOf(base({ schema: 1 }))).toBe("state_unreadable");
  });

  test("is state_unreadable for a drain field, which now lives in drain.json", () => {
    expect(kindOf(base({ drain: {} }))).toBe("state_unreadable");
  });

  test("is state_unreadable for an unknown top-level key", () => {
    expect(kindOf(base({ extra: 1 }))).toBe("state_unreadable");
  });

  test("is state_unreadable for a missing top-level key", () => {
    const { ci: _ci, ...rest } = base();
    expect(kindOf(rest)).toBe("state_unreadable");
  });

  test("is state_unreadable for a null applied sha", () => {
    expect(kindOf(base({ applied_sha: null }))).toBe("state_unreadable");
  });

  test("is state_unreadable for an applied sha that is not a sha", () => {
    expect(kindOf(base({ applied_sha: "main" }))).toBe("state_unreadable");
  });

  test("is state_unreadable when applied_images lacks the applied sha", () => {
    expect(kindOf(base({ applied_images: { [NEXT]: {} } }))).toBe(
      "state_unreadable",
    );
  });

  test("is state_unreadable for three applied_images", () => {
    expect(
      kindOf(base({ applied_images: { [SHA]: {}, [NEXT]: {}, [THIRD]: {} } })),
    ).toBe("state_unreadable");
  });

  test("is state_unreadable for an image id that is not a digest", () => {
    expect(
      kindOf(
        base({
          applied_images: {
            [SHA]: { [WORKER]: { image_id: "x", build_key: "k" } },
          },
        }),
      ),
    ).toBe("state_unreadable");
  });

  test("is state_unreadable for attempts that is not a count", () => {
    expect(kindOf(base({ attempts: -3 }))).toBe("state_unreadable");
  });

  test("is state_unreadable for a time that is not UTC", () => {
    expect(kindOf(base({ first_seen_at: "2026-10-18T09:00:00+09:00" }))).toBe(
      "state_unreadable",
    );
  });

  test("is state_unreadable for a date that is not on the calendar", () => {
    expect(kindOf(base({ first_seen_at: "2026-02-30T00:00:00Z" }))).toBe(
      "state_unreadable",
    );
  });

  test("is state_unreadable for an unknown rejection kind", () => {
    expect(
      kindOf(
        base({
          rejected: { [SHA]: { kind: "weird", at: AT, executor_version: SHA } },
        }),
      ),
    ).toBe("state_unreadable");
  });

  test("is state_unreadable for an executor version that is not a sha", () => {
    expect(
      kindOf(
        base({
          rejected: {
            [SHA]: { kind: "not_ff", at: AT, executor_version: "stage1" },
          },
        }),
      ),
    ).toBe("state_unreadable");
  });

  test("is state_unreadable for a notified reason that is unknown", () => {
    expect(
      kindOf(base({ notified: { whatever: { last_at: AT, open: true } } })),
    ).toBe("state_unreadable");
  });

  test("reads a notified reason that is known", () => {
    expect(
      kindOf(base({ notified: { drift: { last_at: AT, open: true } } })),
    ).toBe("ok");
  });

  test("is state_unreadable for twenty-one ci verdicts", () => {
    const ci = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [
        index.toString(16).padStart(40, "0"),
        { verdict: "pass", at: AT },
      ]),
    );
    expect(kindOf(base({ ci }))).toBe("state_unreadable");
  });

  test("is state_unreadable for an unknown last outcome", () => {
    expect(kindOf(base({ last_outcome: { kind: "weird", at: AT } }))).toBe(
      "state_unreadable",
    );
  });

  test("is state_unreadable for a ruleset context with a newline", () => {
    expect(kindOf(base({ ruleset: { contexts: ["a\nb"], at: AT } }))).toBe(
      "state_unreadable",
    );
  });

  test("is state_unreadable for text that is not JSON", () => {
    expect(parseState("{").kind).toBe("state_unreadable");
  });

  test("is state_unreadable for an empty file", () => {
    expect(parseState("").kind).toBe("state_unreadable");
  });

  test("is state_unreadable for an empty object", () => {
    expect(parseState("{}").kind).toBe("state_unreadable");
  });

  test("is state_unreadable for an array", () => {
    expect(parseState("[]").kind).toBe("state_unreadable");
  });

  test("is state_unreadable for a body over the size limit", () => {
    expect(parseState(" ".repeat(MAX_STATE_BYTES + 1)).kind).toBe(
      "state_unreadable",
    );
  });

  test("gives a reason that does not echo the file contents", () => {
    const result = parseState('{"secret":"hunter2hunter2"}');
    expect(
      result.kind === "state_unreadable" ? result.reason : "",
    ).not.toContain("hunter2");
  });
});

describe("parseState: converging", () => {
  test("is state_unreadable for the applied sha as the converging sha", () => {
    expect(
      kindOf(
        withConverging({
          sha: SHA,
          confirmation: { at: AT, sha: SHA, candidates: [WORKER] },
        }),
      ),
    ).toBe("state_unreadable");
  });

  test("is state_unreadable for an executor version that is not a sha", () => {
    expect(kindOf(withConverging({ executor_version: "stage1" }))).toBe(
      "state_unreadable",
    );
  });

  test("is state_unreadable for an unknown phase", () => {
    expect(
      kindOf(base({ converging: { ...converging(), phase: "weird" } })),
    ).toBe("state_unreadable");
  });

  test("is state_unreadable for an unknown case", () => {
    expect(kindOf(base({ converging: { ...converging(), case: "Z" } }))).toBe(
      "state_unreadable",
    );
  });

  test("is state_unreadable for a converging key that is unknown", () => {
    expect(kindOf(base({ converging: { ...converging(), extra: 1 } }))).toBe(
      "state_unreadable",
    );
  });

  test("is state_unreadable without a confirmation", () => {
    const { confirmation: _confirmation, ...rest } = converging();
    expect(kindOf(base({ converging: rest }))).toBe("state_unreadable");
  });

  test("is state_unreadable when the confirmation is for another sha", () => {
    expect(
      kindOf(
        withConverging({
          confirmation: { at: AT, sha: THIRD, candidates: [WORKER] },
        }),
      ),
    ).toBe("state_unreadable");
  });

  test("is state_unreadable when the confirmation candidates differ", () => {
    expect(
      kindOf(
        withConverging({
          confirmation: { at: AT, sha: NEXT, candidates: [WORKER, NATIVE] },
        }),
      ),
    ).toBe("state_unreadable");
  });

  test("is state_unreadable when recreate goes beyond the candidates", () => {
    expect(
      kindOf(
        withConverging({
          recreate: [WORKER, NATIVE],
          old_containers: { [WORKER]: CONTAINER_A, [NATIVE]: null },
        }),
      ),
    ).toBe("state_unreadable");
  });

  test("is state_unreadable for a missing latest_before after the build", () => {
    expect(kindOf(withConverging({ latest_before: null }))).toBe(
      "state_unreadable",
    );
  });

  test("reads a missing latest_before during the build", () => {
    expect(
      kindOf(
        withConverging({
          phase: "build",
          latest_before: null,
          recreate: [],
          old_containers: {},
          old_images: {},
          new_images: {},
        }),
      ),
    ).toBe("ok");
  });

  test("is state_unreadable for a drained service during the build", () => {
    expect(kindOf(withConverging({ phase: "build", drained: [WORKER] }))).toBe(
      "state_unreadable",
    );
  });

  test("is state_unreadable when old_containers differs from recreate", () => {
    expect(kindOf(withConverging({ old_containers: {} }))).toBe(
      "state_unreadable",
    );
  });

  test("is state_unreadable for a container id of twelve digits", () => {
    expect(
      kindOf(withConverging({ old_containers: { [WORKER]: "c".repeat(12) } })),
    ).toBe("state_unreadable");
  });

  test("reads a service that had no container", () => {
    expect(kindOf(withConverging({ old_containers: { [WORKER]: null } }))).toBe(
      "ok",
    );
  });

  test("reads forward_only under case B, since each case decides its own rules", () => {
    expect(kindOf(withConverging({ forward_only: true, phase: "apply" }))).toBe(
      "ok",
    );
  });

  test("is state_unreadable for forward_only during restore", () => {
    expect(
      kindOf(
        withConverging({ case: "A", forward_only: true, phase: "restore" }),
      ),
    ).toBe("state_unreadable");
  });

  test("reads forward_only under case A at apply", () => {
    expect(
      kindOf(withConverging({ case: "A", forward_only: true, phase: "apply" })),
    ).toBe("ok");
  });

  test("reads the restore phase while forward_only is false", () => {
    expect(kindOf(withConverging({ phase: "restore" }))).toBe("ok");
  });
});

function committable(): HostApplyState {
  const parsed = parseState(
    JSON.stringify(
      withConverging({
        phase: "post",
        rolled: { [WORKER]: CONTAINER_B },
      }),
    ),
  );
  if (parsed.kind !== "ok") throw new Error("fixture is invalid");
  return parsed.state;
}

const IMAGES = { [WORKER]: { image_id: IMAGE_B, build_key: "k2" } };

describe("applyCommit", () => {
  test("moves the applied sha to the converging sha", () => {
    expect(
      applyCommit(committable(), {
        images: IMAGES,
        outcome: "converged",
        now: AT,
      }).applied_sha,
    ).toBe(NEXT);
  });

  test("clears the converging record", () => {
    expect(
      applyCommit(committable(), {
        images: IMAGES,
        outcome: "converged",
        now: AT,
      }).converging,
    ).toBeNull();
  });

  test("keeps the previous and the new applied images only", () => {
    const first = applyCommit(committable(), {
      images: IMAGES,
      outcome: "converged",
      now: AT,
    });
    expect(Object.keys(first.applied_images).sort()).toEqual(
      [NEXT, SHA].sort(),
    );
  });

  test("drops the third oldest applied images", () => {
    const first = applyCommit(committable(), {
      images: IMAGES,
      outcome: "converged",
      now: AT,
    });
    const second = applyCommit(
      {
        ...first,
        converging: converging({
          sha: THIRD,
          phase: "post",
          rolled: { [WORKER]: CONTAINER_B },
          confirmation: { at: AT, sha: THIRD, candidates: [WORKER] },
        }),
      },
      { images: IMAGES, outcome: "converged", now: AT },
    );
    expect(Object.keys(second.applied_images).sort()).toEqual(
      [NEXT, THIRD].sort(),
    );
  });

  test("records the outcome", () => {
    expect(
      applyCommit(committable(), {
        images: IMAGES,
        outcome: "finished_manually",
        now: AT,
      }).last_outcome,
    ).toEqual({ kind: "finished_manually", at: AT });
  });

  test("resets the attempts", () => {
    expect(
      applyCommit(
        { ...committable(), attempts: 4 },
        {
          images: IMAGES,
          outcome: "converged",
          now: AT,
        },
      ).attempts,
    ).toBe(0);
  });

  test("throws unless the phase is post", () => {
    const state = { ...committable(), converging: converging() };
    expect(() =>
      applyCommit(state, { images: IMAGES, outcome: "converged", now: AT }),
    ).toThrow();
  });

  test("throws without a converging record", () => {
    expect(() =>
      applyCommit(parseOk(base()), {
        images: IMAGES,
        outcome: "converged",
        now: AT,
      }),
    ).toThrow();
  });

  test("throws for images with a service that was not recreated", () => {
    expect(() =>
      applyCommit(committable(), {
        images: { ...IMAGES, db: { image_id: IMAGE_A, build_key: "k" } },
        outcome: "converged",
        now: AT,
      }),
    ).toThrow("images do not match");
  });

  test("throws when no image was recorded", () => {
    const state = committable();
    const empty: HostApplyState = {
      ...state,
      converging: state.converging && { ...state.converging, new_images: {} },
    };
    expect(() =>
      applyCommit(empty, { images: {}, outcome: "converged", now: AT }),
    ).toThrow("images do not match");
  });

  test("throws for images that differ from the recorded new images", () => {
    expect(() =>
      applyCommit(committable(), {
        images: { [WORKER]: { image_id: IMAGE_A, build_key: "k2" } },
        outcome: "converged",
        now: AT,
      }),
    ).toThrow("images do not match");
  });
});

function parseOk(value: Record<string, unknown>): HostApplyState {
  const parsed = parseState(JSON.stringify(value));
  if (parsed.kind !== "ok") throw new Error("fixture is invalid");
  return parsed.state;
}

describe("the helpers that keep the counts down", () => {
  test("withCiPass keeps the newest twenty verdicts", () => {
    let state = parseOk(base());
    for (let index = 0; index < 25; index += 1) {
      state = withCiPass(
        state,
        index.toString(16).padStart(40, "0"),
        `2026-10-18T00:00:${String(index).padStart(2, "0")}Z`,
      );
    }
    expect(Object.keys(state.ci).length).toBe(20);
  });

  test("withCiPass drops the oldest verdict", () => {
    let state = parseOk(base());
    for (let index = 0; index < 21; index += 1) {
      state = withCiPass(
        state,
        index.toString(16).padStart(40, "0"),
        `2026-10-18T00:00:${String(index).padStart(2, "0")}Z`,
      );
    }
    expect(Object.keys(state.ci)).not.toContain("0".repeat(40));
  });

  test("withRejection stays within the limit the guard allows", () => {
    let state = parseOk(base());
    for (let index = 0; index < 205; index += 1) {
      state = withRejection(state, index.toString(16).padStart(40, "0"), {
        kind: "not_ff",
        at: `2026-10-18T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`,
        executor_version: SHA,
      });
    }
    expect(parseState(serializeState(state)).kind).toBe("ok");
  });

  test("withManualRequired stays within the limit the guard allows", () => {
    let state = parseOk(base());
    for (let index = 0; index < 205; index += 1) {
      state = withManualRequired(state, index.toString(16).padStart(40, "0"), {
        at: `2026-10-18T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`,
        executor_version: SHA,
      });
    }
    expect(parseState(serializeState(state)).kind).toBe("ok");
  });
});

describe("serializeState", () => {
  test("throws for a state that fails the guard", () => {
    expect(() => serializeState({ ...parseOk(base()), attempts: -1 })).toThrow(
      "invalid state",
    );
  });
});

function stateWith(converging_: Converging | null): HostApplyState {
  return parseOk(base({ converging: converging_ }));
}

function building(): Converging {
  return converging({
    phase: "build",
    case: null,
    recreate: [],
    old_containers: {},
    old_images: {},
    new_images: {},
    latest_before: null,
  });
}

const NONE = stateWith(null);

describe("converging: more fields", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["a missing case after the build", { case: null }],
    ["an unknown case", { case: "Z" }],
    ["a forward_only that is not a boolean", { forward_only: "yes" }],
    ["a tags_changed that is not a boolean", { tags_changed: 1 }],
    ["a service name with a capital", { candidates: ["Worker"] }],
    ["a duplicated candidate", { candidates: [WORKER, WORKER] }],
    ["a duplicated recreate", { recreate: [WORKER, WORKER] }],
    ["a duplicated drained service", { drained: [WORKER, WORKER] }],
    ["a started_at that is not a time", { started_at: "yesterday" }],
    [
      "a confirmation time that is not a time",
      { confirmation: { at: "x", sha: NEXT, candidates: [WORKER] } },
    ],
    ["a new image id that is not a digest", { new_images: { [WORKER]: "x" } }],
    [
      "a latest_before that is not a digest",
      { latest_before: { [WORKER]: "x" } },
    ],
    [
      "a rolled value that is not a container id",
      { rolled: { [WORKER]: "x" } },
    ],
    [
      "forward_only during the build",
      { forward_only: true, phase: "build", case: null, latest_before: null },
    ],
  ];

  test.each(cases)("is state_unreadable for %s", (_name, patch) => {
    expect(kindOf(base({ converging: { ...converging(), ...patch } }))).toBe(
      "state_unreadable",
    );
  });

  test("reads a missing case during the build", () => {
    expect(kindOf(base({ converging: building() }))).toBe("ok");
  });

  test("reads a drained service together with a rolled one, since each case decides its own rules", () => {
    expect(
      kindOf(
        withConverging({
          drained: [NATIVE],
          rolled: { [WORKER]: CONTAINER_B },
          candidates: [WORKER, NATIVE],
          recreate: [WORKER, NATIVE],
          old_containers: { [WORKER]: CONTAINER_A, [NATIVE]: CONTAINER_A },
          confirmation: { at: AT, sha: NEXT, candidates: [WORKER, NATIVE] },
        }),
      ),
    ).toBe("ok");
  });
});

describe("the other fields of the state", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["no applied images", { applied_images: {} }],
    ["an applied sha with no images", { applied_images: { [SHA]: {} } }],
    [
      "an applied images key that is not a sha",
      { applied_images: { __proto__x: {} } },
    ],
    ["a prepared sha that is not a sha", { prepared_sha: "abc" }],
    ["a last target that is not a sha", { last_target: 5 }],
    [
      "a build key with a space",
      {
        applied_images: {
          [SHA]: { [WORKER]: { image_id: IMAGE_A, build_key: "a b" } },
        },
      },
    ],
    [
      "an applied images service name that is not a name",
      {
        applied_images: {
          [SHA]: { "Bad Name": { image_id: IMAGE_A, build_key: "k" } },
        },
      },
    ],
  ];

  test.each(cases)("is state_unreadable for %s", (_name, patch) => {
    expect(kindOf(base(patch))).toBe("state_unreadable");
  });

  test("is state_unreadable for 201 rejections", () => {
    const rejected = Object.fromEntries(
      Array.from({ length: 201 }, (_, index) => [
        index.toString(16).padStart(40, "0"),
        { kind: "not_ff", at: AT, executor_version: SHA },
      ]),
    );
    expect(kindOf(base({ rejected }))).toBe("state_unreadable");
  });

  test("is state_unreadable for 201 manual_required entries", () => {
    const manual = Object.fromEntries(
      Array.from({ length: 201 }, (_, index) => [
        index.toString(16).padStart(40, "0"),
        { at: AT, executor_version: SHA },
      ]),
    );
    expect(kindOf(base({ manual_required: manual }))).toBe("state_unreadable");
  });

  test("is state_unreadable for 33 ruleset contexts", () => {
    const contexts = Array.from({ length: 33 }, (_, index) => `check-${index}`);
    expect(kindOf(base({ ruleset: { contexts, at: AT } }))).toBe(
      "state_unreadable",
    );
  });

  test("reads a ruleset", () => {
    expect(
      kindOf(base({ ruleset: { contexts: ["check", "test-db"], at: AT } })),
    ).toBe("ok");
  });

  test("is state_unreadable for a ci key that is not a sha", () => {
    expect(kindOf(base({ ci: { main: { verdict: "pass", at: AT } } }))).toBe(
      "state_unreadable",
    );
  });

  test("is state_unreadable for a ci verdict other than pass", () => {
    expect(kindOf(base({ ci: { [SHA]: { verdict: "fail", at: AT } } }))).toBe(
      "state_unreadable",
    );
  });
});

describe("isAllowedTransition", () => {
  const drain = () => converging({ phase: "drain", rolled: {} });

  test("lets a convergence start at the build", () => {
    expect(isAllowedTransition(NONE, stateWith(building()))).toBe(true);
  });

  test("refuses a convergence that starts after the build", () => {
    expect(isAllowedTransition(NONE, stateWith(drain()))).toBe(false);
  });

  test("lets a convergence be cleared during the build", () => {
    expect(isAllowedTransition(stateWith(building()), NONE)).toBe(true);
  });

  test("lets a convergence be cleared after a restore", () => {
    expect(
      isAllowedTransition(
        stateWith(converging({ phase: "restore", rolled: {} })),
        NONE,
      ),
    ).toBe(true);
  });

  test("refuses to clear a convergence during the drain", () => {
    expect(isAllowedTransition(stateWith(drain()), NONE)).toBe(false);
  });

  test("refuses to clear a convergence at the post", () => {
    expect(
      isAllowedTransition(
        stateWith(
          converging({ phase: "post", rolled: { [WORKER]: CONTAINER_B } }),
        ),
        NONE,
      ),
    ).toBe(false);
  });

  test("refuses to skip a phase", () => {
    expect(
      isAllowedTransition(
        stateWith(building()),
        stateWith(
          converging({ phase: "post", rolled: { [WORKER]: CONTAINER_B } }),
        ),
      ),
    ).toBe(false);
  });

  test("refuses to skip from the drain to the post", () => {
    expect(
      isAllowedTransition(
        stateWith(drain()),
        stateWith(
          converging({ phase: "post", rolled: { [WORKER]: CONTAINER_B } }),
        ),
      ),
    ).toBe(false);
  });

  test("refuses to change the case once it is decided", () => {
    expect(
      isAllowedTransition(
        stateWith(drain()),
        stateWith(converging({ phase: "drain", rolled: {}, case: "C" })),
      ),
    ).toBe(false);
  });

  test("refuses to change tags_changed after the build", () => {
    expect(
      isAllowedTransition(
        stateWith(drain()),
        stateWith(
          converging({ phase: "drain", rolled: {}, tags_changed: true }),
        ),
      ),
    ).toBe(false);
  });

  test("refuses to change the start time", () => {
    expect(
      isAllowedTransition(
        stateWith(drain()),
        stateWith(
          converging({
            phase: "drain",
            rolled: {},
            started_at: "2026-10-19T00:00:00Z",
          }),
        ),
      ),
    ).toBe(false);
  });

  test("refuses to change the executor version", () => {
    expect(
      isAllowedTransition(
        stateWith(drain()),
        stateWith(
          converging({ phase: "drain", rolled: {}, executor_version: THIRD }),
        ),
      ),
    ).toBe(false);
  });

  test("refuses to change old_images after the build", () => {
    expect(
      isAllowedTransition(
        stateWith(drain()),
        stateWith(
          converging({
            phase: "drain",
            rolled: {},
            old_images: { [WORKER]: IMAGE_B },
          }),
        ),
      ),
    ).toBe(false);
  });

  test("refuses to change new_images after the build", () => {
    expect(
      isAllowedTransition(
        stateWith(drain()),
        stateWith(
          converging({
            phase: "drain",
            rolled: {},
            new_images: { [WORKER]: IMAGE_A },
          }),
        ),
      ),
    ).toBe(false);
  });

  test("refuses to change the container id of a rolled service", () => {
    expect(
      isAllowedTransition(
        stateWith(
          converging({ phase: "apply", rolled: { [WORKER]: CONTAINER_B } }),
        ),
        stateWith(
          converging({ phase: "apply", rolled: { [WORKER]: CONTAINER_A } }),
        ),
      ),
    ).toBe(false);
  });

  test("lets the build move on to the drain", () => {
    expect(isAllowedTransition(stateWith(building()), stateWith(drain()))).toBe(
      true,
    );
  });

  test("lets the drain move on to the apply", () => {
    expect(
      isAllowedTransition(
        stateWith(drain()),
        stateWith(converging({ phase: "apply", rolled: {} })),
      ),
    ).toBe(true);
  });

  test("refuses to go back from the apply to the drain", () => {
    expect(
      isAllowedTransition(
        stateWith(converging({ phase: "apply", rolled: {} })),
        stateWith(drain()),
      ),
    ).toBe(false);
  });

  test("lets the drain turn to a restore", () => {
    expect(
      isAllowedTransition(
        stateWith(drain()),
        stateWith(converging({ phase: "restore", rolled: {} })),
      ),
    ).toBe(true);
  });

  test("refuses a restore that starts at the build", () => {
    expect(
      isAllowedTransition(
        stateWith(building()),
        stateWith(converging({ phase: "restore", rolled: {} })),
      ),
    ).toBe(false);
  });

  test("refuses a restore that starts at the post", () => {
    expect(
      isAllowedTransition(
        stateWith(
          converging({ phase: "post", rolled: { [WORKER]: CONTAINER_B } }),
        ),
        stateWith(
          converging({ phase: "restore", rolled: { [WORKER]: CONTAINER_B } }),
        ),
      ),
    ).toBe(false);
  });

  test("refuses to go forward again after a restore", () => {
    expect(
      isAllowedTransition(
        stateWith(converging({ phase: "restore", rolled: {} })),
        stateWith(converging({ phase: "apply", rolled: {} })),
      ),
    ).toBe(false);
  });

  test("lets a restore stay a restore", () => {
    const restore = converging({ phase: "restore", rolled: {} });
    expect(
      isAllowedTransition(stateWith(restore), stateWith({ ...restore })),
    ).toBe(true);
  });

  test("refuses to change the sha", () => {
    expect(
      isAllowedTransition(
        stateWith(drain()),
        stateWith(
          converging({
            phase: "drain",
            rolled: {},
            sha: THIRD,
            confirmation: { at: AT, sha: THIRD, candidates: [WORKER] },
          }),
        ),
      ),
    ).toBe(false);
  });

  test("refuses to change the confirmation", () => {
    expect(
      isAllowedTransition(
        stateWith(drain()),
        stateWith(
          converging({
            phase: "drain",
            rolled: {},
            confirmation: {
              at: "2026-10-19T00:00:00Z",
              sha: NEXT,
              candidates: [WORKER],
            },
          }),
        ),
      ),
    ).toBe(false);
  });

  test("refuses to change the candidates", () => {
    expect(
      isAllowedTransition(
        stateWith(drain()),
        stateWith(
          converging({
            phase: "drain",
            rolled: {},
            candidates: [WORKER, NATIVE],
            confirmation: { at: AT, sha: NEXT, candidates: [WORKER, NATIVE] },
          }),
        ),
      ),
    ).toBe(false);
  });

  test("refuses to change latest_before once it is written", () => {
    expect(
      isAllowedTransition(
        stateWith(drain()),
        stateWith(
          converging({
            phase: "drain",
            rolled: {},
            latest_before: { [WORKER]: IMAGE_B },
          }),
        ),
      ),
    ).toBe(false);
  });

  test("lets latest_before be written once", () => {
    expect(isAllowedTransition(stateWith(building()), stateWith(drain()))).toBe(
      true,
    );
  });

  test("refuses to change old_containers after the build", () => {
    expect(
      isAllowedTransition(
        stateWith(drain()),
        stateWith(
          converging({
            phase: "drain",
            rolled: {},
            old_containers: { [WORKER]: CONTAINER_B },
          }),
        ),
      ),
    ).toBe(false);
  });

  test("refuses to change recreate after the build", () => {
    expect(
      isAllowedTransition(
        stateWith(drain()),
        stateWith(
          converging({
            phase: "drain",
            rolled: {},
            recreate: [],
            old_containers: {},
          }),
        ),
      ),
    ).toBe(false);
  });

  test("refuses to turn forward_only off", () => {
    const forward = converging({
      case: "A",
      forward_only: true,
      phase: "apply",
      rolled: {},
    });
    expect(
      isAllowedTransition(
        stateWith(forward),
        stateWith({ ...forward, forward_only: false }),
      ),
    ).toBe(false);
  });

  test("refuses to drop a rolled service outside a restore", () => {
    expect(
      isAllowedTransition(
        stateWith(
          converging({ phase: "apply", rolled: { [WORKER]: CONTAINER_B } }),
        ),
        stateWith(converging({ phase: "apply", rolled: {} })),
      ),
    ).toBe(false);
  });

  test("lets a rolled service be added", () => {
    expect(
      isAllowedTransition(
        stateWith(converging({ phase: "apply", rolled: {} })),
        stateWith(
          converging({ phase: "apply", rolled: { [WORKER]: CONTAINER_B } }),
        ),
      ),
    ).toBe(true);
  });

  test("ignores the order of the keys", () => {
    const wide = converging({
      phase: "drain",
      rolled: {},
      candidates: [WORKER, NATIVE],
      recreate: [WORKER, NATIVE],
      old_containers: { [WORKER]: CONTAINER_A, [NATIVE]: CONTAINER_A },
      confirmation: { at: AT, sha: NEXT, candidates: [WORKER, NATIVE] },
    });
    const reordered = {
      ...wide,
      old_containers: { [NATIVE]: CONTAINER_A, [WORKER]: CONTAINER_A },
    };
    expect(isAllowedTransition(stateWith(wide), stateWith(reordered))).toBe(
      true,
    );
  });
});

describe("switch and post", () => {
  test("is state_unreadable at switch while a recreated worker is not rolled", () => {
    expect(kindOf(withConverging({ phase: "switch" }))).toBe(
      "state_unreadable",
    );
  });

  test("reads switch once every recreated worker is rolled", () => {
    expect(
      kindOf(
        withConverging({ phase: "switch", rolled: { [WORKER]: CONTAINER_B } }),
      ),
    ).toBe("ok");
  });

  test("ignores the order of recreate and candidates in a transition", () => {
    const wide = converging({
      phase: "drain",
      rolled: {},
      candidates: [WORKER, NATIVE],
      recreate: [WORKER, NATIVE],
      old_containers: { [WORKER]: CONTAINER_A, [NATIVE]: CONTAINER_A },
      confirmation: { at: AT, sha: NEXT, candidates: [WORKER, NATIVE] },
    });
    const swapped = {
      ...wide,
      candidates: [NATIVE, WORKER],
      recreate: [NATIVE, WORKER],
      confirmation: { at: AT, sha: NEXT, candidates: [NATIVE, WORKER] },
    };
    expect(isAllowedTransition(stateWith(wide), stateWith(swapped))).toBe(true);
  });
});

describe("the worker names", () => {
  test("every compose worker service is a drainable worker", async () => {
    const { COMPOSE_SERVICE_ALLOWLIST } = await import(
      "../../scripts/host_apply/compose_policy.ts"
    );
    const { WORKERS } = await import("../../scripts/host_apply/drain_store.ts");
    expect(
      COMPOSE_SERVICE_ALLOWLIST.filter((name) =>
        name.startsWith("windmill_worker"),
      ).sort(),
    ).toEqual([...WORKERS].sort());
  });
});

describe("keeping the newest entries", () => {
  const NEW = "2".repeat(40);

  function key(index: number): string {
    return index.toString(16).padStart(40, "0");
  }

  function filled(time: (index: number) => string): HostApplyState {
    let state = parseOk(base());
    for (let index = 0; index < 20; index += 1) {
      state = withCiPass(state, key(index), time(index));
    }
    return state;
  }

  test("compares times by value, not as text", () => {
    // 小数部のある時刻は、文字列では「.」が「Z」より前に来て古く見えるが、値では新しい。
    const state = withCiPass(
      filled(() => "2026-10-18T01:00:00Z"),
      NEW,
      "2026-10-18T01:00:00.5Z",
    );
    expect(Object.keys(state.ci)).toContain(NEW);
  });

  test("drops the oldest entry when it is full", () => {
    const state = withCiPass(
      filled((index) => `2026-10-18T00:00:${String(index).padStart(2, "0")}Z`),
      NEW,
      "2026-10-18T02:00:00Z",
    );
    expect(Object.keys(state.ci)).not.toContain(key(0));
  });
});

describe("withManualRequired", () => {
  test("keeps the entry that it adds", () => {
    expect(
      Object.keys(
        withManualRequired(parseOk(base()), SHA, {
          at: AT,
          executor_version: SHA,
        }).manual_required,
      ),
    ).toEqual([SHA]);
  });
});
