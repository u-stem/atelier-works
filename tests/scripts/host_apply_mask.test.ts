import { describe, expect, test } from "bun:test";
import {
  collectMaskValues,
  MASK_MIN_LENGTH,
  maskSecrets,
} from "../../scripts/host_apply/mask.ts";

const LOCAL = `
[env]
DB_PASSWORD = "very-secret-db-password"
WM_ADMIN_EMAIL = "admin@example.invalid"
WM_ADMIN_PASSWORD = "admin-pw-123456"
GITHUB_TOKEN = "ghp_abcdefghijklmnop"
SHORT = "abc"
EMPTY = ""
NOT_STRING = 12345678901
`;

describe("collectMaskValues", () => {
  test("collects the value of every key in [env]", () => {
    expect(collectMaskValues(LOCAL).sort()).toEqual(
      [
        "very-secret-db-password",
        "admin@example.invalid",
        "admin-pw-123456",
        "ghp_abcdefghijklmnop",
      ].sort(),
    );
  });

  test("leaves out values shorter than the minimum", () => {
    expect(collectMaskValues(LOCAL)).not.toContain("abc");
  });

  test("has a minimum length of eight", () => {
    expect(MASK_MIN_LENGTH).toBe(8);
  });

  test("returns nothing for text that is not TOML", () => {
    expect(collectMaskValues("a = [")).toEqual([]);
  });

  test("returns nothing when [env] is missing", () => {
    expect(collectMaskValues('[tools]\nbun = "1.4.2"\n')).toEqual([]);
  });
});

describe("maskSecrets", () => {
  const values = collectMaskValues(LOCAL);

  test("hides a secret value in the output", () => {
    expect(maskSecrets("login with very-secret-db-password ok", values)).toBe(
      "login with *** ok",
    );
  });

  test("hides every occurrence", () => {
    expect(
      maskSecrets("ghp_abcdefghijklmnop and ghp_abcdefghijklmnop", values),
    ).toBe("*** and ***");
  });

  test("hides the value of every key in mise.local.toml", () => {
    const text = values.join(" | ");
    expect(maskSecrets(text, values)).toBe(values.map(() => "***").join(" | "));
  });

  test("hides the longer value first when one contains the other", () => {
    expect(
      maskSecrets("abcdefgh12345678", ["abcdefgh", "abcdefgh12345678"]),
    ).toBe("***");
  });

  test("leaves text without secrets unchanged", () => {
    expect(maskSecrets("Container infra-db-1 Running", values)).toBe(
      "Container infra-db-1 Running",
    );
  });

  test("ignores a short value instead of masking every occurrence of it", () => {
    expect(maskSecrets("abc abc", ["abc"])).toBe("abc abc");
  });

  test("does not treat a value as a pattern", () => {
    expect(
      maskSecrets("a.b.c.d.e.f.g.h axbxcxdxexfxgxh", ["a.b.c.d.e.f.g.h"]),
    ).toBe("*** axbxcxdxexfxgxh");
  });
});
