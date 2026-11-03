import { Markdown } from "../../components/markdown/Markdown.tsx";
import { displayableIssueText } from "../../lib/intakeText.ts";
import type { RepoRef } from "../../lib/markdownLink.ts";

// 取り込み時点のIssueのパネルの同名の定数は公開されていないので、ここにも置く。
/** プレビューの本文の目次。プレビューは見出しの`id`を持たないので、空にする。 */
const NO_HEADINGS: readonly never[] = [];

/** プレビューは図を描かない。`.drawio`の参照は、図の名前を文字で出す。 */
const NO_DIAGRAMS: readonly never[] = [];

/**
 * 設計書の全文を、読みやすく整えた参考の表示で出す。承認の対象は原文で、この表示は承認の判断に使わない。
 * 見えない文字を置き換えた本文を`Markdown`に渡す。
 * `Markdown`は生のHTMLを描かず、リンクは`repo`のIssueとPRに絞り、画像は文字で出す。
 * `repo`が`null`のときは、リンクを作らない。
 * 注記は持たない。注記と、プレビュー中に承認を止める判定は、呼び出し側の画面が持つ。
 * `repo`は、呼び出し側が同じ参照を渡し続ける(`Markdown`が参照で描き直しを判断するため)。
 */
export function DesignTextPreview({
  text,
  repo,
}: {
  text: string;
  repo: RepoRef | null;
}) {
  return (
    <div
      data-preview
      dir="ltr"
      className="max-h-[40rem] overflow-auto rounded-md border border-border bg-background px-4 py-3 text-small text-foreground [unicode-bidi:isolate]"
    >
      <Markdown
        markdown={displayableIssueText(text).text}
        headings={NO_HEADINGS}
        diagrams={NO_DIAGRAMS}
        rejectedDiagrams={NO_DIAGRAMS}
        repo={repo}
      />
    </div>
  );
}
