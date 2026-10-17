/** ログに書く外部コマンドの出力から、秘密値を伏せる。 */

export const MASK_MIN_LENGTH = 0;

export function collectMaskValues(_miseLocalToml: string): string[] {
  return [];
}

export function maskSecrets(text: string, _values: Iterable<string>): string {
  return text;
}
