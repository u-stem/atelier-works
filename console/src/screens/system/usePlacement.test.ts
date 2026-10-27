import { describe, expect, test } from "bun:test";
import { holdsQueryKey } from "../../api/holdsQueries.ts";
import { schedulesQueryKey } from "../../api/jobsQueries.ts";
import { systemStatusQueryKey } from "../../api/systemQueries.ts";
import type { HoldPlaceInput } from "../../api/writes.ts";
import type { ScheduleFreeze } from "../../lib/holdPlace.ts";
import {
  beginPlacement,
  confirmPlacement,
  confirmRestore,
  confirmStop,
  editPlacement,
  initialPlaceForm,
  PLACE_HOLD,
  STOP_SCHEDULE,
} from "./usePlacement.ts";

const INPUT: HoldPlaceInput = {
  kind: "freeze",
  target: "f/factory/poll_prs",
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
    expect(initialPlaceForm("stop_prepare", "f/factory/poll_prs")).toEqual({
      kind: "freeze",
      target: "f/factory/poll_prs",
      minutesText: "60",
      reason: "",
    });
  });
});

describe("PLACE_HOLD", () => {
  test("locks a placement under its kind and target", () => {
    expect(PLACE_HOLD.keyOf(INPUT)).toBe("place:freeze:f/factory/poll_prs");
  });

  test("locks a placement under the lower-cased target, as the script places it", () => {
    expect(
      PLACE_HOLD.keyOf({
        kind: "merge",
        target: "Octo-Owner/Widgets",
        minutes: 60,
        reason: "r",
      }),
    ).toBe("place:merge:octo-owner/widgets");
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
    expect(STOP_SCHEDULE.keyOf("f/factory/poll_prs")).toBe(
      "schedule-stop:f/factory/poll_prs",
    );
  });

  test("reads the schedules and the holds again after a stop", () => {
    expect(STOP_SCHEDULE.invalidates).toEqual([
      schedulesQueryKey,
      holdsQueryKey,
    ]);
  });
});

describe("beginPlacement", () => {
  test("opens a free placement with the initial form and no input to send", () => {
    expect(beginPlacement("any")).toEqual({
      variant: "any",
      form: initialPlaceForm("any"),
    });
  });

  test("opens the preparation of a stop with the schedule fixed", () => {
    expect(beginPlacement("stop_prepare", "f/factory/poll_prs")).toEqual({
      variant: "stop_prepare",
      form: initialPlaceForm("stop_prepare", "f/factory/poll_prs"),
    });
  });
});

describe("editPlacement", () => {
  test("changes the form and keeps the variant", () => {
    const form = { ...initialPlaceForm("any"), reason: "r" };
    expect(editPlacement(beginPlacement("any"), form)).toEqual({
      variant: "any",
      form,
    });
  });

  test("does nothing when no dialog is open", () => {
    expect(editPlacement(null, initialPlaceForm("any"))).toBeNull();
  });
});

describe("confirmPlacement", () => {
  const VALID = {
    variant: "any",
    form: {
      kind: "merge",
      target: "octo-owner/widgets",
      minutesText: "60",
      reason: "check the workers",
    },
  } as const;

  function spy() {
    const calls: HoldPlaceInput[] = [];
    return {
      calls,
      submit: (input: HoldPlaceInput) => {
        calls.push(input);
        return true;
      },
    };
  }

  test("submits nothing when no dialog is open", () => {
    const s = spy();
    confirmPlacement(null, s.submit);
    expect(s.calls).toEqual([]);
  });

  test("submits nothing for the dialog that was only opened", () => {
    const s = spy();
    confirmPlacement(beginPlacement("any"), s.submit);
    expect(s.calls).toEqual([]);
  });

  test("keeps the dialog open when the input is not valid", () => {
    const s = spy();
    const dialog = {
      ...VALID,
      form: { ...VALID.form, reason: "" },
    } as const;
    expect(confirmPlacement(dialog, s.submit)).toBe(dialog);
  });

  test("submits nothing for an input that is not valid", () => {
    const s = spy();
    confirmPlacement(
      { ...VALID, form: { ...VALID.form, minutesText: "abc" } },
      s.submit,
    );
    expect(s.calls).toEqual([]);
  });

  test("submits nothing for a stop preparation that ends before the stop", () => {
    const s = spy();
    confirmPlacement(
      {
        variant: "stop_prepare",
        form: {
          kind: "freeze",
          target: "f/factory/poll_prs",
          minutesText: "11",
          reason: "r",
        },
      },
      s.submit,
    );
    expect(s.calls).toEqual([]);
  });

  test("submits the checked input once for a valid dialog", () => {
    const s = spy();
    confirmPlacement(VALID, s.submit);
    expect(s.calls).toEqual([
      {
        kind: "merge",
        target: "octo-owner/widgets",
        minutes: 60,
        reason: "check the workers",
      },
    ]);
  });

  test("closes the dialog after it submitted", () => {
    expect(confirmPlacement(VALID, spy().submit)).toBeNull();
  });
});

describe("confirmStop and confirmRestore", () => {
  const FREEZE: ScheduleFreeze = {
    id: "0a1b2c3d",
    createdAt: "2026-10-27T03:00:00.000Z",
    expiresAt: "2026-10-27T05:00:00.000Z",
  };
  const TARGET = { path: "f/factory/poll_prs", freeze: FREEZE };

  test("stops nothing when no schedule was chosen", () => {
    const calls: string[] = [];
    confirmStop(null, (path) => {
      calls.push(path);
      return true;
    });
    expect(calls).toEqual([]);
  });

  test("stops the chosen schedule once", () => {
    const calls: string[] = [];
    confirmStop(TARGET, (path) => {
      calls.push(path);
      return true;
    });
    expect(calls).toEqual(["f/factory/poll_prs"]);
  });

  test("closes the stop dialog after it submitted", () => {
    expect(confirmStop(TARGET, () => true)).toBeNull();
  });

  test("releases nothing when no schedule was chosen", () => {
    const calls: string[] = [];
    confirmRestore(null, (id) => {
      calls.push(id);
      return true;
    });
    expect(calls).toEqual([]);
  });

  test("releases the freeze of the chosen schedule once", () => {
    const calls: string[] = [];
    confirmRestore(TARGET, (id) => {
      calls.push(id);
      return true;
    });
    expect(calls).toEqual(["0a1b2c3d"]);
  });

  test("closes the restore dialog after it submitted", () => {
    expect(confirmRestore(TARGET, () => true)).toBeNull();
  });
});
