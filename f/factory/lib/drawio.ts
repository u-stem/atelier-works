// draw.io(mxGraph)のXMLを検証する。
// 図のXMLはDBではなく要件定義書のディレクトリ
// (`requirement_drafts.doc_dir`)に置く。
// Consoleはそれを読み出し、隔離したiframeの中で、diagrams.netの埋め込みビューアーが表示する。
// 図のXMLは信頼できないIssueの内容に由来するので、リンクやHTMLの要素で
// 図の外へ出られる図と、圧縮された図は、加工せずに拒否する。
// 生成の時点と、Consoleがディスクから読み戻す時点の両方で同じ検査をかける。

const MAX_XML_BYTES = 256 * 1024;

/**
 * 図に含めない属性名。小文字で持ち、比較は大文字小文字を区別しない。
 * `link`はセルやオブジェクトに外へのリンクを付け、`usemap`は画像にイメージマップを付ける。
 * 名前の完全一致だけを見るので、`linkTarget`や`placeholders`のような別の属性は拒否しない。
 */
const FORBIDDEN_ATTRIBUTES = ["link", "usemap"];

/**
 * 属性付きで現れたら拒否する、ラベルのHTMLの要素。
 * リンク(`a`、`area`、`map`)、ページ遷移(`meta`、`base`、`link`)、別ページや外部資源の埋め込み
 * (`iframe`、`object`、`embed`、`frame`、`img`、`image`、`video`、`audio`、`source`、`svg`、`use`)、
 * 送信(`form`、`input`、`button`)を塞ぐ。
 * `image`は、HTMLのパーサーが`img`に置き換えるので`img`と同じに扱う。
 * 属性を持たない`<Object>`や`<Map>`のような表記は、`Promise<Object>`のように型の書き方として
 * ラベルに現れるので通す。属性が無い要素は、行き先も資源のURLも持てない。
 * 「属性付き」は、要素名に空白か`/`が続き、その後に`名前=`が現れる形を指す。
 * `<object>`は、ラベルの中では拒否するが、draw.ioがセルを包む要素としては正しい。
 */
const ATTRIBUTE_BEARING_TAGS = [
  "a",
  "area",
  "map",
  "meta",
  "iframe",
  "object",
  "embed",
  "form",
  "base",
  "link",
  "img",
  "image",
  "input",
  "button",
  "svg",
  "use",
  "video",
  "audio",
  "source",
  "frame",
];

const ATTRIBUTE_BEARING_START_PATTERN = new RegExp(
  `<(${ATTRIBUTE_BEARING_TAGS.join("|")})(?=[\\s/])`,
  "gi",
);

