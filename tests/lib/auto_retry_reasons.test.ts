import { describe, expect, test } from "bun:test";
import {
  AUTO_RETRY_REASON_PREFIXES,
  PR_RUN_WAIT_REASON_PREFIXES,
} from "../../f/factory/lib/auto_retry_reasons.ts";
import {
  CHECK_IMAGE_STALE_REASON,
  CHECK_RUNTIME_UNSAFE_REASON,
} from "../../f/factory/lib/check_sandbox.ts";
import { ACTIVE_PR_RUN_REASON } from "../../f/factory/lib/implement_support.ts";

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

describe("PR_RUN_WAIT_REASON_PREFIXES", () => {
  test("contains the reason of an implement stopped by an active run", () => {
    expect(PR_RUN_WAIT_REASON_PREFIXES).toContain(ACTIVE_PR_RUN_REASON);
  });

  test("contains no other reason", () => {
    expect(PR_RUN_WAIT_REASON_PREFIXES).toEqual([ACTIVE_PR_RUN_REASON]);
  });

  test("does not contain the stale image reason", () => {
    expect(PR_RUN_WAIT_REASON_PREFIXES).not.toContain(
      `${CHECK_IMAGE_STALE_REASON}: `,
    );
  });

  test("is kept apart from the reasons that wait for a resolved notice", () => {
    expect(AUTO_RETRY_REASON_PREFIXES).not.toContain(ACTIVE_PR_RUN_REASON);
  });
});
