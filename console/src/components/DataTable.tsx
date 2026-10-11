import type { ReactNode } from "react";

export type DataTableRow = {
  /** 行を見分けるキー。同じ表の中で重ならない値にする。 */
  readonly key: string;
  readonly cells: readonly ReactNode[];
};

/**
 * 数値の小さな表。最初の列は左、2列目以降は数値として右に寄せる。
 * 行が多いときは高さを抑えてスクロールさせる。
 */
export function DataTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: readonly string[];
  rows: readonly DataTableRow[];
}) {
  return (
    <section
      aria-label={caption}
      className="max-h-64 max-w-3xl overflow-y-auto rounded-lg border border-border"
    >
      <table className="w-full text-small tabular-nums">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-muted text-left text-muted-foreground">
          <tr>
            {columns.map((column, index) => (
              <th
                key={column}
                scope="col"
                className={
                  index === 0
                    ? "px-3 py-1.5 font-medium"
                    : "px-3 py-1.5 text-right font-medium"
                }
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.key}>
              {row.cells.map((cell, index) => (
                <td
                  key={columns[index]}
                  className={
                    index === 0 ? "px-3 py-1.5" : "px-3 py-1.5 text-right"
                  }
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
