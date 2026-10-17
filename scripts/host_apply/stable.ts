/** 設定ファイルの解釈の比較に使う、小さな部品。 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** キーの順序に依らない文字列にする。解釈が同じかを比べるために使う。 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * ログと通知に書ける形にする。ASCIIの印字できる文字以外(ASCII以外の文字と制御文字)は、`\uXXXX`で書く。
 * 目標が書いた値を、そのまま出力すると、端末の制御や紛らわしい文字を出力に混ぜられるため。
 */
export function escapeDetail(text: string): string {
  return text.replace(
    /[^\x20-\x7e]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
