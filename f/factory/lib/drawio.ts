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
 * (`iframe`、`object`、`embed`、`frame`、`img`、`video`、`audio`、`source`、`svg`、`use`)、
 * 送信(`form`、`input`、`button`)を塞ぐ。
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

/**
 * XMLを、コメント、CDATA、処理命令、タグ、テキストの順に切る。
 * 引用符の中の`>`をタグの終わりと取り違えないよう、タグは引用符を数えて読む。
 */
const TOKEN_PATTERN =
  /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<(\/?)([^\s>/!?]+)((?:"[^"]*"|'[^']*'|[^>"'])*)>|[^<]+|</g;

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
function findCompressedDiagram(xml: string): string | null {
  const reason =
    "diagramの内容が圧縮されているようです(非圧縮の<mxGraphModel>を渡してください)";
  let depth = 0;
  for (const token of xml.matchAll(TOKEN_PATTERN)) {
    const [whole, cdata, closing, tagName, attrSource] = token;
    if (tagName !== undefined) {
      if (tagName.toLowerCase() !== "diagram") {
        continue;
      }
      if (closing === "/") {
        depth = Math.max(0, depth - 1);
      } else if (!(attrSource ?? "").trimEnd().endsWith("/")) {
        depth += 1;
      }
      continue;
    }
    if (depth === 0) {
      continue;
    }
    if (cdata !== undefined) {
      return reason;
    }
    if (!whole.startsWith("<") && whole.trim() !== "") {
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
function findForbiddenContent(xml: string): string | null {
  for (const token of xml.matchAll(TOKEN_PATTERN)) {
    const [whole, cdata, closing, tagName, attrSource] = token;
    if (whole === "<") {
      return "XMLの構文が不正です(閉じていない < があります)";
    }
    if (tagName !== undefined) {
      if (
        closing !== "/" &&
        FORBIDDEN_ELEMENTS.includes(tagName.toLowerCase())
      ) {
        return `<${tagName}>要素が含まれています`;
      }
      const { names, values } = parseAttributes(attrSource ?? "");
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
      continue;
    }
    if (cdata !== undefined) {
      const reason = findForbiddenHtml(cdata);
      if (reason !== null) {
        return reason;
      }
      continue;
    }
    if (!whole.startsWith("<")) {
      const reason = findForbiddenHtml(whole);
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
 * `<style>`、`usemap=`・`formaction=`・`srcdoc=`である。属性を持たない`<Object>`のような
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

  const trimmed = xml.trim();
  const mxfileOpenTagMatch = trimmed.match(/^<mxfile\b([^>]*)>/);
  if (mxfileOpenTagMatch === null) {
    return { valid: false, reason: "ルート要素が <mxfile> ではありません" };
  }

  const mxfileAttrs = mxfileOpenTagMatch[1] ?? "";
  if (/\bcompressed\s*=\s*["']true["']/i.test(mxfileAttrs)) {
    return {
      valid: false,
      reason:
        '<mxfile>にcompressed="true"が指定されています(非圧縮のXMLにしてください)',
    };
  }

  if (!/<diagram\b[^>]*>/.test(trimmed)) {
    return { valid: false, reason: "<diagram> 要素がありません" };
  }

  const compressed = findCompressedDiagram(trimmed);
  if (compressed !== null) {
    return { valid: false, reason: compressed };
  }

  const forbidden = findForbiddenContent(trimmed);
  if (forbidden !== null) {
    return {
      valid: false,
      reason: `${forbidden}(リンクとHTMLの要素は使えません。図から取り除いてください)`,
    };
  }

  return { valid: true };
}
