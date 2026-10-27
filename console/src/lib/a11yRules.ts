// 描画したHTMLの文字列を静的に検査する、アクセシビリティの規則。依存を持たない。
// 見られるのは、描画した時点のHTMLに書かれた属性と文字だけである。
// 動的な属性(開閉で変わる`aria-expanded`など)、フォーカスの移動、ポータルに描く内容(Tooltip)は見えない。

export type A11yRuleId =
  | "idref"
  | "duplicate-id"
  | "heading-order"
  | "input-label"
  | "button-name"
  | "link-name";

export type A11yViolation = {
  readonly rule: A11yRuleId;
  readonly message: string;
};

export type A11yOptions = {
  /** 検査する断片の前にある見出しの段。ページの見出し(h1)が断片の外にあるときは1にする。 */
  readonly headingStart?: number;
};

type TextNode = { readonly kind: "text"; readonly text: string };

type ElementNode = {
  readonly kind: "element";
  readonly tag: string;
  readonly attrs: ReadonlyMap<string, string>;
  readonly children: HtmlNode[];
  readonly parent: ElementNode | null;
};

type HtmlNode = TextNode | ElementNode;

const VOID_TAGS: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

const RAW_TEXT_TAGS: ReadonlySet<string> = new Set(["script", "style"]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body) => {
    if (typeof body !== "string") {
      return whole;
    }
    if (body.startsWith("#")) {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function isSpace(character: string | undefined): boolean {
  return character !== undefined && /\s/.test(character);
}

function isLetter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z]/.test(character);
}

type StartTag = {
  readonly name: string;
  readonly attrs: Map<string, string>;
  readonly selfClosing: boolean;
  /** 開始タグの次の位置。 */
  readonly end: number;
};

/** `html[start]`の`<`から始まる開始タグを読む。引用符の中の`>`は閉じとして扱わない。 */
function readStartTag(html: string, start: number): StartTag {
  const length = html.length;
  let index = start + 1;
  const nameStart = index;
  while (index < length && /[A-Za-z0-9:_-]/.test(html.charAt(index))) {
    index += 1;
  }
  const name = html.slice(nameStart, index).toLowerCase();
  const attrs = new Map<string, string>();
  let selfClosing = false;
  while (index < length) {
    while (isSpace(html[index])) {
      index += 1;
    }
    if (index >= length) {
      break;
    }
    if (html[index] === ">") {
      index += 1;
      break;
    }
    if (html.startsWith("/>", index)) {
      selfClosing = true;
      index += 2;
      break;
    }
    if (html[index] === "/") {
      index += 1;
      continue;
    }
    const attrStart = index;
    while (index < length && !/[\s=>/]/.test(html.charAt(index))) {
      index += 1;
    }
    const attrName = html.slice(attrStart, index).toLowerCase();
    while (isSpace(html[index])) {
      index += 1;
    }
    let value = "";
    if (html[index] === "=") {
      index += 1;
      while (isSpace(html[index])) {
        index += 1;
      }
      const quote = html[index];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, index + 1);
        const valueEnd = close < 0 ? length : close;
        value = html.slice(index + 1, valueEnd);
        index = close < 0 ? length : close + 1;
      } else {
        const valueStart = index;
        while (index < length && !/[\s>]/.test(html.charAt(index))) {
          index += 1;
        }
        value = html.slice(valueStart, index);
      }
    }
    if (attrName !== "" && !attrs.has(attrName)) {
      attrs.set(attrName, decodeEntities(value));
    }
  }
  return { name, attrs, selfClosing, end: index };
}

function createElement(
  tag: string,
  attrs: ReadonlyMap<string, string>,
  parent: ElementNode | null,
): ElementNode {
  return { kind: "element", tag, attrs, children: [], parent };
}

/**
 * HTMLを木にする。Reactが書く整ったHTMLを読むための小さな字句解析で、仕様の全体は扱わない。
 * 対応の無い終了タグは捨てる。終了タグの無い要素は、親の終わりで閉じる。
 */
