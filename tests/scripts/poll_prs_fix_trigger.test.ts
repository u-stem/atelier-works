// Tests for f/factory/poll_prs.ts's partitionFixCommandsByAssociation
// (security-auditor fix round 1b item 1: a `/factory fix` comment from an
// author_association outside factory_config.allowed_labeler_associations
// must not trigger a fix cycle).

import { describe, expect, test } from "bun:test";
import {
  type FixCommandComment,
  partitionFixCommandsByAssociation,
} from "../../f/factory/poll_prs.ts";

const ALLOWED = ["OWNER", "MEMBER", "COLLABORATOR"] as const;

function comment(
  overrides: Partial<FixCommandComment> = {},
): FixCommandComment {
  return {
    id: 1,
    authorLogin: "alice",
    authorAssociation: "OWNER",
    body: "/factory fix",
    ...overrides,
  };
}

describe("partitionFixCommandsByAssociation", () => {
  test("treats an allowed association as trusted", () => {
    const { trusted } = partitionFixCommandsByAssociation(
      [comment({ authorAssociation: "MEMBER" })],
      ALLOWED,
    );
    expect(trusted).toHaveLength(1);
  });

  test("treats a disallowed association as untrusted", () => {
    const { untrusted } = partitionFixCommandsByAssociation(
      [comment({ authorAssociation: "NONE" })],
      ALLOWED,
    );
    expect(untrusted).toHaveLength(1);
  });

  test("treats a null association as untrusted", () => {
    const { untrusted } = partitionFixCommandsByAssociation(
      [comment({ authorAssociation: null })],
      ALLOWED,
    );
    expect(untrusted).toHaveLength(1);
  });

  test("keeps trusted and untrusted comments in their own buckets", () => {
    const result = partitionFixCommandsByAssociation(
      [
        comment({ id: 1, authorAssociation: "OWNER" }),
        comment({ id: 2, authorAssociation: "CONTRIBUTOR" }),
      ],
      ALLOWED,
    );
    expect(result.trusted.map((c) => c.id)).toEqual([1]);
  });

  test("untrusted bucket preserves the disallowed comment's id", () => {
    const result = partitionFixCommandsByAssociation(
      [
        comment({ id: 1, authorAssociation: "OWNER" }),
        comment({ id: 2, authorAssociation: "CONTRIBUTOR" }),
      ],
      ALLOWED,
    );
    expect(result.untrusted.map((c) => c.id)).toEqual([2]);
  });
});
