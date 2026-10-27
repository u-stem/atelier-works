import { describe, expect, test } from "bun:test";
import { holdsQueryKey } from "../../api/holdsQueries.ts";
import { schedulesQueryKey } from "../../api/jobsQueries.ts";
import { systemStatusQueryKey } from "../../api/systemQueries.ts";
import type { HoldPlaceInput } from "../../api/writes.ts";
import { initialPlaceForm, PLACE_HOLD, STOP_SCHEDULE } from "./usePlacement.ts";

const INPUT: HoldPlaceInput = {
  kind: "freeze",
  target: "f/factory/collect_github",
  minutes: 60,
  reason: "check the workers",
};

describe("initialPlaceForm", () => {
  test("starts a free placement as a merge hold of an hour, without a target", () => {
    expect(initialPlaceForm("any")).toEqual({
      kind: "merge",
      target: "",
      minutesText: "60",
      reason: "",
    });
  });

  test("starts the preparation of a stop as a freeze of the schedule", () => {
    expect(
      initialPlaceForm("stop_prepare", "f/factory/collect_github"),
    ).toEqual({
      kind: "freeze",
      target: "f/factory/collect_github",
      minutesText: "60",
      reason: "",
    });
  });
});

describe("PLACE_HOLD", () => {
  test("locks a placement under its kind and target", () => {
    expect(PLACE_HOLD.keyOf(INPUT)).toBe(
      "place:freeze:f/factory/collect_github",
    );
  });

  test("locks a deploy hold under its kind alone", () => {
    expect(PLACE_HOLD.keyOf({ ...INPUT, kind: "deploy", target: "" })).toBe(
      "place:deploy:",
    );
  });

  test("reads the holds and the status of the system again after a placement", () => {
    expect(PLACE_HOLD.invalidates).toEqual([
      holdsQueryKey,
      systemStatusQueryKey,
    ]);
  });
});

describe("STOP_SCHEDULE", () => {
  test("locks a stop under the schedule", () => {
    expect(STOP_SCHEDULE.keyOf("f/factory/collect_github")).toBe(
      "schedule-stop:f/factory/collect_github",
    );
  });

  test("reads the schedules and the holds again after a stop", () => {
    expect(STOP_SCHEDULE.invalidates).toEqual([
      schedulesQueryKey,
      holdsQueryKey,
    ]);
  });
});
