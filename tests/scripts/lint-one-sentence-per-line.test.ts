import { describe, expect, test } from "bun:test";
import {
  findSentenceBreaks,
  lintOneSentencePerLine,
} from "../../scripts/lint-one-sentence-per-line.ts";

/** 違反の行番号だけを返す。 */
function violatingLines(markdown: string): number[] {
  return lintOneSentencePerLine("docs/a.md", markdown).map((problem) =>
    Number(problem.split(":")[1]),
  );
}

describe("lintOneSentencePerLine report", () => {
  test("reports the path, line, and rule name of a violation", () => {
    const problems = lintOneSentencePerLine("docs/a.md", "# 題\n\nA。B。\n");

    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith("docs/a.md:3: [one-sentence-per-line] ");
  });

  test("reports a line once even when it holds three sentences", () => {
    expect(violatingLines("A。B。C。\n")).toEqual([1]);
  });

  test("reports the physical line of a multi-line paragraph", () => {
    expect(violatingLines("A。\nB。C。\nD。\n")).toEqual([2]);
  });
});

describe("lintOneSentencePerLine paragraphs", () => {
  test("accepts one sentence per line", () => {
    expect(violatingLines("A。\nB。\nC。\n")).toEqual([]);
  });

  test("accepts a sentence that continues over several lines", () => {
    expect(violatingLines("前半が\n続いて、\nここで終わる。\n")).toEqual([]);
  });

  test("reports a sentence that follows a full stop on the same line", () => {
    expect(violatingLines("前の文。後の文\n")).toEqual([1]);
  });

  test("accepts an English sentence ending with a period", () => {
    expect(violatingLines("First. Second. Third.\n")).toEqual([]);
  });

  test("accepts a line that ends with a full stop and trailing spaces", () => {
    expect(violatingLines("A。  \nB。\n")).toEqual([]);
  });

  test("accepts a hard break written as a backslash", () => {
    expect(violatingLines("A。\\\nB。\n")).toEqual([]);
  });
});

describe("lintOneSentencePerLine closers after the full stop", () => {
  test("accepts a closing bracket after the full stop at the end of a line", () => {
    expect(violatingLines("これは「A」である。）\n")).toEqual([]);
  });

  test("accepts a footnote reference after the full stop", () => {
    expect(violatingLines("A。[^1]\n\n[^1]: 注。\n")).toEqual([]);
  });

  test("accepts a closing emphasis after the full stop", () => {
    expect(violatingLines("**重要である。**\n")).toEqual([]);
  });

  test("accepts nested closing emphasis after the full stop", () => {
    expect(violatingLines("***重要である。***\n")).toEqual([]);
  });

  test("accepts an HTML comment after the full stop", () => {
    expect(violatingLines("A。<!-- 注 -->\n")).toEqual([]);
  });

  test("reports an opening emphasis that follows the full stop", () => {
    expect(violatingLines("A。**B**\n")).toEqual([1]);
  });

  test("reports a link that follows the full stop", () => {
    expect(violatingLines("A。[B](b.md)\n")).toEqual([1]);
  });
});

describe("lintOneSentencePerLine spans that hide a full stop", () => {
  test("ignores a full stop inside an inline code span", () => {
    expect(violatingLines("`a。b`と書く。\n")).toEqual([]);
  });

  test("ignores a full stop inside Japanese quotation marks", () => {
    expect(violatingLines("「A。B」と書く。\n")).toEqual([]);
  });

  test("ignores a full stop inside double-corner quotation marks", () => {
    expect(violatingLines("『A。B』と書く。\n")).toEqual([]);
  });

  test("ignores a full stop inside full-width parentheses", () => {
    expect(violatingLines("A（例: B。C）と書く。\n")).toEqual([]);
  });

  test("ignores a full stop inside ASCII parentheses", () => {
    expect(violatingLines("A(例: B。C)と書く。\n")).toEqual([]);
  });

  test("ignores a full stop inside nested brackets", () => {
    expect(violatingLines("A（「B。C」を参照。D）と書く。\n")).toEqual([]);
  });

  test("ignores a full stop in a quotation that spans two lines", () => {
    expect(violatingLines("「A。\nB。」と書く。\n")).toEqual([]);
  });

  test("ignores a full stop inside the text of a link", () => {
    expect(violatingLines("[A。B](b.md)を読む。\n")).toEqual([]);
  });

  test("ignores a full stop inside a link target", () => {
    expect(violatingLines("[A](b。c.md)を読む。\n")).toEqual([]);
  });

  test("ignores a full stop inside the alt text of an image", () => {
    expect(violatingLines("![A。B](b.png)を置く。\n")).toEqual([]);
  });

  test("ignores a full stop inside inline HTML", () => {
    expect(violatingLines('<span title="A。B">C</span>を置く。\n')).toEqual([]);
  });

  test("reports a sentence that follows a quotation closed on the same line", () => {
    expect(violatingLines("「A」と書く。B\n")).toEqual([1]);
  });

  test("reports a sentence after a full stop that follows a closed parenthesis", () => {
    expect(violatingLines("A（B）。C\n")).toEqual([1]);
  });
});

