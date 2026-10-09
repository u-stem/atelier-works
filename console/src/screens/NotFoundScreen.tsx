import { Link } from "react-router";
import { PageHeader } from "../app/PageHeader.tsx";

export function NotFoundScreen() {
  return (
    <>
      <PageHeader title="ページが見つかりません" />
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p>指定されたページはありません。</p>
        <Link
          to="/"
          className="text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          要対応の画面へ戻る
        </Link>
      </div>
    </>
  );
}
