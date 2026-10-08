// draw.io(mxGraph)のXMLを検証する。
// 図のXMLはDBではなく要件定義書のディレクトリ
// (`requirement_drafts.doc_dir`)に置く。
// Consoleはそれを読み出し、diagrams.netの埋め込みビューアーで表示する。

const MAX_XML_BYTES = 256 * 1024;

export type DrawioValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * draw.ioのXML文書1件が、drawio-diagramスキルの契約を満たすか検証する。
 * 契約は、ルートが`<mxfile>`であること、非圧縮であること、
 * `<diagram>`を1つ以上含むこと、256KB以下であることの4つ。
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

  return { valid: true };
}
