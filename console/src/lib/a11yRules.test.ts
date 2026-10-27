import { describe, expect, test } from "bun:test";
import { type A11yRuleId, checkA11y } from "./a11yRules.ts";

/** 指定した規則の違反の数。 */
function count(rule: A11yRuleId, html: string, headingStart = 0): number {
  return checkA11y(html, { headingStart }).filter(
    (violation) => violation.rule === rule,
  ).length;
}

describe("a11yRules: idref", () => {
  test("catches aria-labelledby that points at a missing id", () => {
    expect(
      count("idref", '<section aria-labelledby="gone"><p>x</p></section>'),
    ).toBe(1);
  });

  test("passes aria-labelledby that points at an existing id", () => {
    expect(
      count(
        "idref",
        '<section aria-labelledby="t"><h2 id="t">x</h2></section>',
      ),
    ).toBe(0);
  });

  test("catches aria-describedby that points at a missing id", () => {
    expect(
      count("idref", '<input aria-describedby="gone" aria-label="a">'),
    ).toBe(1);
  });

  test("passes aria-describedby that points at an existing id", () => {
    expect(
      count(
        "idref",
        '<input aria-describedby="h" aria-label="a"><p id="h">hint</p>',
      ),
    ).toBe(0);
  });

  test("catches aria-controls that points at a missing id when expanded", () => {
    expect(
      count(
        "idref",
        '<button aria-expanded="true" aria-controls="gone">x</button>',
      ),
    ).toBe(1);
  });

  test("passes aria-controls that points at an existing id", () => {
    expect(
      count(
        "idref",
        '<button aria-expanded="true" aria-controls="p">x</button><div id="p"></div>',
      ),
    ).toBe(0);
  });

  test("passes aria-controls to content that is not drawn while collapsed", () => {
    expect(
      count(
        "idref",
        '<button aria-expanded="false" aria-controls="gone">x</button>',
      ),
    ).toBe(0);
  });

  test("catches one missing id among several", () => {
    expect(
      count("idref", '<p id="a">a</p><div aria-labelledby="a gone">x</div>'),
    ).toBe(1);
  });

  test("catches aria-activedescendant that points at a missing id", () => {
    expect(
      count(
        "idref",
        '<input role="combobox" aria-label="q" aria-activedescendant="gone">',
      ),
    ).toBe(1);
  });
});

describe("a11yRules: duplicate-id", () => {
  test("catches the same id twice", () => {
    expect(count("duplicate-id", '<p id="a">1</p><p id="a">2</p>')).toBe(1);
  });

  test("reports an id repeated three times once", () => {
    expect(
      count("duplicate-id", '<p id="a">1</p><p id="a">2</p><p id="a">3</p>'),
    ).toBe(1);
  });

  test("passes different ids", () => {
    expect(count("duplicate-id", '<p id="a">1</p><p id="b">2</p>')).toBe(0);
  });

  test("passes elements without an id", () => {
    expect(count("duplicate-id", "<p>1</p><p>2</p>")).toBe(0);
  });
});

describe("a11yRules: heading-order", () => {
  test("catches h3 right after h1", () => {
    expect(count("heading-order", "<h1>a</h1><h3>b</h3>")).toBe(1);
  });

  test("passes h2 right after h1", () => {
    expect(count("heading-order", "<h1>a</h1><h2>b</h2>")).toBe(0);
  });

  test("passes a jump back up", () => {
    expect(
      count("heading-order", "<h1>a</h1><h2>b</h2><h3>c</h3><h2>d</h2>"),
    ).toBe(0);
  });

  test("catches a skip after a jump back up", () => {
    expect(
      count(
        "heading-order",
        "<h1>a</h1><h2>b</h2><h3>c</h3><h2>d</h2><h4>e</h4>",
      ),
    ).toBe(1);
  });

  test("catches a fragment that starts at h3 when the page has only h1", () => {
    expect(count("heading-order", "<h3>a</h3>", 1)).toBe(1);
  });

  test("passes a fragment that starts at h2 when the page has h1 outside", () => {
    expect(count("heading-order", "<h2>a</h2>", 1)).toBe(0);
  });

  test("catches a page that starts below h1 when nothing precedes it", () => {
    expect(count("heading-order", "<h2>a</h2>")).toBe(1);
  });

  test("passes a page without headings", () => {
    expect(count("heading-order", "<p>a</p>")).toBe(0);
  });

  test("ignores a heading that is hidden from assistive technology", () => {
    expect(
      count(
        "heading-order",
        '<h1>a</h1><div aria-hidden="true"><h4>b</h4></div>',
      ),
    ).toBe(0);
  });
});

