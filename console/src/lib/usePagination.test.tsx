import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { usePagination } from "./usePagination.ts";

function Probe({
  total,
  size,
  initialPage,
}: {
  total: number;
  size: number;
  initialPage?: number | undefined;
}) {
  const { page } = usePagination(total, size, initialPage);
  return <p>{`page=${page}`}</p>;
}

function pageOf(total: number, size: number, initialPage?: number): string {
  return renderToStaticMarkup(
    <Probe total={total} size={size} initialPage={initialPage} />,
  );
}

describe("usePagination", () => {
  test("starts on the first page", () => {
    expect(pageOf(60, 25)).toContain("page=0");
  });

  test("starts on the given page", () => {
    expect(pageOf(60, 25, 1)).toContain("page=1");
  });

  test("moves a page past the end to the last page", () => {
    expect(pageOf(60, 25, 9)).toContain("page=2");
  });

  test("keeps an empty list on the first page", () => {
    expect(pageOf(0, 25, 3)).toContain("page=0");
  });
});
