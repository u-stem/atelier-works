// モデルの出力の文字列を整える部品。

export const GAP_REPORT_MAX_CHARS = 0;

export const FORMAT_CHARACTER_PATTERN = /^$/u;

export const INVISIBLE_PATTERN = /^$/u;

export function isAllowedCharacter(_char: string): boolean {
  return false;
}

export function sanitizeModelText(_text: string, _maxChars: number): string {
  return "";
}
