// draw.io (mxGraph) XML validation.
//
// `validateDrawioXml` is used by pipeline_generate.ts's post-generation
// checks (uncompressed `<mxfile>` XML, 256KB limit — see
// .claude/skills/drawio-diagram/SKILL.md for the generation-side contract).
//
// A diagram's XML lives on disk under pipeline_generate.ts's requirements
// doc dir (`requirement_drafts.doc_dir`), not in the DB. The Console now
// renders it inline via the diagrams.net embed viewer
// (`components/DrawioViewer.tsx`, `f/factory/steps/console_query.ts`'s
// `requirements_doc` view reads the file back) — the former
// `toViewerUrl`/URL-fragment encoding this file used to provide (a static
// `viewer.diagrams.net` link, superseded by the embed viewer) has been
// removed along with it (see docs/security.md "draw.io ビューアーの
// プライバシー").

const MAX_XML_BYTES = 256 * 1024;

export type DrawioValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Validate a single draw.io/mxGraph XML document against the
 * drawio-diagram skill's contract: `<mxfile>` root, uncompressed, contains
 * at least one `<diagram>`, and no larger than 256KB.
 */
export function validateDrawioXml(xml: string): DrawioValidationResult {
  const size = byteLength(xml);
  if (size > MAX_XML_BYTES) {
    return {
      valid: false,
      reason: `XML が 256KB を超えています(${size} bytes)`,
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