/** 要素名の後ろに続く部分で、空白か`/`か引用符に続く`名前=`を探す。 */
const ATTRIBUTE_IN_TAG_PATTERN = /[\s/"'][^\s=>/"']+\s*=/;

/**
 * `text`に、属性付きの拒否する要素があるかを調べ、あれば要素名を返す。
 * 要素は、名前の後ろから最初の`>`までを範囲として、その中に`名前=`があるかで判定する。
 * 1つの正規表現で`<a <a <a ...`のような入力を調べると計算量が二乗になるので、
 * 開始位置ごとに探す。同じ`>`で終わる範囲は、先に失敗した範囲の一部なので、飛ばす。
 */
function findAttributeBearingTag(text: string): string | null {
  let closeIndex = -1;
  let failedCloseIndex = -2;
  for (const start of text.matchAll(ATTRIBUTE_BEARING_START_PATTERN)) {
    const tagName = start[1] ?? "";
    const from = start.index + start[0].length;
    if (closeIndex < from) {
      const found = text.indexOf(">", from);
      closeIndex = found === -1 ? text.length : found;
    }
    if (closeIndex === failedCloseIndex) {
      continue;
    }
    if (ATTRIBUTE_IN_TAG_PATTERN.test(text.slice(from, closeIndex))) {
      return tagName;
    }
    failedCloseIndex = closeIndex;
  }
  return null;
}

/**
 * 属性の有無を問わず拒否する要素。`<style>`は、図の外の画面の見た目を書き換えられる。
 */
const STYLE_ELEMENT_PATTERN = /<style(?![\w-])/i;

/** `<script`も属性の有無を問わず拒否する。 */
const SCRIPT_ELEMENT_PATTERN = /<script(?![\w-])/i;

/** イベントハンドラの属性名(`onclick`など)。`on`の後ろに英字が続く名前。 */
const EVENT_HANDLER_NAME_PATTERN = /^on[a-z]+$/i;

function isHtmlSpace(char: string): boolean {
  return (
    char === " " ||
    char === "\t" ||
    char === "\n" ||
    char === "\f" ||
    char === "\r"
  );
}

function isAsciiLetter(char: string): boolean {
  return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z");
}

/**
 * `position`(要素名の先頭)から始まる開始タグを、引用符を読みながら読む。
 * 属性名を前から順に調べ、イベントハンドラ属性があれば`handler`にその名前を入れる。
 * `end`は、タグを読み終えた位置(閉じていなければ文字列の長さ)。
 * 引用符の中の`>`ではタグが終わらないので、引用符を読んでから`>`を探す。
 * コメントやRCDATAの内側の引用符は、HTMLのパーサーが引用符として読まないことがあり、
 * この読み方だけではタグの終わりがずれる。そのずれは`findEventHandlerInRawTag`が補う。
 */
function scanStartTag(
  text: string,
  position: number,
): { handler: string | null; end: number } {
  let index = position;
  while (
    index < text.length &&
    !isHtmlSpace(text.charAt(index)) &&
    text.charAt(index) !== "/" &&
    text.charAt(index) !== ">"
  ) {
    index++;
  }
  while (index < text.length) {
    while (
      index < text.length &&
      (isHtmlSpace(text.charAt(index)) || text.charAt(index) === "/")
    ) {
      index++;
    }
    if (index >= text.length) {
      break;
    }
    if (text.charAt(index) === ">") {
      return { handler: null, end: index + 1 };
    }
    // 属性名の先頭の`=`は、名前の一部として読む。
    const nameStart = index;
    index++;
    while (index < text.length) {
      const char = text.charAt(index);
      if (isHtmlSpace(char) || char === "/" || char === ">" || char === "=") {
        break;
      }
      index++;
    }
    const name = text.slice(nameStart, index);
    while (index < text.length && isHtmlSpace(text.charAt(index))) {
      index++;
    }
    if (text.charAt(index) !== "=") {
      continue;
    }
    if (EVENT_HANDLER_NAME_PATTERN.test(name)) {
      return { handler: name, end: index };
    }
    index++;
    while (index < text.length && isHtmlSpace(text.charAt(index))) {
      index++;
    }
    const quote = text.charAt(index);
    if (quote === '"' || quote === "'") {
      const close = text.indexOf(quote, index + 1);
      index = close === -1 ? text.length : close + 1;
    } else {
      while (
        index < text.length &&
        !isHtmlSpace(text.charAt(index)) &&
        text.charAt(index) !== ">"
      ) {
        index++;
      }
    }
  }
  return { handler: null, end: text.length };
}

/** 引用符を読まない走査で、タグの区間の中のイベントハンドラ属性を探す。 */
const RAW_EVENT_HANDLER_PATTERN = /\bon[a-z]+\s*=/i;

/**
 * 引用符を読まずに、開始タグの区間の中のイベントハンドラ属性を探す。
 * 区間は、`<`に英字が続く位置から、次の`>`(無ければ文字列の終わり)までである。
 * 区間を調べたら、その`>`の後ろから次の`<`を探す。区間の途中の`<`から始め直さないので、
 * 計算量は入力の長さに比例する。手前から始まる区間が、後ろから始まる区間を含むためである。
 * コメント、偽のコメント、RCDATAの内側にある引用符の読み違いに影響されない。
 */
function findEventHandlerInRawTag(text: string): string | null {
  let index = text.indexOf("<");
  while (index !== -1) {
    if (!isAsciiLetter(text.charAt(index + 1))) {
      index = text.indexOf("<", index + 1);
      continue;
    }
    const close = text.indexOf(">", index + 1);
    const end = close === -1 ? text.length : close;
    const found = RAW_EVENT_HANDLER_PATTERN.exec(text.slice(index + 1, end));
    if (found !== null) {
      return found[0];
    }
    index = text.indexOf("<", end + 1);
  }
  return null;
}

/**
 * `text`の開始タグ(`<`に英字が続く箇所から`>`まで)の中に、イベントハンドラ属性
 * (`onclick=`など)があるかを調べ、あれば`名前=`の形で返す。
 * 次の2つの走査を行い、どちらかが当たれば返す。
 * - 引用符を読む走査。引用符の中の`>`でタグが終わらない書き方を、正しく読む。
 * - 引用符を読まない走査。コメントやRCDATAの内側を含め、`<`に英字が続く箇所をすべてタグとして調べる。
 * タグの外の文章(`one = 1`、`https://x/?online=1`)は見ない。
 * どちらの走査も、読み終えた位置から次の開始タグを探すので、計算量は入力の長さに比例する。
 */
function findEventHandlerInTag(text: string): string | null {
  let index = text.indexOf("<");
  while (index !== -1) {
    if (!isAsciiLetter(text.charAt(index + 1))) {
      index = text.indexOf("<", index + 1);
      continue;
    }
    const tag = scanStartTag(text, index + 1);
    if (tag.handler !== null) {
      return `${tag.handler}=`;
    }
    index = text.indexOf("<", tag.end);
  }
  return findEventHandlerInRawTag(text);
}

/**
 * ラベルのHTMLの属性の形(`名前=`)で現れたら拒否する属性。
 * `usemap`はイメージマップ、`formaction`は送信先、`srcdoc`は埋め込む文書を指す。
 */
const FORBIDDEN_HTML_ATTRIBUTE_PATTERN = /\b(?:usemap|formaction|srcdoc)\s*=/i;

/** 要素として図の構造に現れてはいけない名前。`object`はdraw.ioの正しい要素なので含めない。 */
const FORBIDDEN_ELEMENTS = ["a", "area", "map", "meta", "iframe"];

/**
 * 実体参照を何段まで復号して調べるか。
 * 二重三重にエスケープした`&amp;lt;a`も、段ごとに調べて拒否する。
 * 上限まで復号しても変わり続ける値は、調べきれないので拒否する。
 */
const MAX_DECODE_DEPTH = 5;

const ENTITY_PATTERN =
  /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(lt|gt|amp|quot|apos));?/g;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

