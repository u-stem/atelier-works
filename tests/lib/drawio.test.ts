import { describe, expect, test } from "bun:test";
import { validateDrawioXml } from "../../f/factory/lib/drawio.ts";

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

  test("rejects a document over 256KB", () => {
    const bigXml = MINIMAL_VALID_XML.replace(
      'value="start"',
      `value="${"x".repeat(257 * 1024)}"`,
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
