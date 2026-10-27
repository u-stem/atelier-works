import { describe, expect, test } from "bun:test";
import { designGateReason } from "../../f/factory/lib/approval_gate.ts";
import {
  classifyDesignApply,
  DESIGN_ISSUE_CHANGED_NOTE,
  DESIGN_REGENERATING_NOTE,
  decideDesignRejection,
  designRejectionPipelineInput,
  isDesignRejectionExhausted,
  judgeDesignApproved,
} from "../../f/factory/lib/design_apply_support.ts";
import {
  DESIGN_REJECTED_EXHAUSTED_PREFIX,
  designNoApprovalReason,
  designRejectedExhaustedReason,
} from "../../f/factory/lib/design_template.ts";
import type { DesignApprovalRef } from "../../f/factory/lib/types.ts";

const WORK_ITEM = {
  status: "awaiting_design_approval",
  issue_number: 42,
  attempt: 2,
  design_attempt: 3,
} as const;

const APPROVED_REQUEST = { id: 11, status: "approved" } as const;

const LATEST = { approval_request_id: 11, payload_design_attempt: 3 } as const;

describe("the fixed notes of a design rejection", () => {
  test("names the regeneration without the reason of the person", () => {
    expect(DESIGN_REGENERATING_NOTE).toBe("design rejected; regenerating");
  });

  test("names the return to the requirements", () => {
    expect(DESIGN_ISSUE_CHANGED_NOTE).toBe(
      "design rejected; the issue changed since intake",
    );
  });

  test("keeps both notes out of the exhausted prefix", () => {
    expect(
      [DESIGN_REGENERATING_NOTE, DESIGN_ISSUE_CHANGED_NOTE].filter((note) =>
        note.startsWith(DESIGN_REJECTED_EXHAUSTED_PREFIX),
      ),
    ).toEqual([]);
  });
});

describe("classifyDesignApply", () => {
  test("does nothing when the work item is not awaiting the design approval", () => {
    expect(
      classifyDesignApply({
        request: APPROVED_REQUEST,
        workItem: { ...WORK_ITEM, status: "designing" },
        latest: LATEST,
      }).kind,
    ).toBe("no_op");
  });

  test("does nothing when the work item was cancelled", () => {
    expect(
      classifyDesignApply({
        request: APPROVED_REQUEST,
        workItem: { ...WORK_ITEM, status: "cancelled" },
        latest: LATEST,
      }).kind,
    ).toBe("no_op");
  });

  test("reports a work item without an issue number as invalid", () => {
    expect(
      classifyDesignApply({
        request: APPROVED_REQUEST,
        workItem: { ...WORK_ITEM, issue_number: null },
        latest: LATEST,
      }).kind,
    ).toBe("invalid");
  });

  test("checks the status of the work item before the issue number", () => {
    expect(
      classifyDesignApply({
        request: APPROVED_REQUEST,
        workItem: { ...WORK_ITEM, status: "expired", issue_number: null },
        latest: LATEST,
      }).kind,
    ).toBe("no_op");
  });

  test("does nothing when the request is still pending", () => {
    expect(
      classifyDesignApply({
        request: { id: 11, status: "pending" },
        workItem: WORK_ITEM,
        latest: LATEST,
      }).kind,
    ).toBe("no_op");
  });

  test("does nothing when the request has expired", () => {
    expect(
      classifyDesignApply({
        request: { id: 11, status: "expired" },
        workItem: WORK_ITEM,
        latest: LATEST,
      }).kind,
    ).toBe("no_op");
  });

  test("does nothing when a newer request exists", () => {
    expect(
      classifyDesignApply({
        request: APPROVED_REQUEST,
        workItem: WORK_ITEM,
        latest: { approval_request_id: 12, payload_design_attempt: 3 },
      }).kind,
    ).toBe("no_op");
  });

  test("does nothing when the work item has no design request at all", () => {
    expect(
      classifyDesignApply({
        request: APPROVED_REQUEST,
        workItem: WORK_ITEM,
        latest: null,
      }).kind,
    ).toBe("no_op");
  });

  test("does not stop a stale request even when its record is inconsistent", () => {
    expect(
      classifyDesignApply({
        request: APPROVED_REQUEST,
        workItem: WORK_ITEM,
        latest: { approval_request_id: 12, payload_design_attempt: null },
      }).kind,
    ).toBe("no_op");
  });

  test("stops for a person when the record has no design attempt", () => {
    expect(
      classifyDesignApply({
        request: APPROVED_REQUEST,
        workItem: WORK_ITEM,
        latest: { approval_request_id: 11, payload_design_attempt: null },
      }).kind,
    ).toBe("needs_human");
  });

  test("stops for a person when the design attempt of the record differs", () => {
    expect(
      classifyDesignApply({
        request: APPROVED_REQUEST,
        workItem: WORK_ITEM,
        latest: { approval_request_id: 11, payload_design_attempt: 2 },
      }).kind,
    ).toBe("needs_human");
  });

  test("notes the inconsistent record as the reason", () => {
    expect(
      classifyDesignApply({
        request: APPROVED_REQUEST,
        workItem: WORK_ITEM,
        latest: { approval_request_id: 11, payload_design_attempt: 2 },
      }),
    ).toEqual({
      kind: "needs_human",
      reason: designGateReason({ kind: "inconsistent" }, 3),
    });
  });

  test("proceeds for an approved request that matches", () => {
    expect(
      classifyDesignApply({
        request: APPROVED_REQUEST,
        workItem: WORK_ITEM,
        latest: LATEST,
      }).kind,
    ).toBe("proceed");
  });

  test("carries the issue number when it proceeds", () => {
    expect(
      classifyDesignApply({
        request: APPROVED_REQUEST,
        workItem: WORK_ITEM,
        latest: LATEST,
      }),
    ).toEqual({ kind: "proceed", issueNumber: 42 });
  });

  test("proceeds for a rejected request that matches", () => {
    expect(
      classifyDesignApply({
        request: { id: 11, status: "rejected" },
        workItem: WORK_ITEM,
        latest: LATEST,
      }).kind,
    ).toBe("proceed");
  });

  test("proceeds before the latest request is known", () => {
    expect(
      classifyDesignApply({ request: APPROVED_REQUEST, workItem: WORK_ITEM })
        .kind,
    ).toBe("proceed");
  });
});

