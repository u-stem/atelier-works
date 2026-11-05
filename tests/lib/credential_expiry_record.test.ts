import { describe, expect, test } from "bun:test";
import {
  buildCredentialExpiryRecord,
  type CredentialRecordInput,
  tokenExpirationFromHeader,
} from "../../f/factory/lib/credential_expiry.ts";

const NOW = new Date("2026-11-05T00:00:00.000Z");

function input(
  overrides: Partial<CredentialRecordInput> = {},
): CredentialRecordInput {
  return {
    previous: {},
    wmillTokenIssued: true,
    claudeFingerprint: "abc123",
    claudeTokenDays: 365,
    githubTokenExpiresAt: null,
    readTokenExpiresAt: {},
    interactionLimitsExpiresAt: null,
    ...overrides,
  };
}

describe("tokenExpirationFromHeader", () => {
  test("reads a time in UTC", () => {
    expect(tokenExpirationFromHeader("2026-12-01 07:22:17 UTC")).toBe(
      "2026-12-01T07:22:17.000Z",
    );
  });

  test("reads a time with an offset", () => {
    expect(tokenExpirationFromHeader("2026-12-01 09:00:00 +0900")).toBe(
      "2026-12-01T00:00:00.000Z",
    );
  });

  test("returns null without a header", () => {
    expect(tokenExpirationFromHeader(undefined)).toBeNull();
  });

  test("returns null for a header it cannot read", () => {
    expect(tokenExpirationFromHeader("next year")).toBeNull();
  });
});

describe("buildCredentialExpiryRecord", () => {
  test("starts the wmill token today when bootstrap issued one", () => {
    expect(buildCredentialExpiryRecord(input(), NOW).wmill_token).toEqual({
      issued_at: "2026-11-05T00:00:00.000Z",
      expires_at: "2027-05-04T00:00:00.000Z",
    });
  });

  test("keeps the previous wmill token when bootstrap issued none", () => {
    const previous = {
      wmill_token: {
        issued_at: "2026-06-01T00:00:00.000Z",
        expires_at: "2026-11-28T00:00:00.000Z",
      },
    };
    expect(
      buildCredentialExpiryRecord(
        input({ previous, wmillTokenIssued: false }),
        NOW,
      ).wmill_token,
    ).toEqual(previous.wmill_token);
  });

  test("keeps the window of an unchanged OAuth token", () => {
    const previous = {
      claude_oauth_token: {
        issued_at: "2026-01-01T00:00:00.000Z",
        expires_at: "2027-01-01T00:00:00.000Z",
        fingerprint: "abc123",
      },
    };
    expect(
      buildCredentialExpiryRecord(input({ previous }), NOW).claude_oauth_token,
    ).toEqual(previous.claude_oauth_token);
  });

  test("keeps the issue date of an unchanged OAuth token when the lifetime changes", () => {
    const previous = {
      claude_oauth_token: {
        issued_at: "2026-01-01T00:00:00.000Z",
        expires_at: "2027-01-01T00:00:00.000Z",
        fingerprint: "abc123",
      },
    };
    expect(
      buildCredentialExpiryRecord(input({ previous, claudeTokenDays: 30 }), NOW)
        .claude_oauth_token,
    ).toEqual({
      issued_at: "2026-01-01T00:00:00.000Z",
      expires_at: "2026-01-31T00:00:00.000Z",
      fingerprint: "abc123",
    });
  });

  test("starts a changed OAuth token today", () => {
    const previous = {
      claude_oauth_token: {
        issued_at: "2026-01-01T00:00:00.000Z",
        expires_at: "2027-01-01T00:00:00.000Z",
        fingerprint: "old",
      },
    };
    expect(
      buildCredentialExpiryRecord(input({ previous }), NOW).claude_oauth_token
        ?.issued_at,
    ).toBe("2026-11-05T00:00:00.000Z");
  });

  test("uses the configured lifetime of the OAuth token", () => {
    expect(
      buildCredentialExpiryRecord(input({ claudeTokenDays: 30 }), NOW)
        .claude_oauth_token?.expires_at,
    ).toBe("2026-12-05T00:00:00.000Z");
  });

  test("records no OAuth token when none is set", () => {
    expect(
      buildCredentialExpiryRecord(input({ claudeFingerprint: null }), NOW)
        .claude_oauth_token,
    ).toBeUndefined();
  });

  test("records the expiry of the PAT", () => {
    expect(
      buildCredentialExpiryRecord(
        input({ githubTokenExpiresAt: "2027-01-01T00:00:00.000Z" }),
        NOW,
      ).github_token,
    ).toEqual({ expires_at: "2027-01-01T00:00:00.000Z" });
  });

  test("leaves out a read token whose expiry is unknown", () => {
    expect(
      buildCredentialExpiryRecord(
        input({
          readTokenExpiresAt: {
            acme: "2027-01-01T00:00:00.000Z",
            octo: null,
          },
        }),
        NOW,
      ).github_read_tokens,
    ).toEqual({ acme: { expires_at: "2027-01-01T00:00:00.000Z" } });
  });

  test("records the expiry of the interaction limits", () => {
    expect(
      buildCredentialExpiryRecord(
        input({ interactionLimitsExpiresAt: "2027-01-01T00:00:00.000Z" }),
        NOW,
      ).interaction_limits,
    ).toEqual({ expires_at: "2027-01-01T00:00:00.000Z" });
  });
});
