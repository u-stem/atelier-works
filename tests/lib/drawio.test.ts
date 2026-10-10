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

describe("validateDrawioXml tokenizer", () => {
  const prefix = "<mxfile><diagram><mxGraphModel><root>";
  const maxBytes = 256 * 1024;

  function timeOf(xml: string): { valid: boolean; elapsedMs: number } {
    const started = performance.now();
    const result = validateDrawioXml(xml);
    return { valid: result.valid, elapsedMs: performance.now() - started };
  }

  test.each([
    ["angle brackets", "<", 1600],
    ["unclosed tag starts", "<a", 1500],
    ["unclosed quoted tag starts", '<x"', 1500],
  ])("rejects %s", (_name, unit, count) => {
    expect(validateDrawioXml(prefix + unit.repeat(count)).valid).toBe(false);
  });

  test.each([
    ["angle brackets", "<"],
    ["unclosed tag starts", "<a"],
    ["unclosed quoted tag starts", '<x"'],
  ])("rejects %s up to the size limit in a short time", (_name, unit) => {
    const xml =
      prefix +
      unit.repeat(Math.floor((maxBytes - prefix.length) / unit.length));
    expect(timeOf(xml).elapsedMs).toBeLessThan(500);
  });

  test.each([
    ["angle brackets", "<"],
    ["unclosed tag starts", "<a"],
    ["unclosed quoted tag starts", '<x"'],
  ])("returns valid false for %s up to the size limit", (_name, unit) => {
    const xml =
      prefix +
      unit.repeat(Math.floor((maxBytes - prefix.length) / unit.length));
    expect(timeOf(xml).valid).toBe(false);
  });

  test("rejects an unclosed comment", () => {
    expect(validateDrawioXml(`${prefix}<!-- x`).valid).toBe(false);
  });

  test("rejects an unclosed CDATA section", () => {
    expect(validateDrawioXml(`${prefix}<![CDATA[x`).valid).toBe(false);
  });

  test("rejects an unclosed processing instruction", () => {
    expect(validateDrawioXml(`${prefix}<?x`).valid).toBe(false);
  });

  test("rejects a raw < outside the quotes of a tag", () => {
    expect(validateDrawioXml(`${prefix}<mxCell a<b="1"/>`).valid).toBe(false);
  });

  test("rejects a tag that is never closed with >", () => {
    expect(validateDrawioXml(`${prefix}<mxCell a="1"`).valid).toBe(false);
  });

  test("rejects a doctype declaration", () => {
    expect(validateDrawioXml(`<!DOCTYPE x>${MINIMAL_VALID_XML}`).valid).toBe(
      false,
    );
  });

  test("checks many attribute-bearing starts inside one value in a short time", () => {
    const xml = withCellValue("&lt;a ".repeat(40000));
    expect(timeOf(xml).elapsedMs).toBeLessThan(500);
  });

  test("checks many quoted starts inside one value in a short time", () => {
    const xml = withCellValue("&lt;a b=&quot;".repeat(20000));
    expect(timeOf(xml).elapsedMs).toBeLessThan(500);
  });

  test("checks many unterminated diagram starts in a short time", () => {
    const xml = withCellValue("&lt;diagram ".repeat(20000));
    expect(timeOf(xml).elapsedMs).toBeLessThan(500);
  });

  test("checks a long run of ampersands in a short time", () => {
    const xml = withCellValue("&#1".repeat(60000));
    expect(timeOf(xml).elapsedMs).toBeLessThan(500);
  });

  test("keeps a quoted > inside an attribute from ending the tag", () => {
    const xml = withCellAttr('note="a>b"');
    expect(validateDrawioXml(xml).valid).toBe(true);
  });
});

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
    ["image, which the HTML parser turns into img", "&lt;image src=x&gt;"],
    ["image in upper case", "&lt;IMAGE/src=x&gt;"],
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
    ["script without attributes", "&lt;script&gt;alert(1)&lt;/script&gt;"],
    ["script with a src", "&lt;SCRIPT src=x&gt;"],
    ["an onclick handler", "&lt;div onclick=&quot;x&quot;&gt;"],
    ["an onerror handler on an image", "&lt;b onerror = x&gt;"],
    ["an onload handler after a slash", "&lt;b/onload=x&gt;"],
    ["an escaped onmouseover handler", "&amp;lt;b onmouseover=x&amp;gt;"],
    ["an upper case handler", "&lt;b ONCLICK=x&gt;"],
    [
      "a handler after a quoted value",
      "&lt;b title=&quot;x&quot;onclick=y&gt;",
    ],
    [
      "a handler after a quoted > in another attribute",
      "&lt;b title=&quot;&gt;&quot; onclick=x&gt;",
    ],
    ["a handler after an unquoted value", "&lt;b id=x onclick=y&gt;"],
    ["a handler after another tag", "&lt;i&gt;a&lt;/i&gt;&lt;b onclick=x&gt;"],
  ])("rejects a label with %s", (_name, value) => {
    expect(validateDrawioXml(withCellValue(value)).valid).toBe(false);
  });

  test.each([
    [
      "a quote opened inside a comment",
      '<!-- <b title=" --> <b onclick=x> <b title="-->',
    ],
    [
      "a quote opened inside a bogus comment",
      '<!x <b title="> <b onclick=x> <b title=">',
    ],
    [
      "a quote opened inside a bogus end tag",
      '</ <b title="> <b onclick=x> <b title=">',
    ],
    [
      "a quote opened inside a textarea",
      '<textarea><b title="</textarea><b onclick=x><b title=""></textarea>',
    ],
    [
      "a handler after a comment that hides a quote",
      '<!--<b title="--><details open ontoggle=alert(1)>">',
    ],
    [
      "a handler after a processing instruction that hides a quote",
      '<?<b title="><details open ontoggle=x>">',
    ],
  ])("rejects a label with %s", (_name, html) => {
    const escaped = html
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
    expect(validateDrawioXml(withCellValue(escaped)).valid).toBe(false);
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
    ["a word that contains on and a letter before =", "Conditions = 3"],
    ["on followed by a space", "on hold = yes"],
    ["a variable named one", "one = 1"],
    ["a variable named online", "online = true"],
    ["a query string with online", "https://x/?online=1"],
    ["a status with onboarding", "onboarding=完了"],
    ["text after a closed tag", "&lt;b&gt;x&lt;/b&gt; one = 1"],
    ["text after a closing tag with a slash", "x&lt;/b&gt;online=1"],
    ["a comparison before a handler-like word", "a &lt; b online = 1"],
    ["a type named Scripts", "Map&lt;Scripts&gt;"],
    ["a closing script", "x&lt;/script&gt;"],
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

  test("checks a long run of unterminated tags for handlers in linear time", () => {
    const xml = withCellValue("&lt;b ".repeat(20000));
    const started = performance.now();
    validateDrawioXml(xml);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("checks a long run of angle brackets in linear time", () => {
    const xml = withCellValue("&lt;".repeat(40000));
    const started = performance.now();
    validateDrawioXml(xml);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("checks a long run of tag starts without a close in linear time", () => {
    const xml = withCellValue("&lt;b on".repeat(20000));
    const started = performance.now();
    validateDrawioXml(xml);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("checks a long run of unterminated quoted values in linear time", () => {
    const xml = withCellValue("&lt;b a=&quot;".repeat(20000));
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

describe("validateDrawioXml long inputs", () => {
  test("returns a result for a long run of attribute names in the root tag", () => {
    const xml = `<mxfile ${"a ".repeat(120000)}><diagram/></mxfile>`;
    const started = performance.now();
    const result = validateDrawioXml(xml);
    expect(typeof result.valid).toBe("boolean");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("returns a result for a 200KB unquoted attribute value", () => {
    const xml = `<mxfile a=${"x".repeat(200000)}><diagram/></mxfile>`;
    const started = performance.now();
    const result = validateDrawioXml(xml);
    expect(typeof result.valid).toBe("boolean");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("returns a result for a 200KB attribute with an unclosed quote", () => {
    const xml = `<mxfile a="${"x".repeat(200000)}><diagram/></mxfile>`;
    const started = performance.now();
    const result = validateDrawioXml(xml);
    expect(typeof result.valid).toBe("boolean");
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

/** ラベルのHTMLを1段エスケープして、`html=1`のセルの`value`に入れる。 */
function withHtmlLabel(html: string): string {
  const escaped = html
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  return MINIMAL_VALID_XML.replace(
    'value="start" vertex="1"',
    `value="${escaped}" style="html=1;" vertex="1"`,
  );
}

describe("validateDrawioXml syntax that parsers read differently", () => {
  test.each([
    [
      "a double quote hidden in a comment",
      '<!-- <b t=" --> <b t=">" onclick=1>',
    ],
    [
      "a single quote hidden in a comment",
      "<!-- <b t=' --> <b t='>' onclick=1>",
    ],
    [
      "a comment that hides a quote before a details element",
      '<!--<b title="--><details title=">" open ontoggle=alert(1)>',
    ],
    [
      "a textarea that hides a quote before a details element",
      '<textarea><x a="</textarea><details title=">" open ontoggle=alert(1)>',
    ],
    [
      "a processing instruction that hides a quote",
      '<?<b title="><details open ontoggle=x>">',
    ],
    [
      "an end tag whose quoted value hides a handler",
      `</x a="<b t='"> <b t=">" onclick=1> '>`,
    ],
    ["a comment", "a<!-- note -->b"],
    ["a doctype", "<!DOCTYPE html>x"],
    ["a bogus comment", "<!x>"],
    ["a CDATA section", "<![CDATA[x]]>"],
    ["a processing instruction", "<?x?>"],
    ["a less-than sign and a slash followed by a space", "x </ y"],
    ["a less-than sign and a slash followed by a digit", "x </1"],
    ["a less-than sign and a slash at the end", "x </"],
    ["an svg element", "x<svg>y"],
    [
      "an svg anchor with a set element",
      '<svg><a><set attributeName="href" to="javascript:alert(1)"/><text>x</text></a></svg>',
    ],
    ["a math element", "<math>x</math>"],
    ["a set element", '<set attributeName="href" to="x">'],
    ["an animate element", "<animate attributeName=href values=x>"],
    ["an animateMotion element", "<animateMotion>"],
    ["an animateTransform element", "<ANIMATETRANSFORM/>"],
    ["a textarea", "<textarea>x</textarea>"],
    ["a title without attributes", "<title>x</title>"],
    ["an xmp element", "<xmp>x</xmp>"],
    ["a noscript element", "<noscript>x</noscript>"],
    ["a noembed element", "<noembed>x</noembed>"],
    ["a noframes element", "<noframes>x</noframes>"],
    ["a plaintext element", "<plaintext>x"],
    ["an iframe without attributes", "<iframe>x</iframe>"],
    ["a textarea at the end of the label", "x<textarea"],
    ["a title in upper case", "<TITLE>"],
    ["a textarea followed by a slash", "<textarea/>"],
    ["a title followed by a tab", "<title\tid=x>"],
  ])("rejects a label with %s", (_name, html) => {
    expect(validateDrawioXml(withHtmlLabel(html)).valid).toBe(false);
  });

  test.each([
    ["one = 1", "one = 1"],
    ["Promise<Object>", "Promise<Object>"],
    ["List<Map>", "List<Map>"],
    ["a < b", "a < b"],
    ["a <= b", "a <= b"],
    ["a line break", "a<br>b"],
    ["bold text", "<b>x</b>"],
    ["a list", "<ul><li>x</li></ul>"],
    ["a styled div", '<div style="color:red">x</div>'],
    ["a styled span", "<span style='font-size:12px'>x</span>"],
    ["a font element", '<font color="#ff0000">x</font>'],
    ["a type named Settings", "Map<Settings>"],
    ["a type named Titles", "List<Titles>"],
    ["a type named Svgs", "List<Svgs>"],
  ])("accepts a label that writes %s", (_name, html) => {
    expect(validateDrawioXml(withHtmlLabel(html)).valid).toBe(true);
  });
});

describe("validateDrawioXml tags read with quotes", () => {
  test("rejects an anchor whose first attribute name is a quote", () => {
    const xml = withHtmlLabel('<a "=">" href=x>go</a>');
    expect(validateDrawioXml(xml).valid).toBe(false);
  });

  test("rejects an anchor written with upper case named references", () => {
    const xml = withCellValue("&amp;LT;a href=x&amp;GT;go");
    expect(validateDrawioXml(xml).valid).toBe(false);
  });

  test("rejects a handler written with upper case named references", () => {
    const xml = withCellValue(
      "&amp;LT;b onclick=&amp;QUOT;x&amp;QUOT;&amp;GT;",
    );
    expect(validateDrawioXml(xml).valid).toBe(false);
  });

  test("rejects a script written with an upper case ampersand reference", () => {
    const xml = withCellValue("&amp;AMP;lt;script&amp;AMP;gt;");
    expect(validateDrawioXml(xml).valid).toBe(false);
  });
});

describe("validateDrawioXml placeholders resolved from ancestors", () => {
  const head =
    '<mxfile><diagram id="d"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>';
  const tail = "</root></mxGraphModel></diagram></mxfile>";
  const parentCell =
    '<object id="g" x="&lt;a "><mxCell parent="1" vertex="1"/></object>';
  const childCell =
    '<object id="c" placeholders="1" label="%x%href=javascript:alert(1)&gt;go"><mxCell parent="g" vertex="1" style="html=1;"/></object>';

  test("rejects a tag split between an ancestor and a child label", () => {
    const xml = `${head}${parentCell}${childCell}${tail}`;
    expect(validateDrawioXml(xml).valid).toBe(false);
  });

  test("rejects a tag split between a later ancestor and a child label", () => {
    const xml = `${head}${childCell}${parentCell}${tail}`;
    expect(validateDrawioXml(xml).valid).toBe(false);
  });

  test("rejects a tag whose attribute comes from a grandparent", () => {
    const xml = `${head}<object id="r" x="href=x"><mxCell parent="1" vertex="1"/></object><mxCell id="m" parent="r" vertex="1"/><object id="c" placeholders="1" label="&lt;a %x%&gt;go"><mxCell parent="m" vertex="1"/></object>${tail}`;
    expect(validateDrawioXml(xml).valid).toBe(false);
  });

  test("rejects a tag split across the own values in reverse order", () => {
    const xml = `${head}<object id="c" placeholders="1" label="%p1%%p2%" p2=" href=x&gt;" p1="&lt;a"><mxCell parent="1" vertex="1"/></object>${tail}`;
    expect(validateDrawioXml(xml).valid).toBe(false);
  });

  test("rejects a less-than sign produced by a date placeholder", () => {
    const xml = `${head}<object id="c" placeholders="1" label="%date{&lt;}%a href=x&gt;go"><mxCell parent="1" vertex="1"/></object>${tail}`;
    expect(validateDrawioXml(xml).valid).toBe(false);
  });

  test("rejects a cell id used as a placeholder", () => {
    const xml = `${head}<object placeholders="1" label="%id%href=x&gt;go" id="&lt;a "><mxCell parent="1" vertex="1"/></object>${tail}`;
    expect(validateDrawioXml(xml).valid).toBe(false);
  });

  test("accepts placeholders that resolve to plain text from an ancestor", () => {
    const xml = `${head}<object id="g" owner="team"><mxCell parent="1" vertex="1"/></object><object id="c" placeholders="1" label="owner: %owner%"><mxCell parent="g" vertex="1"/></object>${tail}`;
    expect(validateDrawioXml(xml).valid).toBe(true);
  });

  test("accepts an escaped percent pair that stays literal", () => {
    const xml = `${head}${parentCell}<object id="c" placeholders="1" label="%%x%href=y&gt;"><mxCell parent="g" vertex="1"/></object>${tail}`;
    expect(validateDrawioXml(xml).valid).toBe(true);
  });

  test("checks a deep chain of placeholder labels in a short time", () => {
    const cells = Array.from(
      { length: 2000 },
      (_unused, i) =>
        `<object id="c${i}" placeholders="1" label="${"%missing%".repeat(10)}"><mxCell parent="${i === 0 ? "1" : `c${i - 1}`}" vertex="1"/></object>`,
    ).join("");
    const started = performance.now();
    validateDrawioXml(`${head}${cells}${tail}`);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("checks many date placeholders without a closing brace in a short time", () => {
    const xml = `${head}<object id="c" placeholders="1" label="${"%date{".repeat(30000)}"><mxCell parent="1" vertex="1"/></object>${tail}`;
    const started = performance.now();
    validateDrawioXml(xml);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
