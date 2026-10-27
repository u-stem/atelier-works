import { describe, expect, test } from "bun:test";
import type { HoldsSnapshot } from "../api/guards/holds.ts";
import {
  checkPlaceForm,
  deployHoldActive,
  MAX_MINUTES,
  minutesRangeText,
  PLACE_KIND_LABELS,
  PLACE_KINDS,
  type PlaceForm,
  type PlaceProblem,
  placeEffectLines,
  placeProblemMessage,
  prepareDialogLines,
  REASON_MAX_LENGTH,
  restoreDialogLines,
  STOP_MIN_REMAINING_MINUTES,
  STOP_PREPARE_MIN_MINUTES,
  STOP_READY_AFTER_MINUTES,
  STOP_TARGETS,
  scheduleStopState,
  stopDialogLines,
  stopImpactNote,
  stopReadyAt,
} from "./holdPlace.ts";

const NOW = Date.parse("2026-10-27T03:30:00.000Z");
const SCHEDULE = "f/factory/poll_prs";

function form(overrides: Partial<PlaceForm> = {}): PlaceForm {
  return {
    kind: "merge",
    target: "octo-owner/widgets",
    minutesText: "60",
    reason: "check the workers",
    ...overrides,
  };
}

function problemOf(overrides: Partial<PlaceForm>): PlaceProblem | null {
  const checked = checkPlaceForm(form(overrides));
  return checked.ok ? null : checked.problem;
}

describe("the kinds and their limits", () => {
  test("offers merge, deploy and freeze, in this order", () => {
    expect([...PLACE_KINDS]).toEqual(["merge", "deploy", "freeze"]);
  });

  test("allows a merge hold up to a day", () => {
    expect(MAX_MINUTES.merge).toBe(1440);
  });

  test("allows a deploy hold up to 120 minutes", () => {
    expect(MAX_MINUTES.deploy).toBe(120);
  });

  test("allows a freeze up to a day", () => {
    expect(MAX_MINUTES.freeze).toBe(1440);
  });

  test("allows a reason of 200 characters", () => {
    expect(REASON_MAX_LENGTH).toBe(200);
  });

  test("names the three kinds", () => {
    expect(PLACE_KINDS.map((kind) => PLACE_KIND_LABELS[kind])).toEqual([
      "マージの保留",
      "deployの保留",
      "スケジュールの凍結",
    ]);
  });
});

