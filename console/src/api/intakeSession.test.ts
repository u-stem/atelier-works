import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type IntakeAttempt, isSubmitBlocked } from "../lib/intakeAttempt.ts";
import type { IntakeForm } from "../lib/manualIntake.ts";
import {
  createIntakeSessions,
  createLeaveGuard,
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

  test("still blocks a screen that comes back after the result arrived while it was away", () => {
    const sessions = createIntakeSessions();
    const leave = sessions.subscribe(() => undefined);
    sessions.begin(KEY, FORM);
    leave();
    sessions.dismiss(KEY);
    sessions.record(KEY, UNKNOWN);
    const seenByTheNewScreen = sessions.get(KEY);
    expect(isSubmitBlocked(seenByTheNewScreen.attempt)).toBe(true);
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
    expect(sessions.get(KEY).clearedCount).toBe(2);
  });

  test("does not count a refusal as a submission", () => {
    const sessions = createIntakeSessions();
    sessions.record(KEY, REFUSED);
    expect(sessions.get(KEY).clearedCount).toBe(0);
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

describe("dismiss", () => {
  /** 画面が結果を描画した、という記録を付ける。 */
  function show(sessions: ReturnType<typeof createIntakeSessions>) {
    sessions.markShown(KEY, sessions.get(KEY).resultId);
  }

  test.each([
    ["a submission", SUBMITTED],
    ["a refusal", REFUSED],
    ["a rejection", { kind: "rejected", message: "断られました" } as const],
  ])("clears %s the screen has shown", (_name, attempt) => {
    const sessions = createIntakeSessions();
    sessions.record(KEY, attempt);
    show(sessions);
    sessions.dismiss(KEY);
    expect(sessions.get(KEY).attempt).toEqual({ kind: "idle" });
  });

  test.each([
    ["a submission", SUBMITTED],
    ["a refusal", REFUSED],
    ["a rejection", { kind: "rejected", message: "断られました" } as const],
  ])("keeps %s the screen has not shown", (_name, attempt) => {
    const sessions = createIntakeSessions();
    sessions.record(KEY, attempt);
    sessions.dismiss(KEY);
    expect(sessions.get(KEY).attempt).toEqual(attempt);
  });

  test("keeps a newer result when only an older one was shown", () => {
    const sessions = createIntakeSessions();
    sessions.record(KEY, REFUSED);
    show(sessions);
    sessions.record(KEY, SUBMITTED);
    sessions.dismiss(KEY);
    expect(sessions.get(KEY).attempt).toEqual(SUBMITTED);
  });

  test("does not mark a result that is no longer the current one as shown", () => {
    const sessions = createIntakeSessions();
    sessions.record(KEY, REFUSED);
    const old = sessions.get(KEY).resultId;
    sessions.record(KEY, SUBMITTED);
    sessions.markShown(KEY, old);
    sessions.dismiss(KEY);
    expect(sessions.get(KEY).attempt).toEqual(SUBMITTED);
  });

  test("keeps a result that is not known even when it was shown", () => {
    const sessions = createIntakeSessions();
    sessions.record(KEY, UNKNOWN);
    show(sessions);
    sessions.dismiss(KEY);
    expect(sessions.get(KEY).attempt).toEqual(UNKNOWN);
  });

  test("keeps the input of a send in progress", () => {
    const sessions = createIntakeSessions();
    sessions.begin(KEY, FORM);
    sessions.dismiss(KEY);
    expect(sessions.get(KEY).form).toEqual(FORM);
  });

  test("keeps the input of a refusal that was shown", () => {
    const sessions = createIntakeSessions();
    sessions.begin(KEY, FORM);
    sessions.record(KEY, REFUSED);
    show(sessions);
    sessions.dismiss(KEY);
    expect(sessions.get(KEY).form).toEqual(FORM);
  });

  test("does not clear a result that was written after the screen left", () => {
    const sessions = createIntakeSessions();
    sessions.dismiss(KEY);
    sessions.record(KEY, SUBMITTED);
    expect(sessions.get(KEY).attempt).toEqual(SUBMITTED);
  });
});

describe("discard", () => {
  test("forgets the warning", () => {
    const sessions = createIntakeSessions();
    sessions.record(KEY, UNKNOWN);
    sessions.discard(KEY);
    expect(sessions.get(KEY).attempt).toEqual({ kind: "idle" });
  });

  test("forgets the saved input", () => {
    const sessions = createIntakeSessions();
    sessions.begin(KEY, FORM);
    sessions.record(KEY, UNKNOWN);
    sessions.discard(KEY);
    expect(sessions.get(KEY).form).toBeNull();
  });

  test("opens the submission again", () => {
    const sessions = createIntakeSessions();
    sessions.record(KEY, UNKNOWN);
    sessions.discard(KEY);
    expect(sessions.isBlocked(KEY)).toBe(false);
  });

  test("tells a mounted screen to empty its fields", () => {
    const sessions = createIntakeSessions();
    sessions.record(KEY, UNKNOWN);
    sessions.discard(KEY);
    expect(sessions.get(KEY).clearedCount).toBe(1);
  });

  test("does nothing when the result was known", () => {
    const sessions = createIntakeSessions();
    sessions.begin(KEY, FORM);
    sessions.record(KEY, REFUSED);
    sessions.discard(KEY);
    expect(sessions.get(KEY).form).toEqual(FORM);
  });
});

describe("createLeaveGuard", () => {
  /** 遅らせた処理を、手で実行できるようにためる。 */
  function manualDefer() {
    const pending: (() => void)[] = [];
    return {
      defer: (run: () => void) => {
        pending.push(run);
        return () => {
          const at = pending.indexOf(run);
          if (at >= 0) pending.splice(at, 1);
        };
      },
      flush: () => {
        for (const run of pending.splice(0)) run();
      },
    };
  }

  function show(sessions: ReturnType<typeof createIntakeSessions>) {
    sessions.markShown(KEY, sessions.get(KEY).resultId);
  }

  test("clears the result the screen showed when it left", () => {
    const sessions = createIntakeSessions();
    const { defer, flush } = manualDefer();
    const guard = createLeaveGuard(sessions, KEY, defer);
    guard.enter();
    sessions.record(KEY, SUBMITTED);
    show(sessions);
    guard.leave();
    flush();
    expect(sessions.get(KEY).attempt).toEqual({ kind: "idle" });
  });

  test("keeps a result that arrives after the screen left during a send", () => {
    const sessions = createIntakeSessions();
    const { defer, flush } = manualDefer();
    const guard = createLeaveGuard(sessions, KEY, defer);
    guard.enter();
    sessions.begin(KEY, FORM);
    guard.leave();
    sessions.record(KEY, SUBMITTED);
    flush();
    expect(sessions.get(KEY).attempt).toEqual(SUBMITTED);
  });

  test("shows a result that arrived after the screen left to the screen that comes back", () => {
    const sessions = createIntakeSessions();
    const { defer, flush } = manualDefer();
    const guard = createLeaveGuard(sessions, KEY, defer);
    guard.enter();
    sessions.begin(KEY, FORM);
    guard.leave();
    sessions.record(KEY, SUBMITTED);
    flush();
    guard.enter();
    expect(sessions.get(KEY).attempt.kind).toBe("submitted");
  });

  test("keeps the result while the write still holds the lock", () => {
    const sessions = createIntakeSessions();
    const { defer, flush } = manualDefer();
    const guard = createLeaveGuard(sessions, KEY, defer, () => false);
    guard.enter();
    sessions.record(KEY, SUBMITTED);
    show(sessions);
    guard.leave();
    flush();
    expect(sessions.get(KEY).attempt).toEqual(SUBMITTED);
  });

  test("clears the result that was shown once the lock is released", () => {
    const sessions = createIntakeSessions();
    const { defer, flush } = manualDefer();
    let canDismiss = false;
    const guard = createLeaveGuard(sessions, KEY, defer, () => canDismiss);
    guard.enter();
    sessions.record(KEY, SUBMITTED);
    show(sessions);
    guard.leave();
    flush();
    guard.enter();
    canDismiss = true;
    guard.leave();
    flush();
    expect(sessions.get(KEY).attempt).toEqual({ kind: "idle" });
  });

  test("keeps the result when the screen came straight back, as a development remount does", () => {
    const sessions = createIntakeSessions();
    const { defer, flush } = manualDefer();
    const guard = createLeaveGuard(sessions, KEY, defer);
    guard.enter();
    sessions.record(KEY, SUBMITTED);
    show(sessions);
    guard.leave();
    guard.enter();
    flush();
    expect(sessions.get(KEY).attempt).toEqual(SUBMITTED);
  });

  test("keeps a result that is not known when the screen left", () => {
    const sessions = createIntakeSessions();
    const { defer, flush } = manualDefer();
    const guard = createLeaveGuard(sessions, KEY, defer);
    guard.enter();
    sessions.record(KEY, UNKNOWN);
    show(sessions);
    guard.leave();
    flush();
    expect(sessions.get(KEY).attempt).toEqual(UNKNOWN);
  });
});

describe("a draft typed before sending", () => {
  const DRAFT: IntakeForm = { ...FORM, title: "Half typed" };

  test("is kept for a screen that comes back", () => {
    const sessions = createIntakeSessions();
    sessions.draft(KEY, DRAFT);
    expect(sessions.get(KEY).form).toEqual(DRAFT);
  });

  test("leaves the result of the last attempt as it was", () => {
    const sessions = createIntakeSessions();
    sessions.begin(KEY, FORM);
    sessions.record(KEY, REFUSED);
    sessions.draft(KEY, DRAFT);
    expect(sessions.get(KEY).attempt).toEqual(REFUSED);
  });

  test("keeps the count of cleared inputs, which only a send or a discard changes", () => {
    const sessions = createIntakeSessions();
    sessions.draft(KEY, DRAFT);
    expect(sessions.get(KEY).clearedCount).toBe(0);
  });

  test("does not replace the sent input of an attempt that may have gone through", () => {
    const sessions = createIntakeSessions();
    sessions.begin(KEY, FORM);
    sessions.record(KEY, UNKNOWN);
    sessions.draft(KEY, DRAFT);
    expect(sessions.get(KEY).form).toEqual(FORM);
  });

  test("is kept after an input was sent and cleared", () => {
    const sessions = createIntakeSessions();
    sessions.begin(KEY, FORM);
    sessions.record(KEY, SUBMITTED);
    sessions.draft(KEY, DRAFT);
    expect(sessions.get(KEY).form).toEqual(DRAFT);
  });

  test("tells the subscribers once for the same draft typed twice", () => {
    const sessions = createIntakeSessions();
    let calls = 0;
    sessions.subscribe(() => {
      calls += 1;
    });
    sessions.draft(KEY, DRAFT);
    sessions.draft(KEY, { ...DRAFT });
    expect(calls).toBe(1);
  });
});

describe("the intake key", () => {
  const OTHER_FORM: IntakeForm = { ...FORM, title: "Add a gadget" };

  /** 呼ぶたびに別のキーを返す生成器と、これまでに作ったキー。 */
  function keys() {
    const made: string[] = [];
    return {
      made,
      newKey: () => {
        const next = `key-${String(made.length + 1)}`;
        made.push(next);
        return next;
      },
    };
  }

  /** 送信を始め、渡されたキーを返す。 */
  function send(
    sessions: ReturnType<typeof createIntakeSessions>,
    form: IntakeForm = FORM,
  ): string {
    let given = "";
    startIntake(sessions, KEY, form, (intakeKey) => {
      given = intakeKey;
      return true;
    });
    return given;
  }

  test("is a lower case uuid by default", () => {
    expect(send(createIntakeSessions())).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("is new for every first send", () => {
    const sessions = createIntakeSessions();
    expect(send(sessions)).not.toBe(send(sessions));
  });

  test("is kept in the session for the send in progress", () => {
    const { newKey } = keys();
    const sessions = createIntakeSessions(newKey);
    const given = send(sessions);
    expect(sessions.get(KEY).intakeKey).toBe(given);
  });

  test("is not kept when the write does not start", () => {
    const sessions = createIntakeSessions(keys().newKey);
    startIntake(sessions, KEY, FORM, () => false);
    expect(sessions.get(KEY).intakeKey).toBeNull();
  });

  test("is not made when the send is blocked", () => {
    const { newKey, made } = keys();
    const sessions = createIntakeSessions(newKey);
    sessions.record(KEY, UNKNOWN);
    send(sessions);
    expect(made).toEqual([]);
  });

  test("is the same for a resend of the input whose result is not known", () => {
    const sessions = createIntakeSessions(keys().newKey);
    const first = send(sessions);
    sessions.record(KEY, UNKNOWN);
    sessions.confirmResend(KEY);
    expect(send(sessions)).toBe(first);
  });

  test("is kept while the result is not known", () => {
    const sessions = createIntakeSessions(keys().newKey);
    const first = send(sessions);
    sessions.record(KEY, UNKNOWN);
    expect(sessions.get(KEY).intakeKey).toBe(first);
  });

  test("is the same for a resend after the screen left and came back", () => {
    const sessions = createIntakeSessions(keys().newKey);
    const first = send(sessions);
    sessions.record(KEY, UNKNOWN);
    const leave = sessions.subscribe(() => undefined);
    leave();
    sessions.dismiss(KEY);
    sessions.confirmResend(KEY);
    expect(send(sessions)).toBe(first);
  });

  test("is the same for a second resend after another unknown result", () => {
    const sessions = createIntakeSessions(keys().newKey);
    const first = send(sessions);
    sessions.record(KEY, UNKNOWN);
    sessions.confirmResend(KEY);
    send(sessions);
    sessions.record(KEY, UNKNOWN);
    sessions.confirmResend(KEY);
    expect(send(sessions)).toBe(first);
  });

  test("is new for a resend of a different input", () => {
    const sessions = createIntakeSessions(keys().newKey);
    const first = send(sessions);
    sessions.record(KEY, UNKNOWN);
    sessions.confirmResend(KEY);
    expect(send(sessions, OTHER_FORM)).not.toBe(first);
  });

  test("is new after a submission", () => {
    const sessions = createIntakeSessions(keys().newKey);
    const first = send(sessions);
    sessions.record(KEY, SUBMITTED);
    expect(send(sessions)).not.toBe(first);
  });

  test("is new after a refusal", () => {
    const sessions = createIntakeSessions(keys().newKey);
    const first = send(sessions);
    sessions.record(KEY, REFUSED);
    expect(send(sessions)).not.toBe(first);
  });

  test("is new after a rejection", () => {
    const sessions = createIntakeSessions(keys().newKey);
    const first = send(sessions);
    sessions.record(KEY, { kind: "rejected", message: "断られました" });
    expect(send(sessions)).not.toBe(first);
  });

  test("is new after the input is discarded", () => {
    const sessions = createIntakeSessions(keys().newKey);
    const first = send(sessions);
    sessions.record(KEY, UNKNOWN);
    sessions.discard(KEY);
    expect(send(sessions)).not.toBe(first);
  });

  test.each([
    ["a submission", SUBMITTED],
    ["a refusal", REFUSED],
    ["a rejection", { kind: "rejected", message: "断られました" } as const],
  ])("is dropped from the session after %s", (_name, attempt) => {
    const sessions = createIntakeSessions(keys().newKey);
    send(sessions);
    sessions.record(KEY, attempt);
    expect(sessions.get(KEY).intakeKey).toBeNull();
  });

  test("is dropped from the session when the input is discarded", () => {
    const sessions = createIntakeSessions(keys().newKey);
    send(sessions);
    sessions.record(KEY, UNKNOWN);
    sessions.discard(KEY);
    expect(sessions.get(KEY).intakeKey).toBeNull();
  });

  test("survives a draft that is saved while the result is not known", () => {
    const sessions = createIntakeSessions(keys().newKey);
    const first = send(sessions);
    sessions.record(KEY, UNKNOWN);
    sessions.draft(KEY, OTHER_FORM);
    expect(sessions.get(KEY).intakeKey).toBe(first);
  });

  test("is not written to the storage of the tab", () => {
    const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
      readFileSync(join(import.meta.dir, "intakeSession.ts"), "utf8"),
    );
    expect(code).not.toMatch(/sessionStorage|localStorage/);
  });
});
