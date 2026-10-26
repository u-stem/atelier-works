export type DesignDocValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: string[] };

export function checkDesignIds(_markdown: string): string[] {
  return [];
}

export function validateDesignDoc(
  _markdown: string,
  _diagramFiles: readonly string[],
): DesignDocValidation {
  return { ok: true };
}
