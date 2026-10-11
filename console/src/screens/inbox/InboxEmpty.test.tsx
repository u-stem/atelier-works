import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiFailure } from "../../api/errors.ts";
import { InboxEmpty } from "./InboxEmpty.tsx";

function failure(error: unknown) {
  return { error, isFetching: false, onRetry: () => undefined };
}

describe("InboxEmpty", () => {
  test("states that nothing needs action when the refresh succeeded", () => {
    expect(renderToStaticMarkup(<InboxEmpty unlisted={[]} />)).toContain(
      "対応が必要な承認・失敗・通知はありません",
    );
  });

  test("shows the success mark when the refresh succeeded", () => {
    expect(renderToStaticMarkup(<InboxEmpty unlisted={[]} />)).toContain(
      "text-success",
    );
  });

  test("says the empty result is from the last fetch after a failed refresh", () => {
    const html = renderToStaticMarkup(
      <InboxEmpty
        unlisted={[]}
        refreshFailure={failure(new ApiFailure({ kind: "network" }))}
      />,
    );
    expect(html).toContain("最後に取得できた時点では");
  });

  test("does not show the success mark after a failed refresh", () => {
    const html = renderToStaticMarkup(
      <InboxEmpty
        unlisted={[]}
        refreshFailure={failure(new ApiFailure({ kind: "network" }))}
      />,
    );
    expect(html).not.toContain("text-success");
  });

  test("offers a retry after a failed refresh", () => {
    const html = renderToStaticMarkup(
      <InboxEmpty
        unlisted={[]}
        refreshFailure={failure(new ApiFailure({ kind: "network" }))}
      />,
    );
    expect(html).toContain("もう一度取得する");
  });
});
