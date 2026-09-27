import { describe, expect, test } from "bun:test";
import { inflateRawSync } from "node:zlib";
import { toViewerUrl, validateDrawioXml } from "../../f/factory/lib/drawio.ts";

const MINIMAL_VALID_XML = [
  '<mxfile host="app.diagrams.net">',
  '  <diagram name="sample" id="d1">',
  '    <mxGraphModel dx="800" dy="600">',
  "      <root>",
  '        <mxCell id="0" />',
  '        <mxCell id="1" parent="0" />',
  '        <mxCell id="n1" value="start" vertex="1" parent="1">',
  '          <mxGeometry x="40" y="40" width="160" height="60" as="geometry" />',
  "        </mxCell>",
  "      </root>",
  "    </mxGraphModel>",
  "  </diagram>",
  "</mxfile>",
].join("\n");

describe("validateDrawioXml", () => {
  test("accepts a minimal valid mxfile document", () => {
    const result = validateDrawioXml(MINIMAL_VALID_XML);
    expect(result.valid).toBe(true);
  });

  test("rejects a document whose root element is not <mxfile>", () => {
    const result = validateDrawioXml("<svg></svg>");
    expect(result.valid).toBe(false);
  });

  test('rejects a document with compressed="true"', () => {
    const xml = MINIMAL_VALID_XML.replace(
      '<mxfile host="app.diagrams.net">',
      '<mxfile host="app.diagrams.net" compressed="true">',
    );
    const result = validateDrawioXml(xml);
    expect(result.valid).toBe(false);
  });

  test("rejects a document with no <diagram> element", () => {
    const result = validateDrawioXml(
      '<mxfile host="app.diagrams.net"></mxfile>',
    );
    expect(result.valid).toBe(false);
  });

  test("rejects a document over 12KB", () => {
    const bigXml = MINIMAL_VALID_XML.replace(
      'value="start"',
      `value="${"x".repeat(13 * 1024)}"`,
    );
    const result = validateDrawioXml(bigXml);
    expect(result.valid).toBe(false);
  });

  test("rejects a compressed-looking (base64 blob) diagram body", () => {
    const xml = [
      '<mxfile host="app.diagrams.net">',
      '  <diagram name="sample" id="d1">',
      "    dGhpcyBpcyBub3QgeG1s",
      "  </diagram>",
      "</mxfile>",
    ].join("\n");
    const result = validateDrawioXml(xml);
    expect(result.valid).toBe(false);
  });
});

describe("toViewerUrl", () => {
  test("emits a standard base64 fragment that the viewer can pass to atob directly", () => {
    const url = toViewerUrl(MINIMAL_VALID_XML);
    const fragment = (url ?? "").split("#R")[1] ?? "";
    // viewer.diagrams.net decodes `#R<data>` with atob(): URL-safe base64
    // (`-`, `_`, stripped padding) makes it fail with "not correctly encoded".
    expect(() => atob(fragment)).not.toThrow();
  });

  test("round-trips through inflateRawSync back to the original XML", () => {
    const url = toViewerUrl(MINIMAL_VALID_XML);
    const fragment = (url ?? "").split("#R")[1] ?? "";
    const base64 = fragment.replace(/-/g, "+").replace(/_/g, "/");
    const inflated = inflateRawSync(Buffer.from(base64, "base64")).toString(
      "utf8",
    );
    expect(decodeURIComponent(inflated)).toBe(MINIMAL_VALID_XML);
  });

  test("returns a URL containing the #R fragment marker for a small diagram", () => {
    const url = toViewerUrl(MINIMAL_VALID_XML);
    expect(url).toContain("#R");
  });

  test("returns null when the encoded fragment exceeds 8KB", () => {
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const randomBytes = new Uint8Array(11 * 1024);
    crypto.getRandomValues(randomBytes);
    let blob = "";
    for (const byte of randomBytes) {
      blob += alphabet[byte % alphabet.length];
    }
    const bigXml = MINIMAL_VALID_XML.replace(
      'value="start"',
      `value="${blob}"`,
    );
    const url = toViewerUrl(bigXml);
    expect(url).toBeNull();
  });
});