describe("checkPlaceForm", () => {
  test("turns a merge hold into an input for the script", () => {
    expect(checkPlaceForm(form())).toEqual({
      ok: true,
      input: {
        kind: "merge",
        target: "octo-owner/widgets",
        minutes: 60,
        reason: "check the workers",
      },
    });
  });

  test("trims the target, the minutes and the reason", () => {
    expect(
      checkPlaceForm(
        form({
          target: "  octo-owner/widgets ",
          minutesText: " 60 ",
          reason: "  check  ",
        }),
      ),
    ).toEqual({
      ok: true,
      input: {
        kind: "merge",
        target: "octo-owner/widgets",
        minutes: 60,
        reason: "check",
      },
    });
  });

  test("sends no target for a deploy hold, whatever was typed", () => {
    const checked = checkPlaceForm(form({ kind: "deploy", target: "x/y" }));
    expect(checked.ok && checked.input.target).toBe("");
  });

  test("turns a freeze into an input for the script", () => {
    expect(checkPlaceForm(form({ kind: "freeze", target: SCHEDULE }))).toEqual({
      ok: true,
      input: {
        kind: "freeze",
        target: SCHEDULE,
        minutes: 60,
        reason: "check the workers",
      },
    });
  });

  test("says that the target of a merge hold is missing", () => {
    expect(problemOf({ target: "  " })).toBe("target_empty");
  });

  test.each(["not a repo", "a/b/c", "/b", "a/"])(
    "refuses %p as a repository",
    (target) => {
      expect(problemOf({ target })).toBe("target_invalid");
    },
  );

  test.each(["collect_github", "factory/collect_github", "f/Factory/x", "f/"])(
    "refuses %p as a schedule",
    (target) => {
      expect(problemOf({ kind: "freeze", target })).toBe("target_invalid");
    },
  );

  test("does not ask a deploy hold for a target", () => {
    expect(problemOf({ kind: "deploy", target: "" })).toBeNull();
  });

  test("says that the minutes are missing", () => {
    expect(problemOf({ minutesText: "" })).toBe("minutes_empty");
  });

  test.each(["abc", "1.5", "-5", "1e2", "６０", "0x10", "6 0"])(
    "refuses %p as minutes",
    (minutesText) => {
      expect(problemOf({ minutesText })).toBe("minutes_not_integer");
    },
  );

  test("refuses zero minutes", () => {
    expect(problemOf({ minutesText: "0" })).toBe("minutes_too_small");
  });

  test("accepts one minute", () => {
    expect(problemOf({ minutesText: "1" })).toBeNull();
  });

  test("accepts a merge hold of exactly a day", () => {
    expect(problemOf({ minutesText: "1440" })).toBeNull();
  });

  test("refuses a merge hold longer than a day", () => {
    expect(problemOf({ minutesText: "1441" })).toBe("minutes_too_large");
  });

  test("accepts a deploy hold of exactly 120 minutes", () => {
    expect(problemOf({ kind: "deploy", minutesText: "120" })).toBeNull();
  });

  test("refuses a deploy hold longer than 120 minutes", () => {
    expect(problemOf({ kind: "deploy", minutesText: "121" })).toBe(
      "minutes_too_large",
    );
  });

  test("refuses a freeze longer than a day", () => {
    expect(
      problemOf({ kind: "freeze", target: SCHEDULE, minutesText: "1441" }),
    ).toBe("minutes_too_large");
  });

  test.each(["", "   "])("refuses the reason %p as missing", (reason) => {
    expect(problemOf({ reason })).toBe("reason_empty");
  });

  test("accepts a reason of exactly 200 characters", () => {
    expect(problemOf({ reason: "あ".repeat(200) })).toBeNull();
  });

  test("refuses a reason of 201 characters", () => {
    expect(problemOf({ reason: "あ".repeat(201) })).toBe("reason_too_long");
  });

  test("counts the length in UTF-16 units, as the script does", () => {
    expect(problemOf({ reason: "𠮷".repeat(101) })).toBe("reason_too_long");
  });

  test("accepts a reason of 200 UTF-16 units made of 100 characters outside the basic plane", () => {
    expect(problemOf({ reason: "𠮷".repeat(100) })).toBeNull();
  });

  test.each(["a\nb", "a\u0007b", "a‮b", "a b"])(
    "refuses the reason %p for its control character",
    (reason) => {
      expect(problemOf({ reason })).toBe("reason_has_control");
    },
  );

  test("reports the target before the minutes and the minutes before the reason", () => {
    expect(problemOf({ target: "", minutesText: "", reason: "" })).toBe(
      "target_empty",
    );
  });
});

describe("placeProblemMessage", () => {
  const PROBLEMS: readonly PlaceProblem[] = [
    "target_empty",
    "target_invalid",
    "minutes_empty",
    "minutes_not_integer",
    "minutes_too_small",
    "minutes_too_large",
    "reason_empty",
    "reason_too_long",
    "reason_has_control",
  ];

  test.each([...PROBLEMS])("explains %s in Japanese", (problem) => {
    expect(placeProblemMessage(problem, "merge")).toMatch(/[ぁ-んァ-ヶ一-龠]/);
  });

  test.each(["minutes_too_small", "minutes_too_large"] as const)(
    "does not repeat the range, which the box already shows, in %s",
    (problem) => {
      expect(placeProblemMessage(problem, "deploy")).not.toMatch(/[0-9]/);
    },
  );

  test("shows the form of a repository", () => {
    expect(placeProblemMessage("target_invalid", "merge")).toContain(
      "owner/repo",
    );
  });

  test("shows the form of a schedule", () => {
    expect(placeProblemMessage("target_invalid", "freeze")).toContain(
      "f/factory/",
    );
  });
});

describe("placeEffectLines", () => {
  test("says that a merge hold stops merges", () => {
    expect(placeEffectLines("merge").join("")).toContain("マージ");
  });

  test("says that a deploy hold waits for the whole deployment", () => {
    expect(placeEffectLines("deploy").join("")).toContain("反映全体");
  });

  test("tells how long a deployment that began earlier may last", () => {
    expect(placeEffectLines("deploy").join("")).toContain("13分");
  });

  test("says that a freeze does not stop the schedule", () => {
    expect(placeEffectLines("freeze").join("")).toContain(
      "スケジュールそのものは止まりません",
    );
  });

  test.each(["merge", "deploy", "freeze"] as const)(
    "tells how to release a %s",
    (kind) => {
      expect(placeEffectLines(kind).join("")).toContain("解除");
    },
  );

  test.each(["merge", "deploy", "freeze"] as const)(
    "says that a %s ends at its time limit",
    (kind) => {
      expect(placeEffectLines(kind).join("")).toContain("期限");
    },
  );
});