function codePointToString(codePoint: number): string | null {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return null;
  }
  return String.fromCodePoint(codePoint);
}

/**
 * XMLとHTMLの実体参照(名前つきの5つと、10進と16進の数値文字参照)を1段だけ復号する。
 * XMLでは`;`が要るが、HTMLの解釈はそれを省いた参照も復号するので、安全側に倒して省いた形も復号する。
 * 復号できない参照は、そのまま残す。
 */
function decodeEntitiesOnce(text: string): string {
  return text.replace(
    ENTITY_PATTERN,
    (whole, decimal?: string, hex?: string, named?: string) => {
      if (named !== undefined) {
        return NAMED_ENTITIES[named] ?? whole;
      }
      const digits = decimal ?? hex;
      if (digits === undefined) {
        return whole;
      }
      const value = Number.parseInt(digits, decimal !== undefined ? 10 : 16);
      return codePointToString(value) ?? whole;
    },
  );
}

/**
 * 属性の値かテキストを、実体参照を段ごとに復号しながら調べ、
 * 拒否する理由を返す。問題が無ければ`null`を返す。
 * 復号前の値も調べる。壊れたXMLで`<`が値の中に生で残っていても見逃さないため。
 */
function findForbiddenHtml(raw: string): string | null {
  let current = raw;
  for (let depth = 0; depth <= MAX_DECODE_DEPTH; depth++) {
    const attributeBearing = findAttributeBearingTag(current);
    if (attributeBearing !== null) {
      return `ラベルのHTMLに属性付きの<${attributeBearing}>が含まれています`;
    }
    if (STYLE_ELEMENT_PATTERN.test(current)) {
      return "ラベルのHTMLに<style>が含まれています";
    }
    if (SCRIPT_ELEMENT_PATTERN.test(current)) {
      return "ラベルのHTMLに<script>が含まれています";
    }
    const handler = findEventHandlerInTag(current);
    if (handler !== null) {
      return `ラベルのHTMLにイベントハンドラ属性${handler}が含まれています`;
    }
    const attribute = FORBIDDEN_HTML_ATTRIBUTE_PATTERN.exec(current);
    if (attribute !== null) {
      return `ラベルのHTMLに${attribute[0]}が含まれています`;
    }
    const next = decodeEntitiesOnce(current);
    if (next === current) {
      return null;
    }
    current = next;
  }
  return "ラベルのエスケープが深すぎて検査できません";
}

type Token =
  | {
      readonly kind: "tag";
      readonly closing: boolean;
      readonly name: string;
      /** 要素名の後ろから`>`の手前まで。 */
      readonly attributes: string;
    }
  | { readonly kind: "cdata"; readonly text: string }
  | { readonly kind: "text"; readonly text: string }
  /** コメントと処理命令。中身は検査の対象にしない。 */
  | { readonly kind: "skip" };

/** 要素名。`<`と`>`と`/`と`!`と`?`と空白を含まない。 */
const TAG_NAME_PATTERN = /[^\s<>/!?]+/y;

