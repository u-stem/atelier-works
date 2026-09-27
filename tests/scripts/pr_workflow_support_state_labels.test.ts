// Tests for f/factory/steps/pr_workflow_support.ts's PR state-label helpers
// (team-lead design, 2026-09-26): stateLabelForReview / stateLabelForFixOutcome
// (pure decisions) and setStateLabel (I/O: clears the other three state
// labels, then adds the target one).

import { describe, expect, test } from "bun:test";
import type { LogFields, Logger } from "../../f/factory/lib/log.ts";
import type { ReviewFinding } from "../../f/factory/lib/types.ts";
import {
  allStateLabels,
  type StateLabelConfig,
  setStateLabel,
  stateLabelForFixOutcome,
  stateLabelForReview,
} from "../../f/factory/steps/pr_workflow_support.ts";
import { createFakeCommandRunner, fail, ghApiOk } from "../lib/testSupport.ts";

const STATE_LABEL_CONFIG: StateLabelConfig = {
  changes_requested_label: "factory:changes-requested",
  reviewed_label: "factory:reviewed",
  rereview_label: "factory:rereview",
  needs_human_label: "factory:needs-human",
};

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    path: "a.ts",
    line: 10,
    end_line: null,
    severity: "major",
    kind: "must",
    message: "problem",
    suggestion: null,
    suggested_code: null,
    ...overrides,
  };
}

function createFakeLogger(): {
  log: Logger;
  warnings: { message: string; fields?: LogFields }[];
} {
  const warnings: { message: string; fields?: LogFields }[] = [];
  const log: Logger = {
    info: () => {},
    warn: (message, fields) => {
      warnings.push(fields === undefined ? { message } : { message, fields });
    },
    error: () => {},
  };
  return { log, warnings };
}

describe("allStateLabels", () => {
  test("returns all four configured state labels", () => {
    expect(allStateLabels(STATE_LABEL_CONFIG)).toEqual([
      "factory:changes-requested",
      "factory:reviewed",
      "factory:rereview",
      "factory:needs-human",
    ]);
  });
});

describe("stateLabelForReview", () => {
  test("returns changes_requested_label when a finding is kind must", () => {
    const label = stateLabelForReview(
      [finding({ kind: "must" })],
      0,
      STATE_LABEL_CONFIG,
    );
    expect(label).toBe("factory:changes-requested");
  });

  test("returns reviewed_label when no finding is kind must", () => {
    const label = stateLabelForReview(
      [finding({ kind: "nits" })],
      0,
      STATE_LABEL_CONFIG,
    );
    expect(label).toBe("factory:reviewed");
  });

  test("returns reviewed_label when there are no findings at all", () => {
    const label = stateLabelForReview([], 0, STATE_LABEL_CONFIG);
    expect(label).toBe("factory:reviewed");
  });

  // team-lead fix (2026-09-26): an old [MUST] left unresolved from a prior
  // round must keep the PR flagged even when this round's own findings have
  // no must (ReviewBodyMode's "rereview_open").
  test("returns changes_requested_label when openMustCount is greater than zero even with no must findings", () => {
    const label = stateLabelForReview(
      [finding({ kind: "nits" })],
      2,
      STATE_LABEL_CONFIG,
    );
    expect(label).toBe("factory:changes-requested");
  });
});

describe("stateLabelForFixOutcome", () => {
  test("maps rereview_requested to rereview_label", () => {
    expect(
      stateLabelForFixOutcome("rereview_requested", STATE_LABEL_CONFIG),
    ).toBe("factory:rereview");
  });

  test("maps needs_human to needs_human_label", () => {
    expect(stateLabelForFixOutcome("needs_human", STATE_LABEL_CONFIG)).toBe(
      "factory:needs-human",
    );
  });

  test("maps blocked to needs_human_label", () => {
    expect(stateLabelForFixOutcome("blocked", STATE_LABEL_CONFIG)).toBe(
      "factory:needs-human",
    );
  });

  test("maps failed to needs_human_label", () => {
    expect(stateLabelForFixOutcome("failed", STATE_LABEL_CONFIG)).toBe(
      "factory:needs-human",
    );
  });
});

describe("setStateLabel", () => {
  test("removes the other three state labels then adds the target label", async () => {
    const { run, calls } = createFakeCommandRunner([
      ghApiOk([]), // remove reviewed
      ghApiOk([]), // remove rereview
      ghApiOk([]), // remove needs-human
      ghApiOk([]), // add changes-requested
    ]);
    const { log } = createFakeLogger();
    await setStateLabel(
      { run, ghToken: "token" },
      "octo-owner",
      "atelier-works",
      7,
      STATE_LABEL_CONFIG,
      "factory:changes-requested",
      log,
    );
    expect(calls).toHaveLength(4);
  });

  test("never issues a removal call for the target label itself", async () => {
    const { run, calls } = createFakeCommandRunner([
      ghApiOk([]),
      ghApiOk([]),
      ghApiOk([]),
      ghApiOk([]),
    ]);
    const { log } = createFakeLogger();
    await setStateLabel(
      { run, ghToken: "token" },
      "octo-owner",
      "atelier-works",
      7,
      STATE_LABEL_CONFIG,
      "factory:reviewed",
      log,
    );
    const removalCalls = calls.slice(0, 3).map((call) => call.argv.join(" "));
    expect(removalCalls.join("\n")).not.toContain(
      encodeURIComponent("factory:reviewed"),
    );
  });

  test("logs the PR coordinates when adding the target label fails", async () => {
    const { run } = createFakeCommandRunner([
      ghApiOk([]),
      ghApiOk([]),
      ghApiOk([]),
      fail("network error"),
    ]);
    const { log, warnings } = createFakeLogger();
    await setStateLabel(
      { run, ghToken: "token" },
      "octo-owner",
      "atelier-works",
      7,
      STATE_LABEL_CONFIG,
      "factory:changes-requested",
      log,
    );
    expect(warnings.at(-1)?.fields).toMatchObject({
      owner: "octo-owner",
      repo: "atelier-works",
      number: 7,
      label: "factory:changes-requested",
    });
  });

  test("does not throw when adding the target label fails", async () => {
    const { run } = createFakeCommandRunner([
      ghApiOk([]),
      ghApiOk([]),
      ghApiOk([]),
      fail("network error"),
    ]);
    const { log } = createFakeLogger();
    await expect(
      setStateLabel(
        { run, ghToken: "token" },
        "octo-owner",
        "atelier-works",
        7,
        STATE_LABEL_CONFIG,
        "factory:changes-requested",
        log,
      ),
    ).resolves.toBeUndefined();
  });
});
