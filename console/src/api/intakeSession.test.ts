import { describe, expect, test } from "bun:test";
import type { IntakeAttempt } from "../lib/intakeAttempt.ts";
import type { IntakeForm } from "../lib/manualIntake.ts";
import {
  createIntakeSessions,
  intakeSessions,
  startIntake,
} from "./intakeSession.ts";
import { MANUAL_INTAKE_WRITE_KEY } from "./writeLocks.ts";

const KEY = MANUAL_INTAKE_WRITE_KEY;

const FORM: IntakeForm = {
  repo: "octo-owner/widgets",
  title: "Add a widget",
  body: "Add a widget to the page.",
  acceptanceCriteria: "It renders.",
};

const UNKNOWN: IntakeAttempt = {
  kind: "unknown",
  message: "分かりません",
  resendConfirmed: false,
};
const SUBMITTED: IntakeAttempt = { kind: "submitted", flowJobId: "job" };
const REFUSED: IntakeAttempt = { kind: "refused", message: "断りました" };

describe("an empty session", () => {
  test("has not tried anything", () => {
    expect(createIntakeSessions().get(KEY).attempt).toEqual({ kind: "idle" });
  });

  test("has no saved input", () => {
    expect(createIntakeSessions().get(KEY).form).toBeNull();
  });

  test("blocks nothing", () => {
    expect(createIntakeSessions().isBlocked(KEY)).toBe(false);
  });
});

describe("a result that is not known", () => {
  test("blocks the next submission", () => {
    const sessions = createIntakeSessions();
    sessions.record(KEY, UNKNOWN);
    expect(sessions.isBlocked(KEY)).toBe(true);
  });

  test("still blocks after the screen left and came back", () => {
    const sessions = createIntakeSessions();
    sessions.begin(KEY, FORM);
    const leave = sessions.subscribe(() => undefined);
    sessions.record(KEY, UNKNOWN);
    leave();
    expect(sessions.isBlocked(KEY)).toBe(true);
  });

  test("keeps the input for the screen that comes back", () => {
    const sessions = createIntakeSessions();
    sessions.begin(KEY, FORM);
    sessions.record(KEY, UNKNOWN);
    expect(sessions.get(KEY).form).toEqual(FORM);
  });

  test("keeps the warning for the screen that comes back", () => {
    const sessions = createIntakeSessions();
    sessions.begin(KEY, FORM);
    sessions.record(KEY, UNKNOWN);
    expect(sessions.get(KEY).attempt).toEqual(UNKNOWN);
  });

  test("opens the submission once the user confirmed the resend", () => {
    const sessions = createIntakeSessions();
    sessions.record(KEY, UNKNOWN);
    sessions.confirmResend(KEY);
    expect(sessions.isBlocked(KEY)).toBe(false);
  });

  test("keeps the input after the resend is confirmed", () => {
    const sessions = createIntakeSessions();
    sessions.begin(KEY, FORM);
    sessions.record(KEY, UNKNOWN);
    sessions.confirmResend(KEY);
    expect(sessions.get(KEY).form).toEqual(FORM);
  });

  test("does not confirm anything when the result was known", () => {
    const sessions = createIntakeSessions();
    sessions.record(KEY, REFUSED);
    sessions.confirmResend(KEY);
    expect(sessions.get(KEY).attempt).toEqual(REFUSED);
  });
});

describe("a refusal", () => {
  test("keeps the input", () => {
    const sessions = createIntakeSessions();
    sessions.begin(KEY, FORM);
    sessions.record(KEY, REFUSED);
    expect(sessions.get(KEY).form).toEqual(FORM);
  });

  test("blocks nothing", () => {
    const sessions = createIntakeSessions();
    sessions.record(KEY, REFUSED);
    expect(sessions.isBlocked(KEY)).toBe(false);
  });
});

describe("a submission", () => {
  test("clears the saved input", () => {
    const sessions = createIntakeSessions();
    sessions.begin(KEY, FORM);
    sessions.record(KEY, SUBMITTED);
    expect(sessions.get(KEY).form).toBeNull();
  });

  test("clears the block after a confirmed resend succeeded", () => {
    const sessions = createIntakeSessions();
    sessions.begin(KEY, FORM);
    sessions.record(KEY, UNKNOWN);
    sessions.confirmResend(KEY);
    sessions.begin(KEY, FORM);
    sessions.record(KEY, SUBMITTED);
    expect(sessions.isBlocked(KEY)).toBe(false);
  });

  test("counts the submissions so that a mounted screen can empty its fields", () => {
    const sessions = createIntakeSessions();
    sessions.record(KEY, SUBMITTED);
    sessions.record(KEY, SUBMITTED);
    expect(sessions.get(KEY).submittedCount).toBe(2);
  });

  test("does not count a refusal as a submission", () => {
    const sessions = createIntakeSessions();
    sessions.record(KEY, REFUSED);
    expect(sessions.get(KEY).submittedCount).toBe(0);
  });
});