describe("lintOneSentencePerLine blocks", () => {
  test("reports a violation in a bullet item", () => {
    expect(violatingLines("- A。B。\n")).toEqual([1]);
  });

  test("reports a violation in a numbered item", () => {
    expect(violatingLines("1. A。B。\n")).toEqual([1]);
  });

  test("reports a violation in a nested bullet item", () => {
    expect(violatingLines("- X。\n  - A。B。\n")).toEqual([2]);
  });

  test("reports a violation in a task list item", () => {
    expect(violatingLines("- [ ] A。B。\n")).toEqual([1]);
  });

  test("reports a violation in the second paragraph of an item", () => {
    expect(violatingLines("- X。\n\n  A。B。\n")).toEqual([3]);
  });

  test("reports a violation in a block quote", () => {
    expect(violatingLines("> A。B。\n")).toEqual([1]);
  });

  test("reports a violation in an alert block", () => {
    expect(violatingLines("> [!NOTE]\n> A。B。\n")).toEqual([2]);
  });

  test("reports a violation in a footnote definition", () => {
    expect(violatingLines("A[^1]。\n\n[^1]: B。C。\n")).toEqual([3]);
  });

  test("ignores a table row", () => {
    expect(
      violatingLines("| 見出し | 値 |\n| --- | --- |\n| A。B。 | C。D |\n"),
    ).toEqual([]);
  });

  test("ignores a fenced code block", () => {
    expect(violatingLines("```text\nA。B。\n```\n")).toEqual([]);
  });

  test("ignores an indented code block", () => {
    expect(violatingLines("前置き。\n\n    A。B。\n")).toEqual([]);
  });

  test("ignores a heading", () => {
    expect(violatingLines("# A。B\n")).toEqual([]);
  });

  test("ignores an HTML block", () => {
    expect(violatingLines("<div>\nA。B。\n</div>\n")).toEqual([]);
  });

  test("ignores an HTML comment block", () => {
    expect(violatingLines("<!-- A。B。 -->\n")).toEqual([]);
  });

  test("ignores the frontmatter", () => {
    expect(violatingLines("---\ndescription: A。B。\n---\n\nC。\n")).toEqual(
      [],
    );
  });

  test("keeps the line numbers after the frontmatter", () => {
    expect(violatingLines("---\ndescription: x\n---\n\nA。B。\n")).toEqual([5]);
  });

  test("reports a paragraph that follows a table", () => {
    expect(violatingLines("| a |\n| - |\n\nA。B。\n")).toEqual([4]);
  });
});