function parseHtml(html: string): ElementNode {
  const root = createElement("#root", new Map(), null);
  let current = root;
  let index = 0;
  const length = html.length;
  while (index < length) {
    if (html.startsWith("<!--", index)) {
      const end = html.indexOf("-->", index + 4);
      index = end < 0 ? length : end + 3;
    } else if (html.startsWith("<!", index) || html.startsWith("<?", index)) {
      const end = html.indexOf(">", index);
      index = end < 0 ? length : end + 1;
    } else if (html.startsWith("</", index)) {
      const end = html.indexOf(">", index);
      const name = html
        .slice(index + 2, end < 0 ? length : end)
        .trim()
        .toLowerCase();
      index = end < 0 ? length : end + 1;
      let open: ElementNode = current;
      while (open.parent !== null && open.tag !== name) {
        open = open.parent;
      }
      if (open.parent !== null) {
        current = open.parent;
      }
    } else if (html[index] === "<" && isLetter(html[index + 1])) {
      const tag = readStartTag(html, index);
      index = tag.end;
      const element = createElement(tag.name, tag.attrs, current);
      current.children.push(element);
      if (RAW_TEXT_TAGS.has(tag.name)) {
        const close = html.toLowerCase().indexOf(`</${tag.name}`, index);
        const end = close < 0 ? -1 : html.indexOf(">", close);
        index = end < 0 ? length : end + 1;
      } else if (!VOID_TAGS.has(tag.name) && !tag.selfClosing) {
        current = element;
      }
    } else {
      const next = html.indexOf("<", index + 1);
      const end = next < 0 ? length : next;
      current.children.push({
        kind: "text",
        text: decodeEntities(html.slice(index, end)),
      });
      index = end;
    }
  }
  return root;
}

function elementsOf(node: ElementNode): ElementNode[] {
  return node.children.flatMap((child) =>
    child.kind === "element" ? [child, ...elementsOf(child)] : [],
  );
}

function isBlank(text: string | undefined): boolean {
  return text === undefined || text.trim() === "";
}

/** 要素か祖先が、支援技術から隠されているか。 */
function isHidden(element: ElementNode): boolean {
  for (
    let node: ElementNode | null = element;
    node !== null;
    node = node.parent
  ) {
    if (node.attrs.get("aria-hidden") === "true" || node.attrs.has("hidden")) {
      return true;
    }
  }
  return false;
}

/** 隠れた部分も含めた、要素の中の文字。`aria-labelledby`の参照先の読み取りに使う。 */
function fullText(node: HtmlNode): string {
  return node.kind === "text"
    ? node.text
    : node.children.map(fullText).join("");
}

/**
 * 内容から決まる名前。隠された子は読まない。
 * 子が`aria-label`を持てばそれを使い、画像は`alt`を使う。
 */
function contentName(element: ElementNode): string {
  return element.children
    .map((child) => {
      if (child.kind === "text") {
        return child.text;
      }
      if (
        child.attrs.get("aria-hidden") === "true" ||
        child.attrs.has("hidden")
      ) {
        return "";
      }
      const label = child.attrs.get("aria-label");
      if (!isBlank(label)) {
        return label ?? "";
      }
      if (child.tag === "img") {
        return child.attrs.get("alt") ?? "";
      }
      return contentName(child);
    })
    .join(" ");
}

function tokens(value: string | undefined): string[] {
  return (value ?? "").split(/\s+/).filter((token) => token !== "");
}

type Document = {
  readonly all: readonly ElementNode[];
  readonly byId: ReadonlyMap<string, readonly ElementNode[]>;
};

function indexDocument(root: ElementNode): Document {
  const all = elementsOf(root);
  const byId = new Map<string, ElementNode[]>();
  for (const element of all) {
    const id = element.attrs.get("id");
    if (id !== undefined && id !== "") {
      byId.set(id, [...(byId.get(id) ?? []), element]);
    }
  }
  return { all, byId };
}

/** `aria-labelledby`の参照先のうち、存在して文字を持つものの文字。 */
function labelledByText(element: ElementNode, document: Document): string {
  return tokens(element.attrs.get("aria-labelledby"))
    .flatMap((id) => document.byId.get(id) ?? [])
    .map(fullText)
    .join(" ");
}

/** ボタンとリンクの名前。`aria-labelledby`、`aria-label`、内容、`title`の順に見る。 */
function accessibleName(element: ElementNode, document: Document): string {
  const labelled = labelledByText(element, document);
  if (!isBlank(labelled)) {
    return labelled;
  }
  const label = element.attrs.get("aria-label");
  if (!isBlank(label)) {
    return label ?? "";
  }
  const content = contentName(element);
  if (!isBlank(content)) {
    return content;
  }
  return element.attrs.get("title") ?? "";
}

const REFERENCE_ATTRIBUTES = [
  "aria-labelledby",
  "aria-describedby",
  "aria-controls",
  "aria-activedescendant",
] as const;

/**
 * 参照先のidが存在すること。
 * 閉じた状態(`aria-expanded="false"`)の`aria-controls`は、参照先をまだ描かないことがあるので見ない。
 */
