import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync("scripts/bootstrap.sh", "utf8");

describe("bootstrap.sh and the heartbeat url", () => {
  test("stores the heartbeat url as a secret variable", () => {
    expect(source).toContain('upsert_variable "f/factory/heartbeat_url"');
  });

  test("takes the url from HEARTBEAT_URL", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bootstrap.shのシェルの展開と照合する文字列である
    expect(source).toContain('HEARTBEAT_URL="${HEARTBEAT_URL:-}"');
  });

  test("describes seven secret variables", () => {
    expect(source).toContain("7つの秘密の変数");
  });
});

describe("mise.local.toml.example", () => {
  test("lists HEARTBEAT_URL", () => {
    expect(readFileSync("mise.local.toml.example", "utf8")).toMatch(
      /^HEARTBEAT_URL = ""$/m,
    );
  });
});