/**
 * 要素名の後ろの属性部分。引用符の中は何でもよく、引用符の外には`<`と`>`を置けない。
 * 3つの選択肢は先頭の文字が重ならないので、どの位置でも読み方は1通りに決まる。
 */
const TAG_ATTRIBUTES_PATTERN = /(?:"[^"]*"|'[^']*'|[^<>"'])*/y;

/** `pattern`(stickyな正規表現)を`position`から当て、一致した文字列を返す。 */
function matchAt(
  pattern: RegExp,
  text: string,
  position: number,
): string | null {
  pattern.lastIndex = position;
  const found = pattern.exec(text);
  return found === null ? null : found[0];
}

/**
 * XMLを、コメント、CDATA、処理命令、タグ、テキストに切る。
 * 前から1回だけ読み、閉じていないコメント、CDATA、処理命令、タグ、引用符があれば`null`を返す。
 * 読める形に当てはまらない箇所を読み飛ばして進まないので、`null`でないときは、
 * トークンが文字列全体を隙間なく覆っている。
 * 正規表現1つでXML全体を読むと、`<`や`<a`を並べた入力で打ち切られ、
 * 打ち切られた手前までしか検査されないので、手書きで読む。
 */
function tokenize(xml: string): Token[] | null {
  const tokens: Token[] = [];
  let index = 0;
  while (index < xml.length) {
    if (xml[index] !== "<") {
      const next = xml.indexOf("<", index);
      const end = next === -1 ? xml.length : next;
      tokens.push({ kind: "text", text: xml.slice(index, end) });
      index = end;
    } else if (xml.startsWith("<!--", index)) {
      const end = xml.indexOf("-->", index + 4);
      if (end === -1) return null;
      tokens.push({ kind: "skip" });
      index = end + 3;
    } else if (xml.startsWith("<![CDATA[", index)) {
      const end = xml.indexOf("]]>", index + 9);
      if (end === -1) return null;
      tokens.push({ kind: "cdata", text: xml.slice(index + 9, end) });
      index = end + 3;
    } else if (xml.startsWith("<?", index)) {
      const end = xml.indexOf("?>", index + 2);
      if (end === -1) return null;
      tokens.push({ kind: "skip" });
      index = end + 2;
    } else {
      const closing = xml[index + 1] === "/";
      const nameStart = index + (closing ? 2 : 1);
      const name = matchAt(TAG_NAME_PATTERN, xml, nameStart);
      if (name === null) return null;
      const attributesStart = nameStart + name.length;
      const attributes = matchAt(TAG_ATTRIBUTES_PATTERN, xml, attributesStart);
      if (attributes === null) return null;
      const closeIndex = attributesStart + attributes.length;
      if (xml[closeIndex] !== ">") return null;
      tokens.push({ kind: "tag", closing, name, attributes });
      index = closeIndex + 1;
    }
  }
  return tokens;
}

const QUOTED_PATTERN = /"([^"]*)"|'([^']*)'/g;

/** タグの属性部分から、属性名の一覧と、属性の値の一覧を取り出す。 */
function parseAttributes(source: string): {
  names: string[];
  values: string[];
} {
  const values: string[] = [];
  const withoutValues = source.replace(
    QUOTED_PATTERN,
    (_whole, double?: string, single?: string) => {
      values.push(double ?? single ?? "");
      return " ";
    },
  );
  const names = withoutValues
    .replace(/[=/]/g, " ")
    .split(/\s+/)
    .filter((name) => name !== "");
  return { names, values };
}

/**
 * `<diagram>`の中に、空白以外のテキストかCDATAがあるかを調べ、あれば拒否する理由を返す。
 * draw.ioの圧縮した図は、`<diagram>`の中のテキストにある。
 * 非圧縮の図は要素と属性だけで書かれるので、`<diagram>`の中のテキストはすべて拒否する。
 * 圧縮した図は中身が見えず、リンクやHTMLの検査を素通りするため。
 * 圧縮を示す属性の有無は見ない。属性が無くても、テキストがあれば圧縮として読まれる。
 */
function findCompressedDiagram(tokens: readonly Token[]): string | null {
  const reason =
    "diagramの内容が圧縮されているようです(非圧縮の<mxGraphModel>を渡してください)";
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === "tag") {
      if (token.name.toLowerCase() !== "diagram") {
        continue;
      }
      if (token.closing) {
        depth = Math.max(0, depth - 1);
      } else if (!token.attributes.trimEnd().endsWith("/")) {
        depth += 1;
      }
      continue;
    }
    if (depth === 0) {
      continue;
    }
    if (token.kind === "cdata") {
      return reason;
    }
    if (token.kind === "text" && token.text.trim() !== "") {
      return reason;
    }
  }
  return null;
}

