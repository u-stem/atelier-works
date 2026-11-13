import { describe, expect, test } from "bun:test";
import {
  buildCredentialExpiryRecord,
  CREDENTIAL_EXPIRING_NOTICE_KIND,
  type CredentialExpiryDeps,
  type CredentialRecordInput,
  checkCredentialExpiry,
  credentialDeadlines,
  credentialNoticeMessage,
  isExpiringSoon,
  jstDateLabel,
  parseCredentialExpiry,
  tokenExpirationFromHeader,
} from "../../f/factory/lib/credential_expiry.ts";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import { logger } from "../../f/factory/lib/log.ts";
import type { NoticeRecord } from "../../f/factory/lib/types.ts";

const NOW = new Date("2026-11-05T00:00:00.000Z");
const SOON = "2026-11-20T00:00:00.000Z";
const LATER = "2027-06-01T00:00:00.000Z";

describe("parseCredentialExpiry", () => {
  test("reads a missing record as empty", () => {
    expect(parseCredentialExpiry(null).record).toEqual({});
  });

  test("calls a record that is not JSON unreadable", () => {
    expect(parseCredentialExpiry("{not json").unreadable).toBe(true);
  });

  test("reads the window of the wmill token", () => {
    const parsed = parseCredentialExpiry(
      JSON.stringify({
        wmill_token: {
          issued_at: "2026-06-01T00:00:00.000Z",
          expires_at: SOON,
        },
      }),
    );
    expect(parsed.record.wmill_token?.expires_at).toBe(SOON);
  });

  test("drops an entry whose expiry is not a time", () => {
    const parsed = parseCredentialExpiry(
      JSON.stringify({ github_token: { expires_at: "soon" } }),
    );
    expect(parsed.record.github_token).toBeUndefined();
  });

  test("reports the dropped entry", () => {
    const parsed = parseCredentialExpiry(
      JSON.stringify({ github_token: { expires_at: "soon" } }),
    );
    expect(parsed.problems).toEqual(["github_token is malformed"]);
  });

  test("reads the read tokens by owner", () => {
    const parsed = parseCredentialExpiry(
      JSON.stringify({ github_read_tokens: { acme: { expires_at: SOON } } }),
    );
    expect(parsed.record.github_read_tokens?.acme?.expires_at).toBe(SOON);
  });

  test("drops an owner that is not a GitHub login", () => {
    const parsed = parseCredentialExpiry(
      JSON.stringify({ github_read_tokens: { "a b": { expires_at: SOON } } }),
    );
    expect(parsed.record.github_read_tokens).toEqual({});
  });
});

describe("credentialDeadlines", () => {
  test("names each credential", () => {
    const labels = credentialDeadlines({
      wmill_token: { issued_at: SOON, expires_at: SOON },
      claude_oauth_token: {
        issued_at: SOON,
        expires_at: SOON,
        fingerprint: "f",
      },
      github_token: { expires_at: SOON },
      github_read_tokens: { acme: { expires_at: SOON } },
      interaction_limits: { expires_at: SOON },
    }).map((deadline) => deadline.label);
    expect(labels).toEqual([
      "Windmillのトークン(wmill_token)",
      "Claude CodeのOAuthトークン(claude_oauth_token)",
      "GitHubのPAT(github_token)",
      "読み取り専用のGitHubのPAT(github_read_tokens、acme)",
      "GitHubのinteraction-limits",
    ]);
  });
});

describe("the notice text", () => {
  test("writes the date in JST", () => {
    expect(jstDateLabel(new Date("2026-12-01T16:00:00.000Z"))).toBe(
      "2026-12-02",
    );
  });

  test("writes each part of an invalid date as NaN", () => {
    expect(jstDateLabel(new Date(Number.NaN))).toBe("NaN-NaN-NaN");
  });

  test("names the credential and the date", () => {
    expect(
      credentialNoticeMessage({
        label: "GitHubのPAT(github_token)",
        expiresAt: new Date(SOON),
      }),
    ).toStartWith("GitHubのPAT(github_token)の期限が2026-11-20に切れる。");
  });

  test("does not change from one day to the next", () => {
    const deadline = {
      label: "GitHubのPAT(github_token)",
      expiresAt: new Date(SOON),
    };
    expect(credentialNoticeMessage(deadline)).toBe(
      credentialNoticeMessage({ ...deadline }),
    );
  });
});

describe("isExpiringSoon", () => {
  const deadline = (iso: string) => ({ label: "x", expiresAt: new Date(iso) });

  test("warns exactly 30 days before", () => {
    expect(isExpiringSoon(deadline("2026-12-05T00:00:00.000Z"), NOW, 30)).toBe(
      true,
    );
  });

  test("does not warn 31 days before", () => {
    expect(isExpiringSoon(deadline("2026-12-06T00:00:00.000Z"), NOW, 30)).toBe(
      false,
    );
  });

  test("warns after the expiry", () => {
    expect(isExpiringSoon(deadline("2026-11-01T00:00:00.000Z"), NOW, 30)).toBe(
      true,
    );
  });
});

type Calls = {
  readonly added: NoticeRecord[];
  readonly resolved: string[];
  readonly sent: NotifyEvent[];
};

