import { describe, expect, test } from "bun:test";
import { inflateRawSync } from "node:zlib";
import {
  renderIssueSection,
  toViewerUrl,
  validateDrawioXml,
} from "../../f/factory/lib/drawio.ts";

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

describe("renderIssueSection", () => {
  test("returns an empty string for no diagrams", () => {
    const section = renderIssueSection([]);
    expect(section).toBe("");
  });

  test("renders a link for a valid diagram", () => {
    const section = renderIssueSection([
      { name: "sample", drawio_xml: MINIMAL_VALID_XML },
    ]);
    expect(section).toContain("[sample](");
  });

  test("renders a validation-failure message for an invalid diagram", () => {
    const section = renderIssueSection([
      { name: "broken", drawio_xml: "<svg></svg>" },
    ]);
    expect(section).toContain("図の検証に失敗しました");
  });

  test("replaces a name that breaks the markdown link syntax with a safe placeholder", () => {
    const section = renderIssueSection([
      { name: "sample](javascript:alert(1))[", drawio_xml: MINIMAL_VALID_XML },
    ]);
    expect(section).toContain("[diagram-0](");
  });

  test("replaces an uppercase/invalid-character name with a safe placeholder", () => {
    const section = renderIssueSection([
      { name: "Not Valid!", drawio_xml: MINIMAL_VALID_XML },
    ]);
    expect(section).toContain("[diagram-0](");
  });

  test("keeps a name that already matches [a-z0-9-]{1,64}", () => {
    const section = renderIssueSection([
      { name: "issue-intake-flow", drawio_xml: MINIMAL_VALID_XML },
    ]);
    expect(section).toContain("[issue-intake-flow](");
  });

  test("indexes safe placeholders by position across multiple diagrams", () => {
    const section = renderIssueSection([
      { name: "ok-one", drawio_xml: MINIMAL_VALID_XML },
      { name: "Not Valid!", drawio_xml: MINIMAL_VALID_XML },
    ]);
    expect(section).toContain("[diagram-1](");
  });
});