describe("begin", () => {
  test("saves the input", () => {
    const sessions = createIntakeSessions();
    sessions.begin(KEY, FORM);
    expect(sessions.get(KEY).form).toEqual(FORM);
  });

  test("clears the previous result", () => {
    const sessions = createIntakeSessions();
    sessions.record(KEY, REFUSED);
    sessions.begin(KEY, FORM);
    expect(sessions.get(KEY).attempt).toEqual({ kind: "idle" });
  });

  test("clears the note that the list could not be read", () => {
    const sessions = createIntakeSessions();
    sessions.markStale(KEY);
    sessions.begin(KEY, FORM);
    expect(sessions.get(KEY).stale).toBe(false);
  });
});

describe("markStale", () => {
  test("remembers that the list could not be read", () => {
    const sessions = createIntakeSessions();
    sessions.markStale(KEY);
    expect(sessions.get(KEY).stale).toBe(true);
  });
});

describe("subscribe", () => {
  test("tells the listener about a change", () => {
    const sessions = createIntakeSessions();
    let calls = 0;
    sessions.subscribe(() => {
      calls += 1;
    });
    sessions.record(KEY, REFUSED);
    expect(calls).toBe(1);
  });

  test("stops telling a listener that left", () => {
    const sessions = createIntakeSessions();
    let calls = 0;
    const leave = sessions.subscribe(() => {
      calls += 1;
    });
    leave();
    sessions.record(KEY, REFUSED);
    expect(calls).toBe(0);
  });

  test("gives a new snapshot after a change", () => {
    const sessions = createIntakeSessions();
    const before = sessions.getSnapshot();
    sessions.record(KEY, REFUSED);
    expect(sessions.getSnapshot()).not.toBe(before);
  });

  test("gives the same snapshot while nothing changes", () => {
    const sessions = createIntakeSessions();
    expect(sessions.getSnapshot()).toBe(sessions.getSnapshot());
  });
});

describe("startIntake", () => {
  test("does not start while the result is not known", () => {
    const sessions = createIntakeSessions();
    sessions.record(KEY, UNKNOWN);
    let started = 0;
    startIntake(sessions, KEY, FORM, () => {
      started += 1;
      return true;
    });
    expect(started).toBe(0);
  });

  test("returns false while the result is not known", () => {
    const sessions = createIntakeSessions();
    sessions.record(KEY, UNKNOWN);
    expect(startIntake(sessions, KEY, FORM, () => true)).toBe(false);
  });

  test("keeps the warning when it does not start", () => {
    const sessions = createIntakeSessions();
    sessions.record(KEY, UNKNOWN);
    startIntake(sessions, KEY, FORM, () => true);
    expect(sessions.get(KEY).attempt).toEqual(UNKNOWN);
  });

  test("starts once the resend is confirmed", () => {
    const sessions = createIntakeSessions();
    sessions.record(KEY, UNKNOWN);
    sessions.confirmResend(KEY);
    expect(startIntake(sessions, KEY, FORM, () => true)).toBe(true);
  });

  test("saves the input when it starts", () => {
    const sessions = createIntakeSessions();
    startIntake(sessions, KEY, FORM, () => true);
    expect(sessions.get(KEY).form).toEqual(FORM);
  });

  test("changes nothing when the write does not start", () => {
    const sessions = createIntakeSessions();
    sessions.record(KEY, REFUSED);
    startIntake(sessions, KEY, FORM, () => false);
    expect(sessions.get(KEY).attempt).toEqual(REFUSED);
  });

  test("returns false when the write does not start", () => {
    const sessions = createIntakeSessions();
    expect(startIntake(sessions, KEY, FORM, () => false)).toBe(false);
  });
});

describe("the shared sessions", () => {
  test("are one object for the whole tab", () => {
    expect(intakeSessions.get(KEY)).toBe(intakeSessions.get(KEY));
  });
});
