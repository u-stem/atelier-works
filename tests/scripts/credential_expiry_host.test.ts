import { describe, expect, test } from "bun:test";
import { parseCredentialExpiry } from "../../f/factory/lib/credential_expiry.ts";
import {
  collectCredentialExpiry,
  configuredExpiresAt,
  type GitHubFetch,
  interactionLimitsExpiresAt,
  parseDays,
  readTokenMap,
  sha256Fingerprint,
  tokenExpiresAt,
} from "../../scripts/credential_expiry.ts";

const NOW = new Date("2026-11-05T00:00:00.000Z");
const TOKEN = "github_pat_TESTVALUE0123456789abcdef";
const READ_TOKEN = "github_pat_READVALUE0123456789abcdef";
const OAUTH_TOKEN = "sk-ant-oat01-value";

type Seen = { readonly url: string; readonly init: RequestInit };

function github(
  answers: Readonly<Record<string, Response>>,
  seen: Seen[] = [],
): GitHubFetch {
  return async (url, init) => {
    seen.push({ url, init });
    return answers[url] ?? new Response(null, { status: 404 });
  };
}

function expiring(at: string): Response {
  return new Response("{}", {
    status: 200,
    headers: { "github-authentication-token-expiration": at },
  });
}

/** 呼ばれるたびに新しい応答を返す。`/user`は期限のヘッダー付き、interaction-limitsは期限付き。 */
function freshGithub(seen: Seen[] = []): GitHubFetch {
  return async (url, init) => {
    seen.push({ url, init });
    if (url === "https://api.github.com/user") {
      return expiring("2027-01-01 00:00:00 UTC");
    }
    if (url.endsWith("/interaction-limits")) {
      return Response.json({ expires_at: "2027-02-01T00:00:00Z" });
    }
    return new Response(null, { status: 404 });
  };
}

function previousWindow(fingerprint: string): string {
  return JSON.stringify({
    claude_oauth_token: {
      issued_at: "2026-01-01T00:00:00.000Z",
      expires_at: "2027-01-01T00:00:00.000Z",
      fingerprint,
    },
  });
}

