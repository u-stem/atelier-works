// Issueの題名と本文を画面に出す前に通す整形。
// 起票者が書いた文字列なので、見た目の順序を入れ替える制御文字を、そのまま描かない。

/**
 * 見た目を入れ替えるか、画面に出せない制御文字か。
 * 双方向テキストの制御文字(U+202A〜U+202E、U+2066〜U+2069)は、文字の並びの見た目を入れ替え、
 * 承認者が読む内容と実際の内容をずらせる。
 * 改行(U+000A)とタブ(U+0009)以外の制御文字(U+0000〜U+001F、U+007F)も出せない。
 */
function isHiddenControl(code: number): boolean {
  if (code === 0x09 || code === 0x0a) return false;
  return (
    code <= 0x1f ||
    code === 0x7f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * `text`を画面に出せる形にする。改行コードを`\n`に揃え、
 * 見た目をずらす制御文字を代替文字(U+FFFD)に置き換える。
 * 内容は解釈しない。HTMLやMarkdownとしては描かず、呼び出し側はReactの文字列として出す。
 */
export function displayableIssueText(text: string): string {
  const normalized = text.replaceAll("\r\n", "\n");
  let result = "";
  for (const char of normalized) {
    const code = char.codePointAt(0) ?? 0;
    result += isHiddenControl(code) ? "\uFFFD" : char;
  }
  return result;
}