describe("a11yRules: input-label", () => {
  test("catches an input without a name", () => {
    expect(count("input-label", '<input type="text">')).toBe(1);
  });

  test("passes an input with aria-label", () => {
    expect(count("input-label", '<input type="text" aria-label="名前">')).toBe(
      0,
    );
  });

  test("catches an input with a blank aria-label", () => {
    expect(count("input-label", '<input type="text" aria-label=" ">')).toBe(1);
  });

  test("passes an input named by a label for it", () => {
    expect(
      count("input-label", '<label for="a">名前</label><input id="a">'),
    ).toBe(0);
  });

  test("catches an input whose label points at another id", () => {
    expect(
      count("input-label", '<label for="b">名前</label><input id="a">'),
    ).toBe(1);
  });

  test("passes an input wrapped in a label with text", () => {
    expect(count("input-label", "<label>名前<input></label>")).toBe(0);
  });

  test("catches a select wrapped in a label whose only text is its own options", () => {
    expect(
      count(
        "input-label",
        "<label><select><option>a</option></select></label>",
      ),
    ).toBe(1);
  });

  test("passes a select wrapped in a label that has text of its own", () => {
    expect(
      count(
        "input-label",
        "<label>種類<select><option>a</option></select></label>",
      ),
    ).toBe(0);
  });

  test("catches a textarea wrapped in a label with no text", () => {
    expect(
      count("input-label", "<label><textarea>draft</textarea></label>"),
    ).toBe(1);
  });

  test("passes an input named by aria-labelledby", () => {
    expect(
      count(
        "input-label",
        '<span id="n">名前</span><input aria-labelledby="n">',
      ),
    ).toBe(0);
  });

  test("catches a textarea without a name", () => {
    expect(count("input-label", "<textarea></textarea>")).toBe(1);
  });

  test("catches a select without a name", () => {
    expect(count("input-label", "<select><option>a</option></select>")).toBe(1);
  });

  test("passes a select with aria-label", () => {
    expect(
      count(
        "input-label",
        '<select aria-label="種類"><option>a</option></select>',
      ),
    ).toBe(0);
  });

  test("passes a hidden input", () => {
    expect(count("input-label", '<input type="hidden" name="a">')).toBe(0);
  });

  test("passes a submit button input", () => {
    expect(count("input-label", '<input type="submit" value="送る">')).toBe(0);
  });
});

describe("a11yRules: button-name", () => {
  test("catches an empty button", () => {
    expect(count("button-name", "<button></button>")).toBe(1);
  });

  test("catches a button with only a hidden icon", () => {
    expect(
      count("button-name", '<button><svg aria-hidden="true"></svg></button>'),
    ).toBe(1);
  });

  test("passes a button with text", () => {
    expect(count("button-name", "<button>保存</button>")).toBe(0);
  });

  test("passes a button named by aria-label", () => {
    expect(
      count("button-name", '<button aria-label="閉じる"><svg></svg></button>'),
    ).toBe(0);
  });

  test("passes a button with screen-reader-only text", () => {
    expect(
      count(
        "button-name",
        '<button><svg aria-hidden="true"></svg><span class="sr-only">閉じる</span></button>',
      ),
    ).toBe(0);
  });

  test("passes a button named by aria-labelledby", () => {
    expect(
      count(
        "button-name",
        '<span id="n">開く</span><button aria-labelledby="n"></button>',
      ),
    ).toBe(0);
  });

  test("catches a button whose text is hidden from assistive technology", () => {
    expect(
      count(
        "button-name",
        '<button><span aria-hidden="true">x</span></button>',
      ),
    ).toBe(1);
  });

  test("passes a button named by its title", () => {
    expect(count("button-name", '<button title="閉じる"></button>')).toBe(0);
  });

  test("catches an element with role button and no name", () => {
    expect(count("button-name", '<div role="button"></div>')).toBe(1);
  });

  test("passes an unnamed button inside a closed dialog, which is not drawn", () => {
    expect(count("button-name", "<dialog><button></button></dialog>")).toBe(0);
  });

  test("catches an unnamed button inside an open dialog", () => {
    expect(
      count("button-name", "<dialog open><button></button></dialog>"),
    ).toBe(1);
  });
});

