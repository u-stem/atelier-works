/**
 * 入力の誤りの件数を読み上げに伝える、視覚的に隠した領域。
 * 領域は最初の描画から置く。読み上げは、後から現れた領域の中身を伝えないことがあるためである。
 * 同じ文でも読み直されるよう、`serial`が変わると中の要素を作り直す。
 */
export function InvalidStatus({
  text,
  serial,
}: {
  text: string;
  serial: number;
}) {
  return (
    <p role="status" className="sr-only">
      {text === "" ? null : <span key={serial}>{text}</span>}
    </p>
  );
}