function deps(
  record: unknown,
  unresolved: readonly string[] = [],
  inserted: number | null = 1,
): { deps: CredentialExpiryDeps; calls: Calls } {
  const calls: Calls = { added: [], resolved: [], sent: [] };
  return {
    calls,
    deps: {
      now: () => NOW,
      warnDays: 30,
      readRecord: async () =>
        typeof record === "string" ? record : JSON.stringify(record),
      listUnresolved: async () => unresolved.map((message) => ({ message })),
      addNotice: async (notice) => {
        calls.added.push(notice);
        return inserted;
      },
      resolveByMessage: async (message) => {
        calls.resolved.push(message);
        return 1;
      },
      notify: async (event) => {
        calls.sent.push(event);
      },
      instanceName: "local",
      log: logger("test", { sink: () => undefined }),
    },
  };
}

const SOON_GITHUB = { github_token: { expires_at: SOON } };
const SOON_MESSAGE = credentialNoticeMessage({
  label: "GitHubのPAT(github_token)",
  expiresAt: new Date(SOON),
});
const ACME_SOON_MESSAGE = credentialNoticeMessage({
  label: "読み取り専用のGitHubのPAT(github_read_tokens、acme)",
  expiresAt: new Date(SOON),
});

describe("checkCredentialExpiry", () => {
  test("adds a notice for a credential that expires soon", async () => {
    const { deps: d, calls } = deps(SOON_GITHUB);
    await checkCredentialExpiry(d);
    expect(calls.added).toEqual([
      { kind: CREDENTIAL_EXPIRING_NOTICE_KIND, message: SOON_MESSAGE },
    ]);
  });

  test("tells Discord about a new notice", async () => {
    const { deps: d, calls } = deps(SOON_GITHUB);
    await checkCredentialExpiry(d);
    expect(calls.sent[0]?.kind).toBe("credential_expiring");
  });

  test("does not tell Discord again while the notice is open", async () => {
    const { deps: d, calls } = deps(SOON_GITHUB, [SOON_MESSAGE], null);
    await checkCredentialExpiry(d);
    expect(calls.sent).toEqual([]);
  });

  test("adds nothing for a credential far from its expiry", async () => {
    const { deps: d, calls } = deps({ github_token: { expires_at: LATER } });
    await checkCredentialExpiry(d);
    expect(calls.added).toEqual([]);
  });

  test("resolves the notice of a renewed credential", async () => {
    const { deps: d, calls } = deps({ github_token: { expires_at: LATER } }, [
      SOON_MESSAGE,
    ]);
    await checkCredentialExpiry(d);
    expect(calls.resolved).toEqual([SOON_MESSAGE]);
  });

  test("keeps the notice of a credential that still expires soon", async () => {
    const { deps: d, calls } = deps(SOON_GITHUB, [SOON_MESSAGE], null);
    await checkCredentialExpiry(d);
    expect(calls.resolved).toEqual([]);
  });

  test("resolves nothing when the record is unreadable", async () => {
    const { deps: d, calls } = deps("{not json", [SOON_MESSAGE]);
    await checkCredentialExpiry(d);
    expect(calls.resolved).toEqual([]);
  });

  test("keeps the notice of a credential whose entry is malformed", async () => {
    const { deps: d, calls } = deps({ github_token: { expires_at: "soon" } }, [
      SOON_MESSAGE,
    ]);
    await checkCredentialExpiry(d);
    expect(calls.resolved).toEqual([]);
  });

  test("keeps the notice of a read token whose entry is malformed", async () => {
    const { deps: d, calls } = deps(
      { github_read_tokens: { acme: { expires_at: "soon" } } },
      [ACME_SOON_MESSAGE],
    );
    await checkCredentialExpiry(d);
    expect(calls.resolved).toEqual([]);
  });

  test("keeps every read token notice when the read tokens are malformed", async () => {
    const { deps: d, calls } = deps({ github_read_tokens: "broken" }, [
      ACME_SOON_MESSAGE,
    ]);
    await checkCredentialExpiry(d);
    expect(calls.resolved).toEqual([]);
  });

  test("still resolves a renewed credential next to a malformed entry", async () => {
    const { deps: d, calls } = deps(
      { github_token: { expires_at: LATER }, wmill_token: "broken" },
      [SOON_MESSAGE],
    );
    await checkCredentialExpiry(d);
    expect(calls.resolved).toEqual([SOON_MESSAGE]);
  });

  test("returns null instead of throwing when the notices cannot be read", async () => {
    const { deps: d } = deps(SOON_GITHUB);
    const failing: CredentialExpiryDeps = {
      ...d,
      listUnresolved: async () => {
        throw new Error("db down");
      },
    };
    expect(await checkCredentialExpiry(failing)).toBeNull();
  });
});

describe("credential_expiry record", () => {
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
        buildCredentialExpiryRecord(input({ previous }), NOW)
          .claude_oauth_token,
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
        buildCredentialExpiryRecord(
          input({ previous, claudeTokenDays: 30 }),
          NOW,
        ).claude_oauth_token,
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
});
