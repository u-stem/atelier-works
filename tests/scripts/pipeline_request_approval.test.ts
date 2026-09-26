import { describe, expect, test } from "bun:test";
import {
  buildAwaitingApprovalComment,
  buildInboxUrl,
} from "../../f/factory/steps/pipeline_request_approval.ts";

const INBOX_URL = "http://127.0.0.1:8080/apps/get/f/factory/factory_console";

describe("buildInboxUrl", () => {
  test("builds the App's view URL under windmill_public_url", () => {
    expect(buildInboxUrl("http://127.0.0.1:8080")).toBe(INBOX_URL);
  });

  test("does not contain a getResumeUrls-style capability token", () => {
    expect(buildInboxUrl("http://127.0.0.1:8080")).not.toContain("token=");
  });
});

describe("buildAwaitingApprovalComment", () => {
  test("includes the instance name in the approval-location note", () => {
    const body = buildAwaitingApprovalComment(
      "instance-a",
      INBOX_URL,
      null,
      [],
    );
    expect(body).toContain("instance-a");
  });

  test("includes the inbox url", () => {
    const body = buildAwaitingApprovalComment(
      "instance-a",
      INBOX_URL,
      null,
      [],
    );
    expect(body).toContain(INBOX_URL);
  });

  test("includes the summary section when a summary is given", () => {
    const body = buildAwaitingApprovalComment(
      "instance-a",
      INBOX_URL,
      "要約テキスト",
      [],
    );
    expect(body).toContain("要約テキスト");
  });

  test("omits the summary section when summary is null", () => {
    const body = buildAwaitingApprovalComment(
      "instance-a",
      INBOX_URL,
      null,
      [],
    );
    expect(body).not.toContain("## 要約");
  });

  test("lists every open question as a bullet", () => {
    const body = buildAwaitingApprovalComment("instance-a", INBOX_URL, null, [
      "論点: a / 仮置き: b / 影響: c",
      "論点: d / 仮置き: e / 影響: f",
    ]);
    expect(body).toContain("- 論点: a / 仮置き: b / 影響: c");
  });

  test("omits the open-questions section when there are none", () => {
    const body = buildAwaitingApprovalComment(
      "instance-a",
      INBOX_URL,
      null,
      [],
    );
    expect(body).not.toContain("## 未確定事項");
  });
});
