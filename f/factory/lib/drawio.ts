// draw.io (mxGraph) XML validation and viewer-URL encoding.
//
// Encoding follows the diagrams.net URL-fragment convention: the XML is
// URI-encoded, DEFLATE-compressed (raw, no zlib header — matches pako's
// `deflateRaw`, confirmed against `node:zlib`'s `deflateRawSync` during the
// M4 contract smoke), then standard base64-encoded (see toViewerUrl). The
// fragment (`#...`) is never sent to the diagrams.net server by the
// browser. The resulting URL is never posted to GitHub or Discord (2026-09-27
// policy) — it is only ever read from the factory_console App's Inbox tab
// (see steps/console_query.ts), so only someone with Console access can view
// a diagram (see docs/security.md "draw.io ビューアーのプライバシー").
//
// See also: .claude/skills/drawio-diagram/SKILL.md (the generation-side
// contract: uncompressed XML, 12KB limit, `[a-z0-9-]+` diagram names).

const MAX_XML_BYTES = 12 * 1024;
const MAX_VIEWER_URL_FRAGMENT_BYTES = 8 * 1024;
const DEFAULT_VIEWER_BASE_URL = "https://viewer.diagrams.net/";

export type DrawioValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Validate a single draw.io/mxGraph XML document against the
 * drawio-diagram skill's contract: `<mxfile>` root, uncompressed, contains
 * at least one `<diagram>`, and no larger than 12KB.
 */
export function validateDrawioXml(xml: string): DrawioValidationResult {
  const size = byteLength(xml);
  if (size > MAX_XML_BYTES) {
    return {
      valid: false,
      reason: `XML が 12KB を超えています(${size} bytes)`,
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
        '<mxfile> に compressed="true" が指定されています(非圧縮の XML にしてください)',
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
        "diagram の内容が圧縮されているようです(非圧縮の <mxGraphModel> を渡してください)",
    };
  }

  return { valid: true };
}

/**
 * Encode a draw.io XML document as a `viewer.diagrams.net` URL fragment
 * (encodeURIComponent → raw DEFLATE → standard base64). The viewer decodes
 * `#R<data>` with `atob()`, which only accepts standard base64: a URL-safe
 * variant (`-` / `_`, padding stripped) made it fail with "The string to be
 * decoded is not correctly encoded" (observed in the Console's iframe).
 * `+`, `/` and `=` are legal inside a URL fragment, so no further escaping
 * is applied. Returns `null` when the encoded fragment exceeds 8KB
 * (spec-cycle2.md §1 drawio.ts) — callers should fall back to embedding
 * the diagram name only.
 */
export function toViewerUrl(
  xml: string,
  baseUrl: string = DEFAULT_VIEWER_BASE_URL,
): string | null {
  const uriEncoded = encodeURIComponent(xml);
  const deflated = Bun.deflateSync(new TextEncoder().encode(uriEncoded));
  const base64 = Buffer.from(deflated).toString("base64");

  if (byteLength(base64) > MAX_VIEWER_URL_FRAGMENT_BYTES) {
    return null;
  }

  return `${baseUrl}?lightbox=1#R${base64}`;
}
