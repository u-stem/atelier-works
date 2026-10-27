import { describe, expect, test } from "bun:test";
import {
  DESIGN_APPROVAL_INCONSISTENT_REASON,
  DESIGN_STALE_REQUIREMENTS_REASON,
  designApprovalVerdict,
  designGate,
  designGateReason,
  isDesignApprovedForAttempt,
  isReadyForImplement,
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

describe("isReadyForImplement", () => {
  const ITEM = { id: 7, attempt: 2, design_attempt: 1 };
  const REQUIREMENTS = { status: "approved", attempt: 2, draft_id: 10 };

  function deps(
    options: {
      requirements?: {
        status: string;
        attempt: number;
        draft_id: number;
      } | null;
      design?: DesignApprovalRef | null;
    } = {},
  ) {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        latestRequirementsApproval: async () => {
          calls.push("requirements");
          return options.requirements === undefined
            ? REQUIREMENTS
            : options.requirements;
        },
        latestDesignApproval: async () => {
          calls.push("design");
          return options.design === undefined ? approval() : options.design;
        },
      },
    };
  }

  test("is false without a requirements approval", async () => {
    expect(
      await isReadyForImplement(ITEM, false, deps({ requirements: null }).deps),
    ).toBe(false);
  });

  test("is false when the requirements approval is for another attempt", async () => {
    expect(
      await isReadyForImplement(
        ITEM,
        false,
        deps({ requirements: { ...REQUIREMENTS, attempt: 1 } }).deps,
      ),
    ).toBe(false);
  });

  test("is false when the requirements are not approved", async () => {
    expect(
      await isReadyForImplement(
        ITEM,
        false,
        deps({ requirements: { ...REQUIREMENTS, status: "rejected" } }).deps,
      ),
    ).toBe(false);
  });

  test("is true with approved requirements when the design is disabled", async () => {
    expect(await isReadyForImplement(ITEM, false, deps().deps)).toBe(true);
  });

  test("does not read the design approval when the design is disabled", async () => {
    const d = deps();
    await isReadyForImplement(ITEM, false, d.deps);
    expect(d.calls).toEqual(["requirements"]);
  });

  test("is true when the design is enabled and the design approval matches", async () => {
    expect(await isReadyForImplement(ITEM, true, deps().deps)).toBe(true);
  });

  test("is false when the design is enabled and there is no design approval", async () => {
    expect(
      await isReadyForImplement(ITEM, true, deps({ design: null }).deps),
    ).toBe(false);
  });

  test("is false when the design is enabled and the design approval is pending", async () => {
    expect(
      await isReadyForImplement(
        ITEM,
        true,
        deps({ design: approval({ status: "pending" }) }).deps,
      ),
    ).toBe(false);
  });

  test("is false when the design approval is for another design attempt", async () => {
    expect(
      await isReadyForImplement(
        { ...ITEM, design_attempt: 2 },
        true,
        deps().deps,
      ),
    ).toBe(false);
  });

  test("is false when the design was made from other requirements", async () => {
    expect(
      await isReadyForImplement(
        ITEM,
        true,
        deps({ requirements: { ...REQUIREMENTS, draft_id: 11 } }).deps,
      ),
    ).toBe(false);
  });

  test("does not read the design approval when the requirements are not approved", async () => {
    const d = deps({ requirements: null });
    await isReadyForImplement(ITEM, true, d.deps);
    expect(d.calls).toEqual(["requirements"]);
  });
});