describe("the schedules that can be stopped", () => {
  test("are the seven that the script lists", () => {
    expect([...STOP_TARGETS].sort()).toEqual([
      "f/factory/auto_retry_pr_review",
      "f/factory/drawio_viewer_bump",
      "f/factory/notify_daily_summary",
      "f/factory/poll_prs",
      "f/factory/watch_main_ci",
      "f/factory/watch_pr_ci",
      "f/factory/watch_pr_conflicts",
    ]);
  });

  test.each([...STOP_TARGETS])(
    "%s has a note on what stopping it costs",
    (path) => {
      expect(stopImpactNote(path)?.length).toBeGreaterThan(0);
    },
  );

  test("tells that stopping a watch silences its notice", () => {
    expect(stopImpactNote("f/factory/watch_main_ci")).toContain("通知");
  });

  test("has no note for the collection, which feeds other schedules", () => {
    expect(stopImpactNote("f/factory/collect_github")).toBeNull();
  });

  test("has no note for a schedule that cannot be stopped", () => {
    expect(stopImpactNote("f/factory/self_update")).toBeNull();
  });

  test("has no note for a name from the prototype chain", () => {
    expect(stopImpactNote("constructor")).toBeNull();
  });
});

describe("the margin before the freeze ends", () => {
  test("is five minutes, as the script requires", () => {
    expect(STOP_MIN_REMAINING_MINUTES).toBe(5);
  });

  test("makes the shortest freeze to prepare a stop the wait plus the margin", () => {
    expect(STOP_PREPARE_MIN_MINUTES).toBe(
      STOP_READY_AFTER_MINUTES + STOP_MIN_REMAINING_MINUTES,
    );
  });
});

describe("checkPlaceForm for the preparation of a stop", () => {
  function prepared(minutesText: string) {
    return checkPlaceForm(
      form({ kind: "freeze", target: SCHEDULE, minutesText }),
      "stop_prepare",
    );
  }

  test("refuses minutes that end the freeze before it could be used", () => {
    expect(prepared("11")).toEqual({ ok: false, problem: "minutes_too_small" });
  });

  test("accepts the wait plus the margin", () => {
    expect(prepared("12").ok).toBe(true);
  });

  test("keeps one minute for a free placement", () => {
    expect(
      checkPlaceForm(
        form({ kind: "freeze", target: SCHEDULE, minutesText: "1" }),
        "any",
      ).ok,
    ).toBe(true);
  });

  test("shows the range of a free placement of a deploy hold", () => {
    expect(minutesRangeText("deploy", "any")).toBe("1分から120分まで");
  });

  test("shows the range of a free placement of a freeze", () => {
    expect(minutesRangeText("freeze", "any")).toBe("1分から1440分まで");
  });

  test("shows the shortest freeze of the preparation as the least minutes", () => {
    expect(minutesRangeText("freeze", "stop_prepare")).toBe(
      `${String(STOP_PREPARE_MIN_MINUTES)}分から1440分まで`,
    );
  });
});

describe("stopReadyAt", () => {
  test("waits seven minutes after the freeze, as the script does", () => {
    expect(STOP_READY_AFTER_MINUTES).toBe(7);
  });

  test("adds the wait to the time of the freeze", () => {
    expect(stopReadyAt("2026-10-27T03:00:00.000Z")).toBe(
      Date.parse("2026-10-27T03:07:00.000Z"),
    );
  });
});

function holds(
  freezes: readonly {
    id?: string;
    target?: string;
    holder_kind?: string;
    created_at?: string;
    expires_at?: string;
  }[],
): HoldsSnapshot {
  return {
    holds: { ok: true, rows: [] },
    freezes: {
      ok: true,
      schedule: freezes.map((row) => ({
        id: row.id ?? "0a1b2c3d",
        target: row.target ?? SCHEDULE,
        reason: "r",
        holder_kind: row.holder_kind ?? "human",
        holder: row.holder_kind === "session" ? "session:b" : "human",
        created_at: row.created_at ?? "2026-10-27T03:00:00.000Z",
        expires_at: row.expires_at ?? "2026-10-27T05:00:00.000Z",
      })),
      deploy: [],
    },
  };
}

