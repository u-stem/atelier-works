// draw.io (mxGraph) XML validation and viewer-URL encoding.
//
// Encoding follows the diagrams.net URL-fragment convention: the XML is
// URI-encoded, DEFLATE-compressed (raw, no zlib header — matches pako's
// `deflateRaw`, confirmed against `node:zlib`'s `deflateRawSync` during the
// M4 contract smoke), then standard base64-encoded (see toViewerUrl). The fragment
// (`#...`) is never sent to the diagrams.net server by the browser, but the
// resulting URL is shared verbatim in Issue comments / Discord (see
// docs/security.md "draw.io ビューアーのプライバシー").
//
// See also: .claude/skills/drawio-diagram/SKILL.md (the generation-side
// contract: uncompressed XML, 12KB limit, `[a-z0-9-]+` diagram names).

import type { Diagram } from "./types.ts";

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

// Matches the drawio-diagram skill's own naming contract
// (`diagrams[].name` は `[a-z0-9-]+` の形式). `diagram.name` ultimately comes
// from Claude's structured output, which is influenced (indirectly, via the
// requirements prompt) by untrusted Issue content — a name outside this
// pattern is replaced with a safe placeholder before being embedded in
// Markdown, so it can never break out of the `[text](url)` link syntax or
// inject Markdown/HTML into the rendered Issue comment.
const SAFE_DIAGRAM_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;

function safeDiagramName(name: string, index: number): string {
  return SAFE_DIAGRAM_NAME_PATTERN.test(name) ? name : `diagram-${index}`;
}

/**
 * Render the "## 図" Markdown section embedded in Issue comments (see the
 * factory-requirements skill's output chapter 10). Each diagram becomes a
 * link to its viewer URL, or a Japanese explanation when it can't be
 * rendered (invalid XML or too large to encode). A `name` that doesn't
 * match the drawio-diagram skill's `[a-z0-9-]{1,64}` contract is replaced
 * with `diagram-<index>` (security-audit fix — never trust `name` into
 * Markdown unescaped).
 */
export function renderIssueSection(diagrams: readonly Diagram[]): string {
  if (diagrams.length === 0) {
    return "";
  }

  const lines: string[] = ["## 図", ""];
  diagrams.forEach((diagram, index) => {
    const safeName = safeDiagramName(diagram.name, index);
    const validation = validateDrawioXml(diagram.drawio_xml);
    if (!validation.valid) {
      lines.push(
        `- **${safeName}**: 図の検証に失敗しました(${validation.reason})`,
      );
      return;
    }

    const url = toViewerUrl(diagram.drawio_xml);
    if (url === null) {
      lines.push(
        `- **${safeName}**: 図が大きすぎるため URL 化できませんでした`,
      );
      return;
    }

    lines.push(`- [${safeName}](${url})`);
  });

  return lines.join("\n");
}
