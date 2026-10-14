import { formatAbsoluteIso, formatRelativeIso } from "../lib/relativeTime.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

/**
 * 時刻を「3分前」の相対表記で出し、絶対時刻(日本時間)をツールチップに出す。
 * ツールチップに届かない操作でも読めるよう、絶対時刻を読み上げ用にも添える。
 * `prefix`は相対表記の前に付ける語である。
 */
export function TimeText({
  iso,
  now,
  prefix = "",
}: {
  iso: string;
  now: number;
  prefix?: string;
}) {
  const absolute = formatAbsoluteIso(iso);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={iso} className="cursor-default rounded-sm">
          {prefix}
          {formatRelativeIso(iso, now)}
          <span className="sr-only">({absolute})</span>
        </time>
      </TooltipTrigger>
      <TooltipContent>{absolute}</TooltipContent>
    </Tooltip>
  );
}