describe("scheduleStopState", () => {
  test("offers nothing for a schedule that cannot be stopped", () => {
    expect(
      scheduleStopState("f/factory/self_update", true, holds([]), NOW),
    ).toEqual({ kind: "none" });
  });

  test("offers nothing for a schedule that is already disabled and not frozen", () => {
    expect(scheduleStopState(SCHEDULE, false, holds([]), NOW)).toEqual({
      kind: "none",
    });
  });

  test("offers the restore for a disabled schedule under a freeze of the human", () => {
    expect(scheduleStopState(SCHEDULE, false, holds([{}]), NOW)).toEqual({
      kind: "stopped",
      freeze: {
        id: "0a1b2c3d",
        createdAt: "2026-10-27T03:00:00.000Z",
        expiresAt: "2026-10-27T05:00:00.000Z",
      },
    });
  });

  test("offers nothing for a disabled schedule under a freeze of a session", () => {
    expect(
      scheduleStopState(
        SCHEDULE,
        false,
        holds([{ holder_kind: "session" }]),
        NOW,
      ),
    ).toEqual({ kind: "none" });
  });

  test("offers nothing when the freeze cannot last until the stop plus the margin", () => {
    expect(
      scheduleStopState(
        SCHEDULE,
        true,
        holds([
          {
            created_at: "2026-10-27T03:25:00.000Z",
            expires_at: "2026-10-27T03:36:59.000Z",
          },
        ]),
        NOW,
      ),
    ).toEqual({ kind: "none" });
  });

  test("waits when the freeze lasts exactly the margin after the wait", () => {
    expect(
      scheduleStopState(
        SCHEDULE,
        true,
        holds([
          {
            created_at: "2026-10-27T03:25:00.000Z",
            expires_at: "2026-10-27T03:37:00.000Z",
          },
        ]),
        NOW,
      ).kind,
    ).toBe("waiting");
  });

  test("offers nothing once less than the margin of the freeze is left", () => {
    expect(
      scheduleStopState(
        SCHEDULE,
        true,
        holds([{ expires_at: "2026-10-27T03:34:59.000Z" }]),
        NOW,
      ),
    ).toEqual({ kind: "none" });
  });

  test("is ready while exactly the margin of the freeze is left", () => {
    expect(
      scheduleStopState(
        SCHEDULE,
        true,
        holds([{ expires_at: "2026-10-27T03:35:00.000Z" }]),
        NOW,
      ).kind,
    ).toBe("ready");
  });

  test("offers nothing while the freezes are not known", () => {
    expect(scheduleStopState(SCHEDULE, true, undefined, NOW)).toEqual({
      kind: "none",
    });
  });

  test("offers nothing when the freezes could not be read", () => {
    const unreadable: HoldsSnapshot = {
      holds: { ok: true, rows: [] },
      freezes: { ok: false, reason: "broken" },
    };
    expect(scheduleStopState(SCHEDULE, true, unreadable, NOW)).toEqual({
      kind: "none",
    });
  });

  test("offers the preparation for a schedule without a freeze", () => {
    expect(scheduleStopState(SCHEDULE, true, holds([]), NOW)).toEqual({
      kind: "prepare",
    });
  });

  test("offers the preparation when the freeze is for another schedule", () => {
    expect(
      scheduleStopState(
        SCHEDULE,
        true,
        holds([{ target: "f/factory/watch_pr_ci" }]),
        NOW,
      ),
    ).toEqual({ kind: "prepare" });
  });

  test("offers the preparation when the freeze has ended", () => {
    expect(
      scheduleStopState(
        SCHEDULE,
        true,
        holds([{ expires_at: "2026-10-27T03:29:00.000Z" }]),
        NOW,
      ),
    ).toEqual({ kind: "prepare" });
  });

  test("waits until seven minutes after the freeze", () => {
    expect(
      scheduleStopState(
        SCHEDULE,
        true,
        holds([{ created_at: "2026-10-27T03:25:00.000Z" }]),
        NOW,
      ),
    ).toEqual({
      kind: "waiting",
      readyAt: Date.parse("2026-10-27T03:32:00.000Z"),
      freeze: {
        id: "0a1b2c3d",
        createdAt: "2026-10-27T03:25:00.000Z",
        expiresAt: "2026-10-27T05:00:00.000Z",
      },
    });
  });

  test("is ready exactly seven minutes after the freeze", () => {
    expect(
      scheduleStopState(
        SCHEDULE,
        true,
        holds([{ created_at: "2026-10-27T03:23:00.000Z" }]),
        NOW,
      ).kind,
    ).toBe("ready");
  });

  test("is ready long after the freeze, with the freeze to stop under", () => {
    expect(scheduleStopState(SCHEDULE, true, holds([{}]), NOW)).toEqual({
      kind: "ready",
      freeze: {
        id: "0a1b2c3d",
        createdAt: "2026-10-27T03:00:00.000Z",
        expiresAt: "2026-10-27T05:00:00.000Z",
      },
    });
  });

  test("offers nothing when a session placed the freeze", () => {
    expect(
      scheduleStopState(
        SCHEDULE,
        true,
        holds([{ holder_kind: "session" }]),
        NOW,
      ),
    ).toEqual({ kind: "none" });
  });
});

