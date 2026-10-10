// draw.io(mxGraph)のXMLを検証する。
// 図のXMLはDBではなく要件定義書のディレクトリ
// (`requirement_drafts.doc_dir`)に置く。
// Consoleはそれを読み出し、diagrams.netの埋め込みビューアーで表示する。
// 図のXMLは信頼できないIssueの内容に由来するので、リンクやHTMLの要素で
// 図の外へ出られる図は、加工せずに拒否する。

const MAX_XML_BYTES = 256 * 1024;

/**
 * 図に含めない属性名。小文字で持ち、比較は大文字小文字を区別しない。
 * `link`はセルやオブジェクトに外へのリンクを付け、`usemap`は画像にイメージマップを付ける。
 * 名前の完全一致だけを見るので、`linkTarget`や`placeholders`のような別の属性は拒否しない。
 */
const FORBIDDEN_ATTRIBUTES = ["link", "usemap"];

/**
 * ラベルのHTMLに含めない要素。ビューアは`html=1`のラベルをHTMLとして解釈するので、
 * リンク(`a`、`area`、`map`)、ページ遷移(`meta`)、別ページの埋め込み(`iframe`、`object`)を塞ぐ。
 * `<object>`は、ラベルの中では拒否するが、draw.ioがセルを包む要素としては正しい。
 */
const FORBIDDEN_HTML_PATTERN =
  /<\/?(?:a|area|map|meta|iframe|object)(?![\w-])/i;

/** 要素として図の構造に現れてはいけない名前。`object`はdraw.ioの正しい要素なので含めない。 */
const FORBIDDEN_ELEMENTS = ["a", "area", "map", "meta", "iframe"];

/** ラベルの`usemap`は、HTMLの属性の形(`usemap=`)のときだけ拒否する。 */
const USEMAP_IN_HTML_PATTERN = /\busemap\s*=/i;

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
    const match = FORBIDDEN_HTML_PATTERN.exec(current);
    if (match !== null) {
      return `ラベルのHTMLに${match[0]}が含まれています`;
    }
    if (USEMAP_IN_HTML_PATTERN.test(current)) {
      return "ラベルのHTMLにusemap属性が含まれています";
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
 * 契約は、ルートが`<mxfile>`であること、非圧縮であること、
 * `<diagram>`を1つ以上含むこと、256KB以下であること、
 * `link`属性と、ラベルのHTMLの`<a>`・`<area>`・`<map>`・`<meta>`・`<iframe>`・
 * `<object>`・`usemap`を含まないことの5つ。
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
  if (/\bcompressed\s*=\s*"true"/.test(mxfileAttrs)) {
    return {
      valid: false,
      reason:
        '<mxfile>にcompressed="true"が指定されています(非圧縮のXMLにしてください)',
    };
  }

  const diagramMatch = trimmed.match(/<diagram\b[^>]*>([\s\S]*?)<\/diagram>/);
  if (diagramMatch === null) {
    return { valid: false, reason: "<diagram> 要素がありません" };
  }

  const diagramBody = (diagramMatch[1] ?? "").trim();
  if (diagramBody.length > 0 && !diagramBody.includes("<")) {
    return {
      valid: false,
      reason:
        "diagramの内容が圧縮されているようです(非圧縮の<mxGraphModel>を渡してください)",
    };
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
