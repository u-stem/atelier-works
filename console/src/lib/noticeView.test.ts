import { describe, expect, test } from "bun:test";
import type { SummaryNotice } from "../api/guards/summary.ts";
import {
  describeNotice,
  MAX_NOTICE_TARGETS,
  noticeSeverityLabel,
  noticeTargets,
} from "./noticeView.ts";

function notice(overrides: Partial<SummaryNotice> = {}): SummaryNotice {
  return {
    notice_id: 21,
    kind: "cleanup_db_failed",
    message: "disk full",
    resolved: false,
    created_at: "2026-10-03T00:00:00.000Z",
    severity: "action",
    resolvable: true,
    ...overrides,
  };
}

describe("noticeSeverityLabel", () => {
  test("labels an action notice", () => {
    expect(noticeSeverityLabel("action")).toBe("要対応");
  });

  test("labels an info notice", () => {
    expect(noticeSeverityLabel("info")).toBe("情報");
  });

  test("treats an unknown severity as needing action", () => {
    expect(noticeSeverityLabel("loud")).toBe("要対応");
  });
});

describe("noticeTargets", () => {
  test("reads a target at the start of the body", () => {
    expect(noticeTargets("o/r#12 (work item 3): reason")).toEqual([
      { label: "o/r#12", url: "https://github.com/o/r/issues/12" },
    ]);
  });

  test("reads a target in the middle of the body", () => {
    expect(
      noticeTargets("failed for acme/web-app#7: label factory").map(
        (target) => target.label,
      ),
    ).toEqual(["acme/web-app#7"]);
  });

  test("keeps each target once, in order of appearance", () => {
    expect(
      noticeTargets("b/y#2 then a/x#1 and b/y#2").map((target) => target.label),
    ).toEqual(["b/y#2", "a/x#1"]);
  });

  test("returns nothing when the body names no target", () => {
    expect(noticeTargets("disk full")).toEqual([]);
  });

  test("ignores a number that has no repository", () => {
    expect(noticeTargets("see #12")).toEqual([]);
  });

  test("ignores an owner that GitHub would not accept", () => {
    expect(noticeTargets("-bad/r#12")).toEqual([]);
  });

  test("reads at most the limit of targets", () => {
    const body = Array.from({ length: 12 }, (_, index) => `o/r#${index + 1}`);
    expect(noticeTargets(body.join(" ")).length).toBe(MAX_NOTICE_TARGETS);
  });

  test("does not read a path of a URL as a target", () => {
    expect(noticeTargets("https://github.com/o/r/issues/1")).toEqual([]);
  });
});

describe("describeNotice", () => {
  test("titles the notice with the Japanese kind label", () => {
    expect(describeNotice(notice()).title).toBe("データベースの掃除の失敗");
  });

  test("labels the severity", () => {
    expect(describeNotice(notice({ severity: "info" })).severityLabel).toBe(
      "情報",
    );
  });

  test("lets an unresolved resolvable notice be resolved", () => {
    expect(describeNotice(notice()).canResolve).toBe(true);
  });

  test("does not let an unresolvable notice be resolved", () => {
    expect(describeNotice(notice({ resolvable: false })).canResolve).toBe(
      false,
    );
  });

  test("does not let a resolved notice be resolved again", () => {
    expect(describeNotice(notice({ resolved: true })).canResolve).toBe(false);
  });

  test("explains why an unresolvable notice has no button", () => {
    expect(
      describeNotice(notice({ resolvable: false })).unresolvableReason,
    ).toContain("Consoleからは解決できません");
  });

  test("gives no reason for a notice that can be resolved", () => {
    expect(describeNotice(notice()).unresolvableReason).toBeNull();
  });

  test("gives no reason for a resolved notice", () => {
    expect(
      describeNotice(notice({ resolved: true, resolvable: false }))
        .unresolvableReason,
    ).toBeNull();
  });

  test("replaces hidden characters in the body", () => {
    expect(describeNotice(notice({ message: "a‮b" })).message).toBe("a�b");
  });

  test("tells that a hidden character was replaced", () => {
    expect(describeNotice(notice({ message: "a‮b" })).messageReplaced).toBe(
      true,
    );
  });

  test("keeps the body as plain text", () => {
    expect(describeNotice(notice({ message: "<b>x</b>" })).message).toBe(
      "<b>x</b>",
    );
  });

  test("takes the guide from the kind", () => {
    expect(
      describeNotice(notice({ kind: "host_action_required" })).guide.commands,
    ).toEqual(["git pull", "mise install", "mise run up"]);
  });

  test("lists the targets named in the body", () => {
    expect(
      describeNotice(notice({ message: "o/r#5 (work item 2): x" })).targets,
    ).toEqual([{ label: "o/r#5", url: "https://github.com/o/r/issues/5" }]);
  });
});
