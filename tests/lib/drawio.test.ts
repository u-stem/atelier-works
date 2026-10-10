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

describe("validateDrawioXml compressed diagrams", () => {
  const head = '<mxfile host="app.diagrams.net">';
  const model = '<mxGraphModel><root><mxCell id="0"/></root></mxGraphModel>';

  test.each([
    [
      "text after a model",
      `${head}<diagram id="d1">${model}BASE64DATA</diagram></mxfile>`,
    ],
    [
      "text next to an empty model",
      `${head}<diagram id="d1"><mxGraphModel/>BASE64</diagram></mxfile>`,
    ],
    [
      "a CDATA section",
      `${head}<diagram id="d1"><![CDATA[dGhpcyBpcw==]]></diagram></mxfile>`,
    ],
    [
      "an empty CDATA section",
      `${head}<diagram id="d1">${model}<![CDATA[]]></diagram></mxfile>`,
    ],
    [
      "a comment and then text",
      `${head}<diagram id="d1"><!-- note -->BASE64</diagram></mxfile>`,
    ],
    [
      "compression only in the second diagram",
      `${head}<diagram id="d1">${model}</diagram><diagram id="d2">BASE64</diagram></mxfile>`,
    ],
    [
      "text inside a nested element",
      `${head}<diagram id="d1"><mxGraphModel><root>BASE64</root></mxGraphModel></diagram></mxfile>`,
    ],
    [
      "single-quoted compressed true",
      `<mxfile compressed='true'><diagram id="d1">${model}</diagram></mxfile>`,
    ],
  ])("rejects a diagram with %s", (_name, xml) => {
    expect(validateDrawioXml(xml).valid).toBe(false);
  });

  test("names compression in the reason for text inside a diagram", () => {
    const result = validateDrawioXml(
      `${head}<diagram id="d1"><mxGraphModel/>BASE64</diagram></mxfile>`,
    );
    expect(result).toEqual({
      valid: false,
      reason: expect.stringContaining("圧縮"),
    });
  });

  test("accepts whitespace and comments between elements in every diagram", () => {
    const xml = `${head}\n<diagram id="d1">\n <!-- a -->${model}\n</diagram>\n<diagram id="d2">${model}</diagram></mxfile>`;
    expect(validateDrawioXml(xml).valid).toBe(true);
  });

  test("accepts text outside the diagrams", () => {
    const xml = `${head}note<diagram id="d1">${model}</diagram></mxfile>`;
    expect(validateDrawioXml(xml).valid).toBe(true);
  });
});

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

  test.each([
    ["embed", "&lt;embed src=&quot;x&quot;&gt;"],
    ["form", "&lt;form action=&quot;x&quot;&gt;"],
    ["base", "&lt;base href=&quot;x&quot;&gt;"],
    ["link", "&lt;link rel=&quot;stylesheet&quot; href=&quot;x&quot;&gt;"],
    ["img", "&lt;img src=&quot;x&quot;&gt;"],
    ["input", "&lt;input type=&quot;submit&quot;&gt;"],
    ["button", "&lt;button name=&quot;x&quot;&gt;"],
    ["svg", "&lt;svg onload=&quot;x&quot;&gt;"],
    ["use", "&lt;use href=&quot;x&quot;&gt;"],
    ["video", "&lt;video src=&quot;x&quot;&gt;"],
    ["audio", "&lt;audio src=&quot;x&quot;&gt;"],
    ["source", "&lt;source src=&quot;x&quot;&gt;"],
    ["frame", "&lt;frame src=&quot;x&quot;&gt;"],
    ["anchor with a valueless attribute first", "&lt;a download href=x&gt;"],
    ["anchor with a slash before the attribute", "&lt;a/href=x&gt;"],
    ["anchor after another tag", "&lt;b&gt;&lt;a href=x&gt;"],
    ["anchor after an unrelated angle bracket", "&lt;&lt;a href=x&gt;"],
    ["style without attributes", "&lt;style&gt;p{display:none}&lt;/style&gt;"],
    ["style with attributes", "&lt;style media=&quot;all&quot;&gt;"],
    ["style in upper case", "&lt;STYLE&gt;"],
    ["formaction", "&lt;button formaction=&quot;x&quot;&gt;"],
    ["formaction on a bare word", "formaction=x"],
    ["srcdoc", "&lt;div srcdoc=&quot;x&quot;&gt;"],
  ])("rejects a label with %s", (_name, value) => {
    expect(validateDrawioXml(withCellValue(value)).valid).toBe(false);
  });

  test.each([
    ["Promise<Object>", "Promise&lt;Object&gt;"],
    ["List<Map>", "List&lt;Map&gt;"],
    ["Result<A, E>", "Result&lt;A, E&gt;"],
    ["Array<Area>", "Array&lt;Area&gt;"],
    ["Option<Meta>", "Option&lt;Meta&gt;"],
    ["Map<string, Link>", "Map&lt;string, Link&gt;"],
    ["a self-closed anchor", "&lt;a/&gt;"],
    ["an anchor without attributes", "&lt;a&gt;x&lt;/a&gt;"],
    ["a closing style", "x&lt;/style&gt;"],
    ["a class named Styles", "Map&lt;Styles&gt;"],
  ])("accepts a label that writes %s", (_name, value) => {
    expect(validateDrawioXml(withCellValue(value)).valid).toBe(true);
  });

  test("rejects an angle bracket tag split across placeholder values", () => {
    const xml = withObjectWrapper(
      'placeholders="1" p1="&lt;a" p2=" href=x&gt;"',
    );
    expect(validateDrawioXml(xml).valid).toBe(false);
  });

  test("accepts placeholder values that join into harmless text", () => {
    const xml = withObjectWrapper('placeholders="1" p1="a" p2="b"');
    expect(validateDrawioXml(xml).valid).toBe(true);
  });

  test("does not join attribute values when placeholders is absent", () => {
    const xml = withObjectWrapper('p1="&lt;a" p2=" href=x&gt;"');
    expect(validateDrawioXml(xml).valid).toBe(true);
  });

  test("checks a long run of unterminated tags in linear time", () => {
    const xml = withCellValue("&lt;a ".repeat(20000));
    const started = performance.now();
    validateDrawioXml(xml);
    expect(performance.now() - started).toBeLessThan(1000);
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