function checkReferences(document: Document): A11yViolation[] {
  return document.all.flatMap((element) =>
    REFERENCE_ATTRIBUTES.flatMap((attribute): A11yViolation[] => {
      const value = element.attrs.get(attribute);
      if (value === undefined) {
        return [];
      }
      if (
        attribute === "aria-controls" &&
        element.attrs.get("aria-expanded") === "false"
      ) {
        return [];
      }
      const missing = tokens(value).filter((id) => !document.byId.has(id));
      return missing.length === 0
        ? []
        : [
            {
              rule: "idref",
              message: `<${element.tag}> ${attribute} points at a missing id: ${missing.join(" ")}`,
            },
          ];
    }),
  );
}

function checkDuplicateIds(document: Document): A11yViolation[] {
  return [...document.byId.entries()]
    .filter(([, elements]) => elements.length > 1)
    .map(([id, elements]) => ({
      rule: "duplicate-id",
      message: `id "${id}" is used by ${elements.length} elements`,
    }));
}

const HEADING_LEVELS: Readonly<Record<string, number>> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};

/** 見出しの段が、直前の段より2つ以上深くならないこと。浅くなる向きは何段でもよい。 */
function checkHeadingOrder(document: Document, start: number): A11yViolation[] {
  const violations: A11yViolation[] = [];
  let previous = start;
  for (const element of document.all) {
    const level = HEADING_LEVELS[element.tag];
    if (level === undefined || isHidden(element)) {
      continue;
    }
    if (level > previous + 1) {
      violations.push({
        rule: "heading-order",
        message: `<${element.tag}> follows a level ${previous} heading`,
      });
    }
    previous = level;
  }
  return violations;
}

const UNLABELLED_INPUT_TYPES: ReadonlySet<string> = new Set([
  "hidden",
  "submit",
  "reset",
  "button",
  "image",
]);

function needsLabel(element: ElementNode): boolean {
  if (element.tag === "input") {
    return !UNLABELLED_INPUT_TYPES.has(
      (element.attrs.get("type") ?? "text").toLowerCase(),
    );
  }
  if (element.tag === "textarea" || element.tag === "select") {
    return true;
  }
  const role = element.attrs.get("role");
  return role === "combobox" || role === "textbox" || role === "searchbox";
}

function hasInputLabel(element: ElementNode, document: Document): boolean {
  if (!isBlank(element.attrs.get("aria-label"))) {
    return true;
  }
  if (!isBlank(labelledByText(element, document))) {
    return true;
  }
  if (!isBlank(element.attrs.get("title"))) {
    return true;
  }
  const id = element.attrs.get("id");
  if (
    id !== undefined &&
    id !== "" &&
    document.all.some(
      (candidate) =>
        candidate.tag === "label" &&
        candidate.attrs.get("for") === id &&
        !isBlank(fullText(candidate)),
    )
  ) {
    return true;
  }
  for (let node = element.parent; node !== null; node = node.parent) {
    if (node.tag === "label" && !isBlank(fullText(node))) {
      return true;
    }
  }
  return false;
}

function checkInputLabels(document: Document): A11yViolation[] {
  return document.all
    .filter(
      (element) =>
        needsLabel(element) &&
        !isHidden(element) &&
        !hasInputLabel(element, document),
    )
    .map((element) => ({
      rule: "input-label",
      message: `<${element.tag}> has no label`,
    }));
}

function checkNames(
  document: Document,
  rule: "button-name" | "link-name",
  matches: (element: ElementNode) => boolean,
): A11yViolation[] {
  return document.all
    .filter(
      (element) =>
        matches(element) &&
        !isHidden(element) &&
        isBlank(accessibleName(element, document)),
    )
    .map((element) => ({
      rule,
      message: `<${element.tag}> has no accessible name`,
    }));
}

function isButton(element: ElementNode): boolean {
  return element.tag === "button" || element.attrs.get("role") === "button";
}

function isLink(element: ElementNode): boolean {
  return (
    (element.tag === "a" && element.attrs.has("href")) ||
    element.attrs.get("role") === "link"
  );
}

/** 描画したHTMLを検査し、違反を返す。違反が無ければ空の配列を返す。 */
export function checkA11y(
  html: string,
  options: A11yOptions = {},
): readonly A11yViolation[] {
  const document = indexDocument(parseHtml(html));
  return [
    ...checkReferences(document),
    ...checkDuplicateIds(document),
    ...checkHeadingOrder(document, options.headingStart ?? 0),
    ...checkInputLabels(document),
    ...checkNames(document, "button-name", isButton),
    ...checkNames(document, "link-name", isLink),
  ];
}