/**
 * 図のXMLが、外へのリンクやHTMLの要素を含むかを調べる。
 * 含むときは拒否する理由を、含まないときは`null`を返す。
 * 加工して取り除くことはしない。図の見た目が変わり、ビューアの解釈との差が
 * 新しい抜け道になるため。
 */
function findForbiddenContent(tokens: readonly Token[]): string | null {
  for (const token of tokens) {
    if (token.kind === "tag") {
      if (
        !token.closing &&
        FORBIDDEN_ELEMENTS.includes(token.name.toLowerCase())
      ) {
        return `<${token.name}>要素が含まれています`;
      }
      const { names, values } = parseAttributes(token.attributes);
      for (const name of names) {
        if (FORBIDDEN_ATTRIBUTES.includes(name.toLowerCase())) {
          return `${name}属性が含まれています`;
        }
      }
      for (const value of values) {
        const reason = findForbiddenHtml(value);
        if (reason !== null) {
          return reason;
        }
      }
      // `placeholders`を持つ要素では、ラベルの`%名前%`が他の属性の値に置き換わる。
      // タグや属性を複数の値に分けて書けるので、値をつなげた文字列も調べる。
      if (names.some((name) => name.toLowerCase() === "placeholders")) {
        const reason = findForbiddenHtml(values.join(""));
        if (reason !== null) {
          return reason;
        }
      }
    } else if (token.kind === "cdata" || token.kind === "text") {
      const reason = findForbiddenHtml(token.text);
      if (reason !== null) {
        return reason;
      }
    }
  }
  return null;
}

export type DrawioValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * draw.ioのXML文書1件が、drawio-diagramスキルの契約を満たすか検証する。
 * 契約は、ルートが`<mxfile>`であること、
 * すべての`<diagram>`が非圧縮であること(空白以外のテキストとCDATAを持たない)、
 * `<diagram>`を1つ以上含むこと、256KB以下であること、
 * `link`属性と、ラベルのHTMLの危険な要素と属性を含まないことの5つ。
 * 拒否するラベルのHTMLは、属性付きの`a`・`area`・`map`・`meta`・`iframe`・`object`などと、
 * `<style>`、`<script`、タグの中の`onclick=`のようなイベントハンドラ属性、
 * `usemap=`・`formaction=`・`srcdoc=`である。属性を持たない`<Object>`のような
 * 型の表記は通す。`placeholders`を持つ要素では、属性の値をつなげた文字列も調べる。
 * 実体参照は段ごとに復号して調べる。二重に実体参照を書いた値は、実際に何として読まれるかを
 * 追わず、安全側に倒して復号して拒否する。
 * 満たさないときは、理由を添えて`valid: false`を返す。
 */
export function validateDrawioXml(xml: string): DrawioValidationResult {
  const size = byteLength(xml);
  if (size > MAX_XML_BYTES) {
    return {
      valid: false,
      reason: `XMLが256KBを超えています(${size} bytes)`,
    };
  }

  const tokens = tokenize(xml.trim());
  if (tokens === null) {
    return {
      valid: false,
      reason: "XMLの構文が不正です(閉じていない <、コメント、引用符があります)",
    };
  }

  const root = tokens[0];
  if (root?.kind !== "tag" || root.closing || root.name !== "mxfile") {
    return { valid: false, reason: "ルート要素が <mxfile> ではありません" };
  }

  if (/\bcompressed\s*=\s*["']true["']/i.test(root.attributes)) {
    return {
      valid: false,
      reason:
        '<mxfile>にcompressed="true"が指定されています(非圧縮のXMLにしてください)',
    };
  }

  const hasDiagram = tokens.some(
    (token) =>
      token.kind === "tag" && !token.closing && token.name === "diagram",
  );
  if (!hasDiagram) {
    return { valid: false, reason: "<diagram> 要素がありません" };
  }

  const compressed = findCompressedDiagram(tokens);
  if (compressed !== null) {
    return { valid: false, reason: compressed };
  }

  const forbidden = findForbiddenContent(tokens);
  if (forbidden !== null) {
    return {
      valid: false,
      reason: `${forbidden}(リンクとHTMLの要素は使えません。図から取り除いてください)`,
    };
  }

  return { valid: true };
}
