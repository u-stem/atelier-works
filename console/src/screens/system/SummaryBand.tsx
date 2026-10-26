import {
  CircleCheck,
  type LucideIcon,
  Minus,
  OctagonAlert,
  TriangleAlert,
} from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "../../lib/cn.ts";
import { useDelayedVisible } from "../../lib/delayedVisible.ts";
import {
  type BandLevel,
  type BandRow,
  type BandSymbol,
  bandLevelInfo,
  isBandRowLoading,
} from "../../lib/summaryBand.ts";
import { type SystemTabId, systemTabHref } from "../../lib/systemTabs.ts";

const CHIP_CLASS =
  "inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-border bg-card px-3 py-2 text-small outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";

/** 段の記号。色だけに頼らず、形でも段を区別する。形は`bandLevelInfo`の記号の名前が決める。 */
const SYMBOLS: Readonly<Record<BandSymbol, LucideIcon>> = {
  "circle-check": CircleCheck,
  "triangle-alert": TriangleAlert,
  "octagon-alert": OctagonAlert,
  minus: Minus,
};

const SYMBOL_COLOR: Readonly<Record<BandLevel, string>> = {
  normal: "text-success",
  caution: "text-warning",
  action: "text-failure",
  none: "text-muted-foreground",
};

/** 修飾キーやマウスの中ボタンのときは、ブラウザの既定(新しいタブで開く)に任せる。 */
function isPlainClick(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

function ChipBody({ row, hidden }: { row: BandRow; hidden: boolean }) {
  const info = bandLevelInfo(row.level);
  const LevelIcon = SYMBOLS[info.symbol];
  const hide = hidden ? "invisible" : "";
  const hiddenProps = hidden ? { "aria-hidden": true } : {};
  return (
    <>
      <span
        className={cn(
          "inline-flex items-center",
          SYMBOL_COLOR[row.level],
          hide,
        )}
        {...hiddenProps}
      >
        <LevelIcon aria-hidden="true" className="size-4" />
        <span className="sr-only">{info.label}</span>
      </span>
      <span className="font-medium">{row.label}</span>
      <span className={cn("tabular-nums break-words", hide)} {...hiddenProps}>
        {row.text}
      </span>
      {row.stale ? (
        <span className="text-caption text-muted-foreground">
          前の値(取得に失敗)
        </span>
      ) : null}
    </>
  );
}

function Chip({
  row,
  onJump,
  pendingVisible,
}: {
  row: BandRow;
  onJump: (tab: SystemTabId, targetId: string) => void;
  /** 取得中のチップを、「取得中です」と出してよいか。 */
  pendingVisible: boolean;
}) {
  // 取得中のチップは、待ちの間は枠だけにする。値が届くとき、チップの大きさが動かず、短い取得で文が一瞬だけ出ないため。
  const body: ReactNode = (
    <ChipBody row={row} hidden={isBandRowLoading(row) && !pendingVisible} />
  );
  const { target } = row;
  if (target.kind === "route") {
    return (
      <Link to={target.to} className={CHIP_CLASS}>
        {body}
      </Link>
    );
  }
  return (
    <a
      href={systemTabHref(target.tab)}
      className={CHIP_CLASS}
      onClick={(event) => {
        if (isPlainClick(event)) {
          event.preventDefault();
          onJump(target.tab, target.targetId);
        }
      }}
    >
      {body}
    </a>
  );
}

/**
 * システムの画面の先頭の要約の帯。チップごとに結論と段を出し、押すと関係する節か、要対応の画面へ移る。
 * タブと一緒に本文のスクロール枠の外に置き、タブを替えても見える。失敗の件数はここに必ず出る。
 * 取得の時刻と注記は、チップに置かず、各節の見出しが持つ。
 * 取得中でも値が無いチップは、300msを超えて待つまでは枠だけを置く。
 * 取り直しに失敗して前の値を出すときは、前の値だと書く。
 */
export function SummaryBand({
  rows,
  onJump,
}: {
  rows: readonly BandRow[];
  onJump: (tab: SystemTabId, targetId: string) => void;
}) {
  // 画面の切り替えのスケルトンと同じ規則で、待ちが長引いたときだけ文を出す。
  const pendingVisible = useDelayedVisible(rows.some(isBandRowLoading));
  return (
    <nav aria-labelledby="summary-band-heading">
      <h2 id="summary-band-heading" className="sr-only">
        要約
      </h2>
      <ul className="flex flex-wrap gap-2">
        {rows.map((row) => (
          <li key={row.id}>
            <Chip row={row} onJump={onJump} pendingVisible={pendingVisible} />
          </li>
        ))}
      </ul>
    </nav>
  );
}
