import { describe, expect, test } from "bun:test";
import { isRequirementsApprovedForAttempt } from "../../f/factory/lib/approval_gate.ts";

describe("isRequirementsApprovedForAttempt", () => {
  test("accepts an approved request for the same attempt", () => {
    expect(
      isRequirementsApprovedForAttempt({ status: "approved", attempt: 2 }, 2),
    ).toBe(true);
  });

  test("rejects an approved request for another attempt", () => {
    expect(
      isRequirementsApprovedForAttempt({ status: "approved", attempt: 1 }, 2),
    ).toBe(false);
  });

  test("rejects a request that is not approved", () => {
    expect(
      isRequirementsApprovedForAttempt({ status: "rejected", attempt: 2 }, 2),
    ).toBe(false);
  });

  test("rejects a missing request", () => {
    expect(isRequirementsApprovedForAttempt(null, 1)).toBe(false);
  });
});

describe("the move of isRequirementsApprovedForAttempt", () => {
  async function implementSupportSource(): Promise<string> {
    return Bun.file(
      new URL("../../f/factory/lib/implement_support.ts", import.meta.url),
    ).text();
  }

  test("implement_support no longer defines it", async () => {
    expect(await implementSupportSource()).not.toMatch(
      /function isRequirementsApprovedForAttempt\b/,
    );
  });

  test("implement_support does not re-export it", async () => {
    expect(await implementSupportSource()).not.toMatch(
      /export \{[^}]*isRequirementsApprovedForAttempt/,
    );
  });
});
