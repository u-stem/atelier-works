// 画面が参照するscriptとstylesheetのURLを集める。
// DOMの型には依存せず、querySelectorAllを持つ最小の形を受け取るので、偽のオブジェクトでテストできる。

export type ReferenceElement = {
  tagName: string;
  getAttribute(name: string): string | null;
};

export type ReferenceRoot = {
  querySelectorAll(selector: string): Iterable<ReferenceElement>;
};

const REFERENCING_RELS: readonly string[] = ["stylesheet", "modulepreload"];

function referencedValue(element: ReferenceElement): string | null {
  const tag = element.tagName.toLowerCase();
  if (tag === "script") {
    return element.getAttribute("src");
  }
  if (tag === "link") {
    const rels = (element.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
    return rels.some((rel) => REFERENCING_RELS.includes(rel))
      ? element.getAttribute("href")
      : null;
  }
  return null;
}

/**
 * srcを持つscriptと、relがstylesheetかmodulepreloadのlinkのURLを、baseを基準に絶対URLにして返す。
 * 他のlinkと、srcの無いscriptは拾わない。解釈できない値は捨てる。
 */
export function referencedUrls(root: ReferenceRoot, base: string): string[] {
  const urls: string[] = [];
  for (const element of root.querySelectorAll("script, link")) {
    const value = referencedValue(element);
    if (value === null || value === "") {
      continue;
    }
    try {
      urls.push(new URL(value, base).href);
    } catch {
      // 解釈できないURLは、自分のファイルとして数えない。
    }
  }
  return urls;
}
