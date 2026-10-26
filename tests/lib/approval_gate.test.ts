import { describe, expect, test } from "bun:test";
import {
  DESIGN_APPROVAL_INCONSISTENT_REASON,
  DESIGN_STALE_REQUIREMENTS_REASON,
  designApprovalVerdict,
  designGateReason,
  isDesignApprovedForAttempt,
  isRequirementsApprovedForAttempt,
  noApprovedDesignReason,
} from "../../f/factory/lib/approval_gate.ts";
import type { DesignApprovalRef } from "../../f/factory/lib/types.ts";

const EXPECTED = { attempt: 2, designAttempt: 1, requirementDraftId: 10 };

/** 期待値`EXPECTED`に全部が一致する、承認済みの設計の承認。 */
function approval(
  overrides: Partial<DesignApprovalRef> = {},
): DesignApprovalRef {
  return {
    approval_request_id: 5,
    design_draft_id: 20,
    status: "approved",
    payload_attempt: 2,
    payload_design_attempt: 1,
    draft: { design_attempt: 1, requirement_draft_id: 10 },
    ...overrides,
  };
}

describe("designApprovalVerdict", () => {
  test("is ok when everything matches", () => {
    expect(designApprovalVerdict(approval(), EXPECTED).kind).toBe("ok");
  });

  test("is not_approved when there is no approval", () => {
    expect(designApprovalVerdict(null, EXPECTED).kind).toBe("not_approved");
  });

  test.each([["pending"], ["rejected"], ["expired"]] as const)(
    "is not_approved when the status is %s",
    (status) => {
      expect(designApprovalVerdict(approval({ status }), EXPECTED).kind).toBe(
        "not_approved",
      );
    },
  );

  test("is not_approved for a pending request whose draft is missing", () => {
    expect(
      designApprovalVerdict(
        approval({ status: "pending", draft: null }),
        EXPECTED,
      ).kind,
    ).toBe("not_approved");
  });

  test("is not_approved for a pending request whose payload is off", () => {
    expect(
      designApprovalVerdict(
        approval({ status: "pending", payload_attempt: null }),
        EXPECTED,
      ).kind,
    ).toBe("not_approved");
  });

  test("is inconsistent when the approved request points at no design draft", () => {
    expect(
      designApprovalVerdict(approval({ draft: null }), EXPECTED).kind,
    ).toBe("inconsistent");
  });

  test("is inconsistent when payload_attempt is missing", () => {
    expect(
      designApprovalVerdict(approval({ payload_attempt: null }), EXPECTED).kind,
    ).toBe("inconsistent");
  });

  test("is inconsistent when payload_design_attempt is missing", () => {
    expect(
      designApprovalVerdict(
        approval({ payload_design_attempt: null }),
        EXPECTED,
      ).kind,
    ).toBe("inconsistent");
  });

  test("is inconsistent when both payload values are missing", () => {
    expect(
      designApprovalVerdict(
        approval({ payload_attempt: null, payload_design_attempt: null }),
        EXPECTED,
      ).kind,
    ).toBe("inconsistent");
  });

  test("is inconsistent when payload_design_attempt differs from the draft", () => {
    expect(
      designApprovalVerdict(approval({ payload_design_attempt: 2 }), EXPECTED)
        .kind,
    ).toBe("inconsistent");
  });

  test("is inconsistent, not stale, when the payload is missing and the requirements differ", () => {
    expect(
      designApprovalVerdict(approval({ payload_attempt: null }), {
        ...EXPECTED,
        requirementDraftId: 11,
      }).kind,
    ).toBe("inconsistent");
  });

  test("is inconsistent, not not_approved, when the payload is missing and the design attempt is 0", () => {
    expect(
      designApprovalVerdict(approval({ payload_attempt: null }), {
        ...EXPECTED,
        designAttempt: 0,
      }).kind,
    ).toBe("inconsistent");
  });

  test("is not_approved when the expected design attempt is 0", () => {
    expect(
      designApprovalVerdict(
        approval({
          payload_design_attempt: 0,
          draft: { design_attempt: 0, requirement_draft_id: 10 },
        }),
        { ...EXPECTED, designAttempt: 0 },
      ).kind,
    ).toBe("not_approved");
  });

  test("is not_approved when the expected design attempt differs from the draft", () => {
    expect(
      designApprovalVerdict(approval(), { ...EXPECTED, designAttempt: 2 }).kind,
    ).toBe("not_approved");
  });

  test("is stale_requirements when the requirement draft differs", () => {
    expect(
      designApprovalVerdict(approval(), { ...EXPECTED, requirementDraftId: 11 })
        .kind,
    ).toBe("stale_requirements");
  });

  test("is stale_requirements when the payload attempt differs", () => {
    expect(
      designApprovalVerdict(approval(), { ...EXPECTED, attempt: 3 }).kind,
    ).toBe("stale_requirements");
  });

  test("is not_approved, not stale, when the design attempt differs too", () => {
    expect(
      designApprovalVerdict(approval(), {
        ...EXPECTED,
        designAttempt: 2,
        requirementDraftId: 11,
      }).kind,
    ).toBe("not_approved");
  });
});

describe("isDesignApprovedForAttempt", () => {
  test("is true only for an ok verdict", () => {
    expect(isDesignApprovedForAttempt(approval(), EXPECTED)).toBe(true);
  });

  test("is false when there is no approval", () => {
    expect(isDesignApprovedForAttempt(null, EXPECTED)).toBe(false);
  });

  test("is false for a stale approval", () => {
    expect(
      isDesignApprovedForAttempt(approval(), {
        ...EXPECTED,
        requirementDraftId: 11,
      }),
    ).toBe(false);
  });

  test("is false for an inconsistent approval", () => {
    expect(
      isDesignApprovedForAttempt(approval({ draft: null }), EXPECTED),
    ).toBe(false);
  });
});

describe("the reasons of the design gate", () => {
  test("words the missing approval with the design attempt", () => {
    expect(noApprovedDesignReason(3)).toBe(
      "no approved design for design attempt 3",
    );
  });

  test("words the stale requirements", () => {
    expect(DESIGN_STALE_REQUIREMENTS_REASON).toBe(
      "approved design does not match the approved requirements",
    );
  });

  test("words the inconsistent record", () => {
    expect(DESIGN_APPROVAL_INCONSISTENT_REASON).toBe(
      "design approval record is inconsistent",
    );
  });

  test("maps not_approved to the missing approval", () => {
    expect(designGateReason({ kind: "not_approved" }, 0)).toBe(
      noApprovedDesignReason(0),
    );
  });

  test("maps stale_requirements to the stale reason", () => {
    expect(designGateReason({ kind: "stale_requirements" }, 1)).toBe(
      DESIGN_STALE_REQUIREMENTS_REASON,
    );
  });

  test("maps inconsistent to the inconsistent reason", () => {
    expect(designGateReason({ kind: "inconsistent" }, 1)).toBe(
      DESIGN_APPROVAL_INCONSISTENT_REASON,
    );
  });
});

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
