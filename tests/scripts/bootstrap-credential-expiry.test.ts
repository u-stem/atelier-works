import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseWmillExcludes } from "../../f/factory/lib/freezes.ts";

const source = readFileSync("scripts/bootstrap.sh", "utf8");

describe("bootstrap.sh and the credential expiry", () => {
  test("collects the record with the host script", () => {
    expect(source).toContain("bun ./scripts/credential_expiry.ts");
  });

  test("passes the read token map through the environment", () => {
    expect(source).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: bootstrap.shのシェルの展開と照合する文字列である
      'CREDENTIAL_READ_TOKENS="${github_read_tokens_json}"',
    );
  });

  test("stores the record as a variable that is not secret", () => {
    expect(source).toMatch(
      /upsert_variable "f\/factory\/credential_expiry"[^\n]*\\\n[^\n]*"false"/,
    );
  });

  test("lets the update keep a variable that is not secret", () => {
    expect(source).toMatch(
      /variable_update_body\(\) \{[\s\S]*?WM_TMP_IS_SECRET[\s\S]*?\n\}/,
    );
  });

  test("reads the current OAuth token with the wmill CLI", () => {
    expect(source).toContain(
      "run_wmill variable get f/factory/claude_oauth_token --json",
    );
  });

  test("reads the current OAuth token before bootstrap overwrites it", () => {
    expect(
      source.indexOf("run_wmill variable get f/factory/claude_oauth_token"),
    ).toBeLessThan(
      source.indexOf('upsert_variable "f/factory/claude_oauth_token"'),
    );
  });

  test("passes whether the OAuth token changed through the environment", () => {
    expect(source).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: bootstrap.shのシェルの展開と照合する文字列である
      'CREDENTIAL_CLAUDE_TOKEN_CHANGED="${claude_token_changed}"',
    );
  });
});

describe("wmill.yaml", () => {
  test("keeps the credential expiry record out of the sync", async () => {
    const parsed = parseWmillExcludes(await Bun.file("wmill.yaml").text());
    expect(parsed.ok ? parsed.value : []).toContain(
      "f/factory/credential_expiry.variable.yaml",
    );
  });
});

describe("mise.local.toml.example", () => {
  const example = readFileSync("mise.local.toml.example", "utf8");

  test.each([
    "INTERACTION_LIMITS_EXPIRES_AT",
    "INTERACTION_LIMITS_REPO",
    "CLAUDE_OAUTH_TOKEN_DAYS",
  ])("lists %s", (key) => {
    expect(example).toMatch(new RegExp(`^${key} = ""$`, "m"));
  });
});
