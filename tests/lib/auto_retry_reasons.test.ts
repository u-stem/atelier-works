import { describe, expect, test } from "bun:test";
import { AUTO_RETRY_REASON_PREFIXES } from "../../f/factory/lib/auto_retry_reasons.ts";
import {
  CHECK_IMAGE_STALE_REASON,
  CHECK_RUNTIME_UNSAFE_REASON,
} from "../../f/factory/lib/check_sandbox.ts";

describe("AUTO_RETRY_REASON_PREFIXES", () => {
  test("contains the stale image reason", () => {
    expect(AUTO_RETRY_REASON_PREFIXES).toContain(
      `${CHECK_IMAGE_STALE_REASON}: `,
    );
  });

  test("does not contain the runtime unsafe reason", () => {
    expect(AUTO_RETRY_REASON_PREFIXES).not.toContain(
      `${CHECK_RUNTIME_UNSAFE_REASON}: `,
    );
  });
});
