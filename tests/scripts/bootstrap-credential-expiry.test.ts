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
      '"${credential_expiry_previous}" "${github_read_tokens_json}"',
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

  test("does not read the OAuth token back through the wmill CLI", () => {
    expect(source).not.toContain("variable get f/factory/claude_oauth_token");
  });

  test("does not pass an OAuth change flag to the host script", () => {
    expect(source).not.toContain("CREDENTIAL_CLAUDE_TOKEN_CHANGED");
  });
});

describe("bootstrap.sh and a host script that fails", () => {
  test("runs the host script in a condition so a crash does not abort", () => {
    expect(source).toContain('credential_expiry_json="$(credential_expiry_run');
  });

  test("accepts only a JSON object from the host script", () => {
    expect(source).toContain(`jq -e 'type == "object"'`);
  });

  test("keeps the previous record when the host script fails", () => {
    expect(source).toContain(
      "could not collect the credential expiry; keeping the previous record",
    );
  });

  test("writes the record only when the host script succeeded", () => {
    const start = source.indexOf(
      'credential_expiry_json="$(credential_expiry_run',
    );
    const write = source.indexOf(
      'upsert_variable "f/factory/credential_expiry"',
    );
    const warning = source.indexOf("could not collect the credential expiry");
    expect([start < write, write < warning]).toEqual([true, true]);
  });

  test("reads the previous record without aborting on a failed request", () => {
    expect(source).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: bootstrap.shのシェルの展開と照合する文字列である
      'credential_status="$(api_get "/w/${WORKSPACE}/variables/get/f/factory/credential_expiry" || true)"',
    );
  });
});

describe("bootstrap.sh and a previous record that cannot be read", () => {
  test("keeps the previous record when the read status is neither 200 nor 404", () => {
    expect(source).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: bootstrap.shのシェルの展開と照合する文字列である
      'if [ "${credential_status}" != "200" ] && [ "${credential_status}" != "404" ]; then',
    );
  });

  test("warns with the read status", () => {
    expect(source).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: bootstrap.shのシェルの展開と照合する文字列である
      "could not read the previous credential expiry (status ${credential_status}); keeping the previous record",
    );
  });

  test("checks the read status before collecting the record", () => {
    const check = source.indexOf(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: bootstrap.shのシェルの展開と照合する文字列である
      'if [ "${credential_status}" != "200" ] && [ "${credential_status}" != "404" ]; then',
    );
    const collect = source.indexOf(
      'elif credential_expiry_json="$(credential_expiry_run',
    );
    expect([check >= 0, check < collect]).toEqual([true, true]);
  });
});

describe("bootstrap.sh and the environment of the host script", () => {
  const body =
    /credential_expiry_run\(\) \{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";

  test.each([
    'export CREDENTIAL_EXPIRY_PREVIOUS="$1"',
    'export CREDENTIAL_READ_TOKENS="$2"',
    "export CREDENTIAL_WMILL_TOKEN_ISSUED=1",
    "export GITHUB_TOKEN CLAUDE_CODE_OAUTH_TOKEN",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bootstrap.shのシェルの展開と照合する文字列である
    'export INTERACTION_LIMITS_REPO="${INTERACTION_LIMITS_REPO:-}"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bootstrap.shのシェルの展開と照合する文字列である
    'export INTERACTION_LIMITS_EXPIRES_AT="${INTERACTION_LIMITS_EXPIRES_AT:-}"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bootstrap.shのシェルの展開と照合する文字列である
    'export CLAUDE_OAUTH_TOKEN_DAYS="${CLAUDE_OAUTH_TOKEN_DAYS:-}"',
  ])("has the line: %s", (line) => {
    expect(body).toContain(line);
  });

  test("calls the function in a command substitution so the exports stay in it", () => {
    expect(source).toContain('$(credential_expiry_run "');
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
