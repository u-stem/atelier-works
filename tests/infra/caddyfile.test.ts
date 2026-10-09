import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// drawio.htmlだけに付けるヘッダーを静的に確かめる。
// 図を描くページのCSPは外への取得を止める要なので、Caddyfileの編集で崩れたらここで落とす。
const CADDYFILE = readFileSync(
  join(import.meta.dir, "../../infra/Caddyfile"),
  "utf8",
);

function snippet(name: string): string {
  const start = CADDYFILE.indexOf(`(${name}) {`);
  if (start < 0) return "";
  const end = CADDYFILE.indexOf("\n}\n", start);
  return CADDYFILE.slice(start, end);
}

const drawioHeaders = snippet("drawio_headers");

describe("drawio_headers", () => {
  test("makes the page an opaque origin even when opened directly", () => {
    expect(drawioHeaders).toContain('sandbox allow-scripts"');
  });

  test("does not allow eval", () => {
    expect(drawioHeaders).not.toContain("unsafe-eval");
  });

  test("blocks every outgoing connection", () => {
    expect(drawioHeaders).toContain("connect-src 'none'");
  });

  test("starts from default-src none", () => {
    expect(drawioHeaders).toContain("default-src 'none';");
  });

  test("allows embedding only from the same origin", () => {
    expect(drawioHeaders).toContain("frame-ancestors 'self'");
  });

  test("sends X-Frame-Options SAMEORIGIN for browsers that ignore frame-ancestors", () => {
    expect(drawioHeaders).toContain('X-Frame-Options "SAMEORIGIN"');
  });
});

describe("Caddyfile routes", () => {
  test("serves drawio.html before the general console route", () => {
    expect(CADDYFILE.indexOf("handle /console/drawio.html")).toBeLessThan(
      CADDYFILE.indexOf("handle_path /console/*"),
    );
  });
});