describe("deployHoldActive", () => {
  function withDeploy(expiresAt: string): HoldsSnapshot {
    return {
      holds: { ok: true, rows: [] },
      freezes: {
        ok: true,
        schedule: [],
        deploy: [
          {
            id: "0a1b2c3d",
            reason: "r",
            holder_kind: "human",
            holder: "human",
            created_at: "2026-10-27T03:00:00.000Z",
            expires_at: expiresAt,
          },
        ],
      },
    };
  }

  test("is true while a deploy hold is in force", () => {
    expect(deployHoldActive(withDeploy("2026-10-27T04:00:00.000Z"), NOW)).toBe(
      true,
    );
  });

  test("is false once the deploy hold has ended", () => {
    expect(deployHoldActive(withDeploy("2026-10-27T03:29:00.000Z"), NOW)).toBe(
      false,
    );
  });

  test("is false when the holds are not known", () => {
    expect(deployHoldActive(undefined, NOW)).toBe(false);
  });

  test("is false when the freezes could not be read", () => {
    expect(
      deployHoldActive(
        { holds: { ok: true, rows: [] }, freezes: { ok: false, reason: "x" } },
        NOW,
      ),
    ).toBe(false);
  });
});

describe("the dialog lines of the stop", () => {
  test("prepare: says that the stop can be pressed after the wait", () => {
    expect(prepareDialogLines(SCHEDULE).join("")).toContain("7分");
  });

  test("prepare: says that nothing stops yet", () => {
    expect(prepareDialogLines(SCHEDULE).join("")).toContain("まだ止まりません");
  });

  test("prepare: carries the cost of stopping the schedule", () => {
    expect(prepareDialogLines(SCHEDULE).join("")).toContain(
      stopImpactNote(SCHEDULE) ?? "",
    );
  });

  test("prepare: tells how the freeze ends", () => {
    expect(prepareDialogLines(SCHEDULE).join("")).toContain("解除");
  });

  test("stop: carries the cost of stopping the schedule", () => {
    expect(
      stopDialogLines(SCHEDULE, "2026-10-27T05:00:00.000Z").join(""),
    ).toContain(stopImpactNote(SCHEDULE) ?? "");
  });

  test("stop: tells when the schedule comes back", () => {
    expect(
      stopDialogLines(SCHEDULE, "2026-10-27T05:00:00.000Z").join(""),
    ).toContain("10/27 14:00");
  });

  test("stop: says that the Console does not turn it back on", () => {
    expect(
      stopDialogLines(SCHEDULE, "2026-10-27T05:00:00.000Z").join(""),
    ).toContain("Consoleからは有効に戻せません");
  });

  test("stop: says that a deploy hold keeps the schedule off even after the freeze ends", () => {
    expect(
      stopDialogLines(SCHEDULE, "2026-10-27T05:00:00.000Z", true).join(""),
    ).toContain("deployの保留");
  });

  test("stop: says nothing of a deploy hold when there is none", () => {
    expect(
      stopDialogLines(SCHEDULE, "2026-10-27T05:00:00.000Z", false).join(""),
    ).not.toContain("deployの保留");
  });

  test("prepare: shows the wait only in one line", () => {
    expect(
      prepareDialogLines(SCHEDULE).filter((line) => line.includes("7分")),
    ).toHaveLength(1);
  });

  test("restore: tells that the schedule returns to the definition", () => {
    expect(restoreDialogLines(false).join("")).toContain("リポジトリの定義");
  });

  test("restore: says that a deploy hold keeps it off", () => {
    expect(restoreDialogLines(true).join("")).toContain("deployの保留");
  });

  test("restore: says nothing of a deploy hold when there is none", () => {
    expect(restoreDialogLines(false).join("")).not.toContain("deployの保留");
  });

  test("stop: tells that releasing the freeze brings it back", () => {
    expect(
      stopDialogLines(SCHEDULE, "2026-10-27T05:00:00.000Z").join(""),
    ).toContain("凍結を解除");
  });
});