describe("designGate", () => {
  const INPUT = {
    designEnabled: true,
    workItem: { id: 7, attempt: 2, design_attempt: 1 },
    requirementsApproval: { draft_id: 10 },
  };

  type Draft = {
    work_item_id: number;
    design_attempt: number;
    requirement_draft_id: number;
    markdown: string;
  };

  /** 承認が指す設計書(`approval()`の`design_draft_id`の20)。 */
  const APPROVED_DRAFT: Draft = {
    work_item_id: 7,
    design_attempt: 1,
    requirement_draft_id: 10,
    markdown: "# approved design",
  };

  function harness(
    options: { approval?: DesignApprovalRef | null; draft?: Draft | null } = {},
  ) {
    const reads: number[] = [];
    const warnings: { message: string; fields: Record<string, unknown> }[] = [];
    let approvalReads = 0;
    return {
      reads,
      warnings,
      approvalReads: () => approvalReads,
      deps: {
        warn: (message: string, fields: Record<string, unknown>) => {
          warnings.push({ message, fields });
        },
        latestDesignApproval: async () => {
          approvalReads += 1;
          return options.approval === undefined ? approval() : options.approval;
        },
        getDesignDraft: async (id: number) => {
          reads.push(id);
          return options.draft === undefined ? APPROVED_DRAFT : options.draft;
        },
      },
    };
  }

  test("skips when the design is disabled", async () => {
    expect(
      await designGate({ ...INPUT, designEnabled: false }, harness().deps),
    ).toEqual({ kind: "skip" });
  });

  test("does not read anything when the design is disabled", async () => {
    const h = harness();
    await designGate({ ...INPUT, designEnabled: false }, h.deps);
    expect([h.approvalReads(), h.reads]).toEqual([0, []]);
  });

  test("passes with the markdown of the design the approval points at", async () => {
    expect(await designGate(INPUT, harness().deps)).toEqual({
      kind: "pass",
      markdown: "# approved design",
    });
  });

  test("reads the design draft by the id of the approval", async () => {
    const h = harness({ approval: approval({ design_draft_id: 33 }) });
    await designGate(INPUT, h.deps);
    expect(h.reads).toEqual([33]);
  });

  test("stops without an approval", async () => {
    expect(await designGate(INPUT, harness({ approval: null }).deps)).toEqual({
      kind: "stop",
      reason: noApprovedDesignReason(1),
    });
  });

  test("stops for a pending approval", async () => {
    expect(
      await designGate(
        INPUT,
        harness({ approval: approval({ status: "pending" }) }).deps,
      ),
    ).toEqual({ kind: "stop", reason: noApprovedDesignReason(1) });
  });

  test("stops for a design made from other requirements", async () => {
    expect(
      await designGate(
        { ...INPUT, requirementsApproval: { draft_id: 11 } },
        harness().deps,
      ),
    ).toEqual({ kind: "stop", reason: DESIGN_STALE_REQUIREMENTS_REASON });
  });

  test("stops for an approval whose payload is off", async () => {
    expect(
      await designGate(
        INPUT,
        harness({ approval: approval({ payload_attempt: null }) }).deps,
      ),
    ).toEqual({ kind: "stop", reason: DESIGN_APPROVAL_INCONSISTENT_REASON });
  });

  test("names the design attempt of the work item in the reason", async () => {
    expect(
      await designGate(
        { ...INPUT, workItem: { id: 7, attempt: 2, design_attempt: 0 } },
        harness().deps,
      ),
    ).toEqual({ kind: "stop", reason: noApprovedDesignReason(0) });
  });

  test("does not read the design draft when the verdict is not ok", async () => {
    const h = harness({ approval: null });
    await designGate(INPUT, h.deps);
    expect(h.reads).toEqual([]);
  });

  test("stops as inconsistent when the design draft is gone", async () => {
    expect(await designGate(INPUT, harness({ draft: null }).deps)).toEqual({
      kind: "stop",
      reason: DESIGN_APPROVAL_INCONSISTENT_REASON,
    });
  });

  test("stops as inconsistent when the draft read again has another design attempt", async () => {
    expect(
      await designGate(
        INPUT,
        harness({ draft: { ...APPROVED_DRAFT, design_attempt: 2 } }).deps,
      ),
    ).toEqual({ kind: "stop", reason: DESIGN_APPROVAL_INCONSISTENT_REASON });
  });

  test("stops as inconsistent when the draft read again has other requirements", async () => {
    expect(
      await designGate(
        INPUT,
        harness({ draft: { ...APPROVED_DRAFT, requirement_draft_id: 11 } })
          .deps,
      ),
    ).toEqual({ kind: "stop", reason: DESIGN_APPROVAL_INCONSISTENT_REASON });
  });

  test("stops as inconsistent when the draft read again belongs to another work item", async () => {
    expect(
      await designGate(
        INPUT,
        harness({ draft: { ...APPROVED_DRAFT, work_item_id: 8 } }).deps,
      ),
    ).toEqual({ kind: "stop", reason: DESIGN_APPROVAL_INCONSISTENT_REASON });
  });

  describe("the design handed to the implementation", () => {
    const withMarkdown = (markdown: string) => ({
      ...APPROVED_DRAFT,
      markdown,
    });

    test("leaves a plain design as it is", async () => {
      expect(
        await designGate(
          INPUT,
          harness({ draft: withMarkdown("# plan\n\nbody") }).deps,
        ),
      ).toEqual({ kind: "pass", markdown: "# plan\n\nbody" });
    });

    test("does not warn about a plain design", async () => {
      const h = harness({ draft: withMarkdown("# plan\n\nbody") });
      await designGate(INPUT, h.deps);
      expect(h.warnings).toEqual([]);
    });

    test("removes an HTML comment from the design", async () => {
      const result = await designGate(
        INPUT,
        harness({ draft: withMarkdown("before<!-- hidden order -->after") })
          .deps,
      );
      expect(result).toEqual({ kind: "pass", markdown: "beforeafter" });
    });

    test("removes an HTML comment that is never closed up to the end", async () => {
      const result = await designGate(
        INPUT,
        harness({ draft: withMarkdown("visible\n<!-- hidden\nstill hidden") })
          .deps,
      );
      expect(result).toEqual({ kind: "pass", markdown: "visible\n" });
    });

    test("masks a secret that a comment split in two", async () => {
      const result = await designGate(
        INPUT,
        harness({
          draft: withMarkdown(
            "ghp_0123456789abcdef<!-- split -->ghijklmnopqrstuvwxyz",
          ),
        }).deps,
      );
      expect(result).toEqual({ kind: "pass", markdown: "***" });
    });

    test("cuts a design over the limit and marks the cut", async () => {
      const result = await designGate(
        INPUT,
        harness({ draft: withMarkdown("a".repeat(8001)) }).deps,
      );
      expect(result).toEqual({
        kind: "pass",
        markdown: `${"a".repeat(8000)}\n[the design was truncated]`,
      });
    });

    test("keeps a design of exactly the limit", async () => {
      const result = await designGate(
        INPUT,
        harness({ draft: withMarkdown("a".repeat(8000)) }).deps,
      );
      expect(result).toEqual({ kind: "pass", markdown: "a".repeat(8000) });
    });

    test("does not cut a design that fits once its comments are removed", async () => {
      const result = await designGate(
        INPUT,
        harness({
          draft: withMarkdown(`a<!--${"x".repeat(9000)}-->${"a".repeat(7999)}`),
        }).deps,
      );
      expect(result).toEqual({ kind: "pass", markdown: "a".repeat(8000) });
    });

    test("warns once when the design changed", async () => {
      const h = harness({ draft: withMarkdown("a<!-- c -->b") });
      await designGate(INPUT, h.deps);
      expect(h.warnings).toHaveLength(1);
    });

    test("warns with the fields that name the design and its sizes, and never the text", async () => {
      const h = harness({ draft: withMarkdown("a<!-- secret text -->b") });
      await designGate(INPUT, h.deps);
      expect(h.warnings[0]?.fields).toEqual({
        work_item_id: 7,
        design_draft_id: 20,
        original_chars: 2,
        kept_chars: 2,
        truncated: false,
        masked: false,
        dropped_combining: false,
        stripped_html_count: 1,
      });
    });

    test("warns when a secret was masked", async () => {
      const h = harness({
        draft: withMarkdown("token ghp_0123456789abcdefghijklmnopqrstuvwxyz"),
      });
      await designGate(INPUT, h.deps);
      expect(h.warnings[0]?.fields.masked).toBe(true);
    });

    test("warns when the design was cut", async () => {
      const h = harness({ draft: withMarkdown("a".repeat(8001)) });
      await designGate(INPUT, h.deps);
      expect(h.warnings[0]?.fields.truncated).toBe(true);
    });

    test("does not warn when the gate stops", async () => {
      const h = harness({ approval: null, draft: withMarkdown("a<!-- c -->") });
      await designGate(INPUT, h.deps);
      expect(h.warnings).toEqual([]);
    });
  });
});