describe("tokenExpiresAt", () => {
  test("reads the expiry header of GET /user", async () => {
    const fetchImpl = github({
      "https://api.github.com/user": expiring("2027-01-01 00:00:00 UTC"),
    });
    expect(await tokenExpiresAt(TOKEN, fetchImpl)).toEqual({
      kind: "expires",
      at: "2027-01-01T00:00:00.000Z",
    });
  });

  test("sends the token in the authorization header", async () => {
    const seen: Seen[] = [];
    await tokenExpiresAt(TOKEN, github({}, seen));
    expect(new Headers(seen[0]?.init.headers).get("authorization")).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  test("returns none for a token without an expiry", async () => {
    const fetchImpl = github({
      "https://api.github.com/user": new Response("{}", { status: 200 }),
    });
    expect(await tokenExpiresAt(TOKEN, fetchImpl)).toEqual({ kind: "none" });
  });

  test("returns unknown when GitHub refuses the token", async () => {
    expect(await tokenExpiresAt(TOKEN, github({}))).toEqual({
      kind: "unknown",
    });
  });

  test("returns unknown when GitHub answers with a server error", async () => {
    const fetchImpl = github({
      "https://api.github.com/user": new Response(null, { status: 503 }),
    });
    expect(await tokenExpiresAt(TOKEN, fetchImpl)).toEqual({
      kind: "unknown",
    });
  });

  test("returns unknown when the request throws", async () => {
    const fetchImpl: GitHubFetch = async () => {
      throw new Error("network failure");
    };
    expect(await tokenExpiresAt(TOKEN, fetchImpl)).toEqual({
      kind: "unknown",
    });
  });

  test("returns unknown when the expiry header cannot be read", async () => {
    const fetchImpl = github({
      "https://api.github.com/user": expiring("tomorrow"),
    });
    expect(await tokenExpiresAt(TOKEN, fetchImpl)).toEqual({
      kind: "unknown",
    });
  });

  test("returns none for an empty token", async () => {
    expect(await tokenExpiresAt("", github({}))).toEqual({ kind: "none" });
  });

  test("does not call GitHub for an empty token", async () => {
    const seen: Seen[] = [];
    await tokenExpiresAt("", github({}, seen));
    expect(seen.length).toBe(0);
  });
});

describe("interactionLimitsExpiresAt", () => {
  test("reads expires_at of the interaction limits", async () => {
    const fetchImpl = github({
      "https://api.github.com/repos/acme/factory/interaction-limits":
        Response.json({ expires_at: "2027-01-01T00:00:00Z" }),
    });
    expect(
      await interactionLimitsExpiresAt("acme/factory", TOKEN, fetchImpl),
    ).toBe("2027-01-01T00:00:00.000Z");
  });

  test("returns null when the token may not read them", async () => {
    expect(
      await interactionLimitsExpiresAt("acme/factory", TOKEN, github({})),
    ).toBeNull();
  });

  test("does not call GitHub for a repository that is not owner/name", async () => {
    const seen: Seen[] = [];
    await interactionLimitsExpiresAt("../user", TOKEN, github({}, seen));
    expect(seen.length).toBe(0);
  });
});

describe("the settings from mise.local.toml", () => {
  test("reads a date as midnight JST", () => {
    expect(configuredExpiresAt("2027-01-01")).toBe("2026-12-31T15:00:00.000Z");
  });

  test("ignores an empty date", () => {
    expect(configuredExpiresAt("")).toBeNull();
  });

  test("reads the lifetime of the OAuth token", () => {
    expect(parseDays("90", 365)).toBe(90);
  });

  test("falls back for a lifetime that is not a positive integer", () => {
    expect(parseDays("-1", 365)).toBe(365);
  });

  test("reads the read token map", () => {
    expect(readTokenMap(JSON.stringify({ acme: TOKEN }))).toEqual({
      acme: TOKEN,
    });
  });

  test("reads an empty read token map as empty", () => {
    expect(readTokenMap("")).toEqual({});
  });
});

describe("sha256Fingerprint", () => {
  test("is 16 hex characters", () => {
    expect(sha256Fingerprint(OAUTH_TOKEN)).toMatch(/^[0-9a-f]{16}$/);
  });

  test("does not contain the token", () => {
    expect(sha256Fingerprint(OAUTH_TOKEN)).not.toContain("value");
  });
});

describe("collectCredentialExpiry", () => {
  test("writes a record that holds no token", async () => {
    const text = await collectCredentialExpiry(
      {
        GITHUB_TOKEN: TOKEN,
        CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN,
        CREDENTIAL_WMILL_TOKEN_ISSUED: "1",
      },
      github({
        "https://api.github.com/user": expiring("2027-01-01 00:00:00 UTC"),
      }),
      NOW,
    );
    expect(text).not.toContain("TESTVALUE");
  });

  test("falls back to the configured date of the interaction limits", async () => {
    const text = await collectCredentialExpiry(
      {
        INTERACTION_LIMITS_REPO: "acme/factory",
        INTERACTION_LIMITS_EXPIRES_AT: "2027-01-01",
        GITHUB_TOKEN: TOKEN,
      },
      github({}),
      NOW,
    );
    expect(JSON.parse(text).interaction_limits).toEqual({
      expires_at: "2026-12-31T15:00:00.000Z",
    });
  });

  test("starts the window today for an OAuth token whose fingerprint changed", async () => {
    const text = await collectCredentialExpiry(
      {
        CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN,
        CREDENTIAL_EXPIRY_PREVIOUS: previousWindow("old"),
      },
      github({}),
      NOW,
    );
    expect(JSON.parse(text).claude_oauth_token.issued_at).toBe(
      "2026-11-05T00:00:00.000Z",
    );
  });

  test("writes a record that the daily check reads without a problem", async () => {
    const text = await collectCredentialExpiry(
      {
        GITHUB_TOKEN: TOKEN,
        CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN,
        CREDENTIAL_WMILL_TOKEN_ISSUED: "1",
        CREDENTIAL_READ_TOKENS: JSON.stringify({ acme: READ_TOKEN }),
        INTERACTION_LIMITS_REPO: "acme/factory",
      },
      freshGithub(),
      NOW,
    );
    expect(parseCredentialExpiry(text)).toEqual({
      record: {
        wmill_token: {
          issued_at: "2026-11-05T00:00:00.000Z",
          expires_at: "2027-05-04T00:00:00.000Z",
        },
        claude_oauth_token: {
          issued_at: "2026-11-05T00:00:00.000Z",
          expires_at: "2027-11-05T00:00:00.000Z",
          fingerprint: sha256Fingerprint(OAUTH_TOKEN),
        },
        github_token: { expires_at: "2027-01-01T00:00:00.000Z" },
        github_read_tokens: {
          acme: { expires_at: "2027-01-01T00:00:00.000Z" },
        },
        interaction_limits: { expires_at: "2027-02-01T00:00:00.000Z" },
      },
      problems: [],
      kept: [],
      unreadable: false,
    });
  });

  test("asks GitHub once for a token that several owners share", async () => {
    const seen: Seen[] = [];
    await collectCredentialExpiry(
      {
        CREDENTIAL_READ_TOKENS: JSON.stringify({
          acme: READ_TOKEN,
          octo: READ_TOKEN,
        }),
      },
      freshGithub(seen),
      NOW,
    );
    expect(seen.length).toBe(1);
  });

  test("records the expiry of every owner that shares a token", async () => {
    const text = await collectCredentialExpiry(
      {
        CREDENTIAL_READ_TOKENS: JSON.stringify({
          acme: READ_TOKEN,
          octo: READ_TOKEN,
        }),
      },
      freshGithub(),
      NOW,
    );
    expect(Object.keys(JSON.parse(text).github_read_tokens)).toEqual([
      "acme",
      "octo",
    ]);
  });

  test("keeps the window of an OAuth token whose fingerprint is unchanged", async () => {
    const previous = previousWindow(sha256Fingerprint(OAUTH_TOKEN));
    const text = await collectCredentialExpiry(
      {
        CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN,
        CREDENTIAL_EXPIRY_PREVIOUS: previous,
      },
      github({}),
      NOW,
    );
    expect(JSON.parse(text).claude_oauth_token).toEqual(
      JSON.parse(previous).claude_oauth_token,
    );
  });
});

describe("collectCredentialExpiry when the expiry of a token cannot be read", () => {
  const previousTokens = JSON.stringify({
    github_token: { expires_at: "2026-12-01T00:00:00.000Z" },
    github_read_tokens: { acme: { expires_at: "2026-12-02T00:00:00.000Z" } },
  });
  const unavailable: GitHubFetch = async () =>
    new Response(null, { status: 503 });
  const noExpiry: GitHubFetch = async () => new Response("{}", { status: 200 });

  test("keeps the previous entry of github_token", async () => {
    const text = await collectCredentialExpiry(
      { GITHUB_TOKEN: TOKEN, CREDENTIAL_EXPIRY_PREVIOUS: previousTokens },
      unavailable,
      NOW,
      () => {},
    );
    expect(JSON.parse(text).github_token).toEqual({
      expires_at: "2026-12-01T00:00:00.000Z",
    });
  });

  test("keeps the previous entry of the same owner of github_read_tokens", async () => {
    const text = await collectCredentialExpiry(
      {
        CREDENTIAL_READ_TOKENS: JSON.stringify({ acme: READ_TOKEN }),
        CREDENTIAL_EXPIRY_PREVIOUS: previousTokens,
      },
      unavailable,
      NOW,
      () => {},
    );
    expect(JSON.parse(text).github_read_tokens).toEqual({
      acme: { expires_at: "2026-12-02T00:00:00.000Z" },
    });
  });

  test("omits github_token when there is no previous entry", async () => {
    const text = await collectCredentialExpiry(
      { GITHUB_TOKEN: TOKEN },
      unavailable,
      NOW,
      () => {},
    );
    expect(JSON.parse(text).github_token).toBeUndefined();
  });

  test("omits an owner that has no previous entry", async () => {
    const text = await collectCredentialExpiry(
      {
        CREDENTIAL_READ_TOKENS: JSON.stringify({ octo: READ_TOKEN }),
        CREDENTIAL_EXPIRY_PREVIOUS: previousTokens,
      },
      unavailable,
      NOW,
      () => {},
    );
    expect(JSON.parse(text).github_read_tokens).toBeUndefined();
  });

  test("warns about github_token", async () => {
    const warnings: string[] = [];
    await collectCredentialExpiry(
      { GITHUB_TOKEN: TOKEN },
      unavailable,
      NOW,
      (line) => warnings.push(line),
    );
    expect(warnings).toEqual([
      "credential_expiry: could not read the expiry of github_token; keeping the previous record",
    ]);
  });

  test("warns about the owner of github_read_tokens", async () => {
    const warnings: string[] = [];
    await collectCredentialExpiry(
      { CREDENTIAL_READ_TOKENS: JSON.stringify({ acme: READ_TOKEN }) },
      unavailable,
      NOW,
      (line) => warnings.push(line),
    );
    expect(warnings).toEqual([
      "credential_expiry: could not read the expiry of github_read_tokens.acme; keeping the previous record",
    ]);
  });

  test("writes the warning to the standard error by default", async () => {
    const original = process.stderr.write;
    const written: string[] = [];
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    };
    try {
      await collectCredentialExpiry({ GITHUB_TOKEN: TOKEN }, unavailable, NOW);
    } finally {
      process.stderr.write = original;
    }
    expect(written.join("")).toContain("could not read the expiry");
  });

  test("does not warn for a token without an expiry", async () => {
    const warnings: string[] = [];
    await collectCredentialExpiry(
      { GITHUB_TOKEN: TOKEN, CREDENTIAL_EXPIRY_PREVIOUS: previousTokens },
      noExpiry,
      NOW,
      (line) => warnings.push(line),
    );
    expect(warnings).toEqual([]);
  });

  test("drops the previous entry of a token without an expiry", async () => {
    const text = await collectCredentialExpiry(
      { GITHUB_TOKEN: TOKEN, CREDENTIAL_EXPIRY_PREVIOUS: previousTokens },
      noExpiry,
      NOW,
      () => {},
    );
    expect(JSON.parse(text).github_token).toBeUndefined();
  });
});
