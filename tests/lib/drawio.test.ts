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

function withCellValue(value: string): string {
  return MINIMAL_VALID_XML.replace('value="start"', `value="${value}"`);
}

function withCellAttr(attr: string): string {
  return MINIMAL_VALID_XML.replace('value="start"', `value="start" ${attr}`);
}

function withObjectWrapper(attrs: string): string {
  return MINIMAL_VALID_XML.replace(
    '<mxCell id="n1" value="start" vertex="1" parent="1">',
    `<object label="start" ${attrs} id="n1"><mxCell vertex="1" parent="1">`,
  ).replace(
    "        </mxCell>\n      </root>",
    "        </mxCell></object>\n      </root>",
  );
}

describe("validateDrawioXml link and HTML hardening", () => {
  test("accepts a document that wraps a cell in <object> with placeholders", () => {
    const result = validateDrawioXml(withObjectWrapper('placeholders="1"'));
    expect(result.valid).toBe(true);
  });

  test("accepts an attribute whose name only starts with link", () => {
    const result = validateDrawioXml(withObjectWrapper('linkTarget="blank"'));
    expect(result.valid).toBe(true);
  });

  test("accepts a label that only mentions the dangerous words", () => {
    const result = validateDrawioXml(
      withCellValue("area map meta iframe object link usemap a"),
    );
    expect(result.valid).toBe(true);
  });

  test("accepts a label with escaped comparison operators", () => {
    const result = validateDrawioXml(
      withCellValue("x &lt; a &amp;&amp; y &gt; 1"),
    );
    expect(result.valid).toBe(true);
  });

  test("accepts an escaped <br> and <b> in a label", () => {
    const result = validateDrawioXml(
      withCellValue("a&lt;br&gt;&lt;b&gt;c&lt;/b&gt;"),
    );
    expect(result.valid).toBe(true);
  });

  test("accepts an <ul> list in a label", () => {
    const result = validateDrawioXml(
      withCellValue("&lt;ul&gt;&lt;li&gt;x&lt;/li&gt;&lt;/ul&gt;"),
    );
    expect(result.valid).toBe(true);
  });

  test.each([
    ["link on a cell", withCellAttr('link="https://example.com"')],
    ["link in upper case", withCellAttr('LINK="https://example.com"')],
    ["link in mixed case", withCellAttr('Link="https://example.com"')],
    ["link with single quotes", withCellAttr("link='https://example.com'")],
    ["link with spaces around the equal sign", withCellAttr('link = "x"')],
    ["link on an object", withObjectWrapper('link="https://example.com"')],
    [
      "link on a UserObject",
      withObjectWrapper('link="data:text/html,x"').replace(
        /object/g,
        "UserObject",
      ),
    ],
    ["usemap attribute", withCellAttr('usemap="#m"')],
  ])("rejects %s", (_name, xml) => {
    expect(validateDrawioXml(xml).valid).toBe(false);
  });

  test("names the link attribute in the reason", () => {
    const result = validateDrawioXml(
      withCellAttr('link="https://example.com"'),
    );
    expect(result).toEqual({
      valid: false,
      reason: expect.stringContaining("link"),
    });
  });

  test.each([
    ["anchor", "&lt;a href=&quot;https://example.com&quot;&gt;x&lt;/a&gt;"],
    [
      "anchor in upper case",
      "&lt;A HREF=&quot;https://example.com&quot;&gt;x&lt;/A&gt;",
    ],
    ["anchor with a tab after the name", "&lt;a&#9;href=&quot;x&quot;&gt;x"],
    ["anchor closed right away", "&lt;a/&gt;"],
    ["area", "&lt;area href=&quot;x&quot;&gt;"],
    ["map", "&lt;map name=&quot;m&quot;&gt;"],
    [
      "meta",
      "&lt;meta http-equiv=&quot;refresh&quot; content=&quot;0;url=https://example.com&quot;&gt;",
    ],
    [
      "iframe",
      "&lt;iframe src=&quot;https://example.com&quot;&gt;&lt;/iframe&gt;",
    ],
    [
      "object",
      "&lt;object data=&quot;https://example.com&quot;&gt;&lt;/object&gt;",
    ],
    [
      "usemap in an image",
      "&lt;img src=&quot;x&quot; usemap=&quot;#m&quot;&gt;",
    ],
    ["decimal reference for <", "&#60;a href=&quot;x&quot;&gt;"],
    ["hexadecimal reference for <", "&#x3c;a href=&quot;x&quot;&gt;"],
    ["upper case hexadecimal reference", "&#X3C;a href=&quot;x&quot;&gt;"],
    ["padded numeric reference", "&#0000060;a href=&quot;x&quot;&gt;"],
    ["reference without a semicolon", "&#60a href=&quot;x&quot;&gt;"],
    ["reference for the letter a", "&lt;&#97; href=&quot;x&quot;&gt;"],
    [
      "reference for the letter in iframe",
      "&lt;&#x69;frame src=&quot;x&quot;&gt;",
    ],
    ["double escaped anchor", "&amp;lt;a href=&amp;quot;x&amp;quot;&amp;gt;"],
    ["triple escaped anchor", "&amp;amp;lt;a href=x&amp;amp;gt;"],
    ["double escaped numeric reference", "&amp;#60;a href=x&amp;gt;"],
    [
      "double escaped usemap",
      "&amp;lt;img usemap=&amp;quot;#m&amp;quot;&amp;gt;",
    ],
  ])("rejects an HTML label with %s", (_name, value) => {
    expect(validateDrawioXml(withCellValue(value)).valid).toBe(false);
  });

  test("rejects an anchor written as an XML element", () => {
    const xml = MINIMAL_VALID_XML.replace(
      "</mxGraphModel>",
      '<a href="https://example.com">x</a></mxGraphModel>',
    );
    expect(validateDrawioXml(xml).valid).toBe(false);
  });

  test("rejects an anchor in a CDATA section", () => {
    const xml = MINIMAL_VALID_XML.replace(
      "</mxGraphModel>",
      '<x><![CDATA[<a href="https://example.com">x</a>]]></x></mxGraphModel>',
    );
    expect(validateDrawioXml(xml).valid).toBe(false);
  });

  test("rejects an escaped anchor in element text", () => {
    const xml = MINIMAL_VALID_XML.replace(
      "</mxGraphModel>",
      "<x>&lt;a href=&quot;x&quot;&gt;</x></mxGraphModel>",
    );
    expect(validateDrawioXml(xml).valid).toBe(false);
  });

  test("rejects a label that carries a raw < inside an attribute", () => {
    expect(validateDrawioXml(withCellValue('<a href="x">x</a>')).valid).toBe(
      false,
    );
  });

  test("rejects a quoted > inside an attribute that hides a following link attribute", () => {
    const xml = withCellAttr('note="a>b" link="https://example.com"');
    expect(validateDrawioXml(xml).valid).toBe(false);
  });

  test("rejects escaping nested deeper than the decoder follows", () => {
    const deep = `&${"amp;".repeat(8)}lt;a`;
    expect(validateDrawioXml(withCellValue(deep)).valid).toBe(false);
  });
});
