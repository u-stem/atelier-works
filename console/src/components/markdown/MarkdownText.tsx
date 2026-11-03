/**
 * Markdownの本文を、解釈せずに文字として出す。
 * プレビューが描かないHTMLのコメントとリンク参照定義も、書かれたとおりに見える。
 * 呼び出し側は、見えない文字を置き換えた後の本文を渡す。
 * 長い行は折り返し、横にスクロールする領域を作らない。
 */
export function MarkdownText({ markdown }: { markdown: string }) {
  return (
    <pre
      dir="ltr"
      className="whitespace-pre-wrap break-words rounded-lg bg-muted px-4 py-3 font-mono text-small text-foreground"
    >
      {markdown}
    </pre>
  );
}
