import { describe, expect, test } from "bun:test";
import { buildInboxUrl } from "../../f/factory/steps/pipeline_request_approval.ts";

const INBOX_URL = "http://127.0.0.1:8080/apps/get/f/factory/factory_console";

describe("buildInboxUrl", () => {
  test("builds the App's view URL under windmill_public_url", () => {
    expect(buildInboxUrl("http://127.0.0.1:8080")).toBe(INBOX_URL);
  });

  test("does not contain a getResumeUrls-style capability token", () => {
    expect(buildInboxUrl("http://127.0.0.1:8080")).not.toContain("token=");
  });
});