describe("findSentenceBreaks", () => {
  function cut(markdown: string): string[] {
    return findSentenceBreaks(markdown).map(
      (found) =>
        `${markdown.slice(0, found.end)}|${markdown.slice(found.next)}`,
    );
  }

  test("cuts right after the full stop and resumes at the next sentence", () => {
    expect(cut("A。B。\n")).toEqual(["A。|B。\n"]);
  });

  test("returns one break for each full stop that is followed by text", () => {
    expect(cut("A。B。C\n")).toEqual(["A。|B。C\n", "A。B。|C\n"]);
  });

  test("skips the spaces between the sentences", () => {
    expect(cut("A。 B\n")).toEqual(["A。|B\n"]);
  });

  test("keeps a closing bracket with the sentence it closes", () => {
    expect(cut("A。）B\n")).toEqual(["A。）|B\n"]);
  });

  test("keeps a closing emphasis with the sentence it closes", () => {
    expect(cut("**A。** B\n")).toEqual(["**A。**|B\n"]);
  });

  test("keeps a footnote reference with the sentence it follows", () => {
    expect(cut("A。[^1]B\n\n[^1]: 注\n")).toEqual(["A。[^1]|B\n\n[^1]: 注\n"]);
  });

  test("reports the line of the cut", () => {
    expect(
      findSentenceBreaks("X。\nA。B\n").map((found) => found.line),
    ).toEqual([2]);
  });

  test("reports where the text of the paragraph starts", () => {
    const markdown = "- A。B\n";

    expect(
      findSentenceBreaks(markdown).map((found) => found.contentStart),
    ).toEqual([2]);
  });

  test("returns no break when no line has a second sentence", () => {
    expect(findSentenceBreaks("A。\nB。\n")).toEqual([]);
  });

  test("keeps a closing tag with the sentence it closes", () => {
    expect(cut("<b>A。</b>B\n")).toEqual(["<b>A。</b>|B\n"]);
  });

  test("starts the next sentence at an opening tag", () => {
    expect(cut("A。<b>B</b>\n")).toEqual(["A。|<b>B</b>\n"]);
  });

  test("starts the next sentence at a self-closing tag", () => {
    expect(cut('A。<img src="b.png" />B\n')).toEqual([
      'A。|<img src="b.png" />B\n',
    ]);
  });

  test("keeps a line break tag with the sentence it follows", () => {
    expect(cut("A。<br>B\n")).toEqual(["A。<br>|B\n"]);
  });
});

describe("lintOneSentencePerLine inline HTML after the full stop", () => {
  test("accepts a closing tag at the end of a line", () => {
    expect(violatingLines("<b>A。</b>\n")).toEqual([]);
  });

  test("accepts a line break tag at the end of a line", () => {
    expect(violatingLines("A。<br>\n")).toEqual([]);
  });

  test("accepts a self-closing line break tag at the end of a line", () => {
    expect(violatingLines("A。<br />\n")).toEqual([]);
  });

  test("reports an opening tag that follows the full stop", () => {
    expect(violatingLines("A。<b>B</b>\n")).toEqual([1]);
  });
});

describe("lintOneSentencePerLine brackets that are never closed", () => {
  test("reports the later sentences of a paragraph with an unclosed bracket", () => {
    expect(violatingLines("区間(0, 1]を使う。次。もう1つ。\n")).toEqual([1]);
  });

  test("reports a sentence inside a quotation when the paragraph has an unclosed bracket", () => {
    expect(violatingLines("(例\n「A。B」と書く。\n")).toEqual([2]);
  });

  test("does not carry an unclosed bracket into the next paragraph", () => {
    expect(violatingLines("区間(0, 1]を使う。\n\n「A。B」と書く。\n")).toEqual(
      [],
    );
  });

  test("keeps ignoring a full stop inside a bracket that is closed", () => {
    expect(violatingLines("A（B。C）と書く。\n")).toEqual([]);
  });
});

describe("lintOneSentencePerLine with CRLF line endings", () => {
  test("accepts one sentence per line", () => {
    expect(violatingLines("A。\r\nB。\r\n")).toEqual([]);
  });

  test("accepts a full stop at the end of the last line", () => {
    expect(violatingLines("A。\r\n")).toEqual([]);
  });

  test("accepts a backslash line break", () => {
    expect(violatingLines("A。\\\r\nB。\r\n")).toEqual([]);
  });

  test("accepts trailing spaces before the line ending", () => {
    expect(violatingLines("A。  \r\nB。\r\n")).toEqual([]);
  });

  test("reports a second sentence on the same line", () => {
    expect(violatingLines("A。B\r\nC。\r\n")).toEqual([1]);
  });

  test("numbers the lines of a document with CRLF", () => {
    expect(violatingLines("A。\r\nB。C\r\n")).toEqual([2]);
  });
});
