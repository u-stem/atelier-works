import {
  PAGINATION_BAR_CLASS,
  PAGINATION_BUTTON_CLASS,
} from "../lib/layoutClasses.ts";
import {
  clampPage,
  pageCount,
  pageRangeNote,
  pageStep,
} from "../lib/pagination.ts";
import { Button } from "./ui/button.tsx";

/**
 * 一覧のページ送り。「前へ」「次へ」、ページの番号、表示している範囲を出す。
 * 項目が1ページに収まるときは何も描かない。
 * 端のボタンは`disabled`にせず`aria-disabled`にして、押しても何もしない。
 * `disabled`にすると、押した直後にフォーカスが失われ、キーボードの操作が途切れるためである。
 * ページ番号は0から数える。範囲の外の`page`は、最後のページとして描く。
 * 状態は持たず、移動先を`onPageChange`に渡す。
 * スクロール枠の下端に貼り付き、長い一覧の先頭でも押せる。
 * 帯とボタンのclassは、枠の余白に依存するので、枠のclassと対にして`layoutClasses.ts`に置く。
 * 貼り付く範囲は親の要素の中なので、親は一覧とこの要素だけを含み、`overflow`を持たない包みにする。
 * 背景と上の境界線で、下をくぐる一覧と重ならずに読める。
 */
export function Pagination({
  page,
  total,
  size,
  onPageChange,
  label,
}: {
  page: number;
  total: number;
  size: number;
  onPageChange: (next: number) => void;
  /** `nav`の名前。画面に複数あるページ送りを、読み上げで区別する。 */
  label: string;
}) {
  if (total <= size) {
    return null;
  }
  const current = clampPage(page, total, size);
  const previous = pageStep("prev", page, total, size);
  const following = pageStep("next", page, total, size);
  return (
    <nav aria-label={label} className={PAGINATION_BAR_CLASS}>
      <p aria-live="polite" className="tabular-nums">
        {pageRangeNote(page, total, size)}
      </p>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={PAGINATION_BUTTON_CLASS}
          aria-disabled={previous === null ? "true" : undefined}
          onClick={previous === null ? undefined : () => onPageChange(previous)}
        >
          前へ
        </Button>
        <span className="tabular-nums">
          {`${current + 1} / ${pageCount(total, size)}ページ`}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={PAGINATION_BUTTON_CLASS}
          aria-disabled={following === null ? "true" : undefined}
          onClick={
            following === null ? undefined : () => onPageChange(following)
          }
        >
          次へ
        </Button>
      </div>
    </nav>
  );
}
