import { Skeleton } from "../components/ui/skeleton.tsx";

/** 最初の画面を読み込んでいる間の表示。 */
export function RouteFallback() {
  return (
    <div className="flex flex-col gap-3 p-6" role="status">
      <span className="sr-only">読み込み中</span>
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-4 w-full max-w-xl" />
      <Skeleton className="h-4 w-full max-w-lg" />
    </div>
  );
}
