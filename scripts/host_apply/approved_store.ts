/** 承認の記録の型と、その読み書きの形式。ファイルには触れない。 */

export type ApprovedRecord = {
  readonly schema: 1;
  readonly sha: string;
  readonly applied: string;
  readonly approved_at: string;
  readonly files: readonly { readonly path: string; readonly status: string }[];
};

/** 記録の大きさの上限(バイト)。 */
export const MAX_APPROVED_BYTES = 64 * 1024;

export function isApprovedRecord(_value: unknown): _value is ApprovedRecord {
  return false;
}

export function parseApprovedRecord(_text: string): ApprovedRecord | null {
  return null;
}

export function serializeApprovedRecord(_record: ApprovedRecord): string {
  return "";
}
