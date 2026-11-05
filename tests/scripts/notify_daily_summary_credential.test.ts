import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { NOTICE_SEVERITY } from "../../f/factory/lib/console_support.ts";

const source = readFileSync("f/factory/notify_daily_summary.ts", "utf8");
const mainBody = source.slice(source.indexOf("export async function main"));

describe("the daily summary and the credential expiry", () => {
  test("checks the expiry before the summary", () => {
    expect(mainBody.indexOf("checkCredentialExpiry(")).toBeLessThan(
      mainBody.indexOf("runDailySummary("),
    );
  });

  test("reads the record by its literal path", () => {
    expect(mainBody).toContain(
      'wmill.getVariable("f/factory/credential_expiry")',
    );
  });

  test("uses the configured number of days", () => {
    expect(mainBody).toContain("warnDays: config.credential_warn_days");
  });

  test("bounds the record read and the notice list with withCallTimeout", () => {
    const call = mainBody.slice(
      mainBody.indexOf("checkCredentialExpiry("),
      mainBody.indexOf("runDailySummary("),
    );
    expect(call.match(/withCallTimeout\(/g)?.length).toBe(2);
  });

  test("treats the notice as one that needs a person", () => {
    expect(NOTICE_SEVERITY.credential_expiring).toBe("action");
  });
});