function designApproval(
  overrides: Partial<DesignApprovalRef> = {},
): DesignApprovalRef {
  return {
    approval_request_id: 11,
    design_draft_id: 5,
    status: "approved",
    payload_attempt: 2,
    payload_design_attempt: 3,
    reason: null,
    draft: { design_attempt: 3, requirement_draft_id: 8 },
    ...overrides,
  };
}

const REQUIREMENTS_APPROVAL = { status: "approved", attempt: 2, draft_id: 8 };

describe("judgeDesignApproved", () => {
  test("accepts an approval that matches the requirements and the design", () => {
    expect(
      judgeDesignApproved({
        workItem: WORK_ITEM,
        requirementsApproval: REQUIREMENTS_APPROVAL,
        designApproval: designApproval(),
      }),
    ).toEqual({ kind: "ok" });
  });

  test("stops when the requirements were not approved", () => {
    expect(
      judgeDesignApproved({
        workItem: WORK_ITEM,
        requirementsApproval: null,
        designApproval: designApproval(),
      }),
    ).toEqual({ kind: "needs_human", reason: designNoApprovalReason(2) });
  });

  test("stops when the approval of the requirements is for another attempt", () => {
    expect(
      judgeDesignApproved({
        workItem: WORK_ITEM,
        requirementsApproval: { ...REQUIREMENTS_APPROVAL, attempt: 1 },
        designApproval: designApproval(),
      }),
    ).toEqual({ kind: "needs_human", reason: designNoApprovalReason(2) });
  });

  test("stops when the requirements were rejected", () => {
    expect(
      judgeDesignApproved({
        workItem: WORK_ITEM,
        requirementsApproval: { ...REQUIREMENTS_APPROVAL, status: "rejected" },
        designApproval: designApproval(),
      }),
    ).toEqual({ kind: "needs_human", reason: designNoApprovalReason(2) });
  });

  test("checks the requirements before the design", () => {
    expect(
      judgeDesignApproved({
        workItem: WORK_ITEM,
        requirementsApproval: null,
        designApproval: null,
      }),
    ).toEqual({ kind: "needs_human", reason: designNoApprovalReason(2) });
  });

  test("stops with the reason of the gate when the design is not approved", () => {
    expect(
      judgeDesignApproved({
        workItem: WORK_ITEM,
        requirementsApproval: REQUIREMENTS_APPROVAL,
        designApproval: designApproval({ status: "rejected" }),
      }),
    ).toEqual({
      kind: "needs_human",
      reason: designGateReason({ kind: "not_approved" }, 3),
    });
  });

  test("stops with the reason of the gate when the design follows other requirements", () => {
    expect(
      judgeDesignApproved({
        workItem: WORK_ITEM,
        requirementsApproval: REQUIREMENTS_APPROVAL,
        designApproval: designApproval({
          draft: { design_attempt: 3, requirement_draft_id: 99 },
        }),
      }),
    ).toEqual({
      kind: "needs_human",
      reason: designGateReason({ kind: "stale_requirements" }, 3),
    });
  });

  test("stops with the reason of the gate when the record is inconsistent", () => {
    expect(
      judgeDesignApproved({
        workItem: WORK_ITEM,
        requirementsApproval: REQUIREMENTS_APPROVAL,
        designApproval: designApproval({ draft: null }),
      }),
    ).toEqual({
      kind: "needs_human",
      reason: designGateReason({ kind: "inconsistent" }, 3),
    });
  });
});