describe("a11yRules: link-name", () => {
  test("catches a link without a name", () => {
    expect(count("link-name", '<a href="/x"></a>')).toBe(1);
  });

  test("passes a link with text", () => {
    expect(count("link-name", '<a href="/x">詳細</a>')).toBe(0);
  });

  test("passes a link named by aria-label", () => {
    expect(
      count("link-name", '<a href="/x" aria-label="詳細"><svg></svg></a>'),
    ).toBe(0);
  });

  test("passes a link whose image has an alt", () => {
    expect(
      count("link-name", '<a href="/x"><img src="a.png" alt="印"></a>'),
    ).toBe(0);
  });

  test("catches a link whose image has an empty alt", () => {
    expect(
      count("link-name", '<a href="/x"><img src="a.png" alt=""></a>'),
    ).toBe(1);
  });

  test("passes an anchor without href, which is not a link", () => {
    expect(count("link-name", "<a>x</a><a></a>")).toBe(0);
  });
});

describe("a11yRules: reading the HTML", () => {
  test("reads a value with a greater-than sign inside quotes", () => {
    expect(count("button-name", '<button title="a>b"></button>')).toBe(0);
  });

  test("reads an unquoted attribute", () => {
    expect(count("button-name", "<button aria-label=close></button>")).toBe(0);
  });

  test("skips comments", () => {
    expect(count("button-name", "<!-- <button></button> --><p>x</p>")).toBe(0);
  });

  test("skips the inside of a script", () => {
    expect(
      count("button-name", "<script>var a = '<button></button>'</script>"),
    ).toBe(0);
  });

  test("reads void elements without closing them", () => {
    expect(
      count(
        "button-name",
        '<input type="text" aria-label="a"><button>x</button>',
      ),
    ).toBe(0);
  });

  test("decodes the entities React writes", () => {
    expect(count("button-name", "<button>&amp;</button>")).toBe(0);
  });

  test("reports nothing for a clean document", () => {
    expect(checkA11y('<h1 id="t">a</h1><button>b</button>').length).toBe(0);
  });

  test("reads a single-quoted attribute", () => {
    expect(count("button-name", "<button aria-label='閉じる'></button>")).toBe(
      0,
    );
  });

  test("reads an upper-case tag and attribute name", () => {
    expect(count("button-name", '<BUTTON ARIA-LABEL="閉じる"></BUTTON>')).toBe(
      0,
    );
  });

  test("still catches an upper-case button without a name", () => {
    expect(count("button-name", "<BUTTON></BUTTON>")).toBe(1);
  });

  test("closes a self-closing element so that it does not swallow what follows", () => {
    expect(
      count("button-name", '<path aria-hidden="true"/><button></button>'),
    ).toBe(1);
  });

  test("skips the inside of a style", () => {
    expect(
      count("button-name", "<style>/* <button></button> */</style><p>x</p>"),
    ).toBe(0);
  });

  test("keeps reading after a script that contains a less-than sign", () => {
    expect(
      count("button-name", "<script>if (a < b) {}</script><button></button>"),
    ).toBe(1);
  });

  test("ends a script at an upper-case closing tag", () => {
    expect(count("button-name", "<script>x</SCRIPT><button></button>")).toBe(1);
  });

  test("ends a comment at its own closing, even when it holds a greater-than sign", () => {
    expect(count("button-name", "<!-- a > b --><button></button>")).toBe(1);
  });

  test("skips an element with the hidden attribute", () => {
    expect(count("button-name", "<button hidden></button>")).toBe(0);
  });

  test("names a button by the aria-label of its child", () => {
    expect(
      count(
        "button-name",
        '<button><span aria-label="閉じる"></span></button>',
      ),
    ).toBe(0);
  });
});
