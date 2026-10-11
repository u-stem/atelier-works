import { Copy } from "lucide-react";
import { toast } from "sonner";
import type { NoticeMessagePart } from "../../lib/noticeView.ts";

async function copySha(sha: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(sha);
    toast.success("版を複製しました");
  } catch {
    toast.error("版を複製できませんでした");
  }
}

/** 先頭7桁で示す版。全体はtitleに載せ、複製のボタンで取り出せる。 */
function ShaChip({ shortText, sha }: { shortText: string; sha: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <code
        title={sha}
        className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-small text-foreground"
      >
        {shortText}
      </code>
      <button
        type="button"
        aria-label={`版${shortText}の全体を複製`}
        className="inline-flex size-5 items-center justify-center self-center rounded-sm text-subtle outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          void copySha(sha);
        }}
      >
        <Copy aria-hidden="true" className="size-3.5" />
      </button>
    </span>
  );
}

/**
 * 通知の本文の部品を並べる。版は先頭7桁に縮め、全体を複製できるようにする。
 * 本文は信頼できない文字を含みうるので、すべてプレーンテキストとして描く。
 */
export function NoticeMessageText({
  parts,
}: {
  parts: readonly NoticeMessagePart[];
}) {
  return (
    <>
      {parts.map((part, index) =>
        part.sha === undefined ? (
          // 部品は並びが変わらない静的な分割なので、位置を鍵にしてよい。
          // biome-ignore lint/suspicious/noArrayIndexKey: 内容が同じ部品が並びうる
          <span key={index}>{part.text}</span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: 同じ版が複数回現れうる
          <ShaChip key={index} shortText={part.text} sha={part.sha} />
        ),
      )}
    </>
  );
}