describe("isDesignRejectionExhausted", () => {
  test("counts the rejection that is being applied", () => {
    expect(isDesignRejectionExhausted(2, 3)).toBe(true);
  });

  test("allows a regeneration below the limit", () => {
    expect(isDesignRejectionExhausted(1, 3)).toBe(false);
  });

  test("is exhausted at the first rejection when the limit is 1", () => {
    expect(isDesignRejectionExhausted(0, 1)).toBe(true);
  });
});

describe("decideDesignRejection", () => {
  test("returns to the requirements when the issue changed", () => {
    expect(
      decideDesignRejection({
        issue: "changed",
        appliedRejections: 0,
        maxDesignAttempts: 3,
      }),
    ).toBe("return_to_requirements");
  });

  test("returns to the requirements even at the limit", () => {
    expect(
      decideDesignRejection({
        issue: "changed",
        appliedRejections: 5,
        maxDesignAttempts: 3,
      }),
    ).toBe("return_to_requirements");
  });

  test("regenerates the first rejection when the issue did not change", () => {
    expect(
      decideDesignRejection({
        issue: "unchanged",
        appliedRejections: 0,
        maxDesignAttempts: 3,
      }),
    ).toBe("regenerate");
  });

  test("regenerates the second rejection when the limit is 3", () => {
    expect(
      decideDesignRejection({
        issue: "unchanged",
        appliedRejections: 1,
        maxDesignAttempts: 3,
      }),
    ).toBe("regenerate");
  });

  test("waits for a person at the third rejection when the limit is 3", () => {
    expect(
      decideDesignRejection({
        issue: "unchanged",
        appliedRejections: 2,
        maxDesignAttempts: 3,
      }),
    ).toBe("needs_human");
  });

  test("waits for a person at the first rejection when the limit is 1", () => {
    expect(
      decideDesignRejection({
        issue: "unchanged",
        appliedRejections: 0,
        maxDesignAttempts: 1,
      }),
    ).toBe("needs_human");
  });

  test("regenerates the ninth rejection when the limit is 10", () => {
    expect(
      decideDesignRejection({
        issue: "unchanged",
        appliedRejections: 8,
        maxDesignAttempts: 10,
      }),
    ).toBe("regenerate");
  });

  test("waits for a person at the tenth rejection when the limit is 10", () => {
    expect(
      decideDesignRejection({
        issue: "unchanged",
        appliedRejections: 9,
        maxDesignAttempts: 10,
      }),
    ).toBe("needs_human");
  });

  test("waits for a person at the first rejection after a retry from the limit", () => {
    expect(
      decideDesignRejection({
        issue: "unchanged",
        appliedRejections: 3,
        maxDesignAttempts: 3,
      }),
    ).toBe("needs_human");
  });

  test("regenerates when few rejections were applied, however far the design attempt went", () => {
    expect(
      decideDesignRejection({
        issue: "unchanged",
        appliedRejections: 0,
        maxDesignAttempts: 3,
      }),
    ).toBe("regenerate");
  });

  test("treats an issue that could not be read as unchanged and regenerates", () => {
    expect(
      decideDesignRejection({
        issue: "unavailable",
        appliedRejections: 0,
        maxDesignAttempts: 3,
      }),
    ).toBe("regenerate");
  });

  test("treats an issue that could not be read as unchanged and waits at the limit", () => {
    expect(
      decideDesignRejection({
        issue: "unavailable",
        appliedRejections: 2,
        maxDesignAttempts: 3,
      }),
    ).toBe("needs_human");
  });
});

describe("the reason of a rejection that reached the limit", () => {
  test("starts with the prefix that the count uses", () => {
    expect(
      designRejectedExhaustedReason(3).startsWith(
        DESIGN_REJECTED_EXHAUSTED_PREFIX,
      ),
    ).toBe(true);
  });
});

describe("designRejectionPipelineInput", () => {
  test("starts the next attempt of the requirements with the reason of the person", () => {
    expect(
      designRejectionPipelineInput({ id: 7, attempt: 2 }, "see the issue"),
    ).toEqual({ work_item_id: 7, attempt: 3, feedback: "see the issue" });
  });

  test("leaves the feedback out when the reason is empty", () => {
    expect(designRejectionPipelineInput({ id: 7, attempt: 2 }, "")).toEqual({
      work_item_id: 7,
      attempt: 3,
    });
  });
});
