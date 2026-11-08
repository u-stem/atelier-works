import { Fragment } from "react";
import { safeText } from "../../lib/safeText.ts";

/** 空の文字列を示す目印。値とキーは等幅や通常の文字で描くので、斜体で薄い文字は見分けがつく。 */
const EMPTY_STRING_LABEL = "(空の文字列)";

/**
 * 値、キー、列の見出しの文字列。空か空白だけの文字列は、見えなくなるので、目印で描く。
 * 引数は`safeText`を通した文字列である。見えない文字は代替文字になっていて、空白だけとは見なさない。
 */
export function TextValue({ text }: { text: string }) {
  if (text.trim() === "") {
    return (
      <span className="text-muted-foreground italic">{EMPTY_STRING_LABEL}</span>
    );
  }
  return <>{safeText(text)}</>;
}

/**
 * 項目のキー。アンダースコアの後ろに折り返しの位置(`wbr`)を置き、長いキーが文字の途中でなく語の切れ目で折れるようにする。
 * 文字は変えないので、読み上げとコピーでは元のキーのままである。引数は`safeText`を通した文字列で、文字としてだけ描く。
 */
export function KeyText({ text }: { text: string }) {
  const parts = text.split("_");
  return (
    <>
      {parts.map((part, index) => (
        // 分けた位置は変わらず、同じ文字列の部分が並びうるので、位置で見分ける。
        // biome-ignore lint/suspicious/noArrayIndexKey: 同じ文字列の部分が並びうる。
        <Fragment key={index}>
          {index < parts.length - 1 ? (
            <>
              {part}_<wbr />
            </>
          ) : (
            part
          )}
        </Fragment>
      ))}
    </>
  );
}

/** 空であることと、項目に意味があるときはその意味。 */
export function EmptyValue({ note }: { note: string | null }) {
  return (
    <span className="flex flex-col gap-0.5 text-muted-foreground">
      <span>空です。</span>
      {note === null ? null : <span>{safeText(note)}</span>}
    </span>
  );
}
