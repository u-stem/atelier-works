import { CircleCheck, Minus, OctagonAlert, TriangleAlert } from "lucide-react";
import type { MouseEvent } from "react";
import { TimeText } from "../../components/TimeText.tsx";
import { Badge, type BadgeProps } from "../../components/ui/badge.tsx";
import {
  type BandLevel,
  type BandRow,
  bandLevelInfo,
} from "../../lib/summaryBand.ts";
import {
  SYSTEM_OTHER_SECTIONS,
  type SystemTabId,
  systemTabHref,
} from "../../lib/systemTabs.ts";

const LINK_CLASS =
  "rounded-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring";

const LEVEL_VARIANT: Readonly<Record<BandLevel, BadgeProps["variant"]>> = {
  normal: "success",
  caution: "warning",
  action: "failure",
  none: "outline",
};

/** 段の記号。色だけに頼らず、形でも段を区別する。 */
function LevelSymbol({ level }: { level: BandLevel }) {
  switch (level) {
    case "normal":
      return <CircleCheck aria-hidden="true" />;
    case "caution":
      return <TriangleAlert aria-hidden="true" />;
    case "action":
      return <OctagonAlert aria-hidden="true" />;
    case "none":
      return <Minus aria-hidden="true" />;
  }
}

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

function JumpLink({
  tab,
  targetId,
  onJump,
  children,
}: {
  tab: SystemTabId;
  targetId: string;
  onJump: (tab: SystemTabId, targetId: string) => void;
  children: string;
}) {
  return (
    <a
      href={systemTabHref(tab)}
      className={LINK_CLASS}
      onClick={(event) => {
        if (isPlainClick(event)) {
          event.preventDefault();
          onJump(tab, targetId);
        }
      }}
    >
      {children}
    </a>
  );
}

function BandItem({
  row,
  now,
  onJump,
}: {
  row: BandRow;
  now: number;
  onJump: (tab: SystemTabId, targetId: string) => void;
}) {
  const info = bandLevelInfo(row.level);
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-3">
      <span className="w-full sm:w-44 sm:shrink-0">
        <JumpLink tab={row.tab} targetId={row.targetId} onJump={onJump}>
          {row.label}
        </JumpLink>
      </span>
      <Badge variant={LEVEL_VARIANT[row.level]}>
        <LevelSymbol level={row.level} />
        {info.label}
      </Badge>
      <span className="min-w-0 flex-1 text-body break-words tabular-nums">
        {row.text}
      </span>
      <span className="shrink-0 text-small text-subtle">
        {row.updatedAt > 0 ? (
          <TimeText
            iso={new Date(row.updatedAt).toISOString()}
            now={now}
            prefix="取得 "
          />
        ) : (
          "未取得"
        )}
      </span>
      {row.note === null ? null : (
        <p className="w-full text-small text-muted-foreground">{row.note}</p>
      )}
    </li>
  );
}

/**
 * システムの画面の先頭の要約の帯。各行は結論と段と最終取得時刻を出し、押すと関係するタブの節へ移る。
 * タブの上に置き、タブを替えても見える。失敗の件数はここに必ず出る。目次の役も兼ねる。
 * 帯に行を持たない節は、帯の下のリンクで開く。
 * 行の取得は別々なので、取得の時刻も行ごとに出す。
 */
export function SummaryBand({
  rows,
  now,
  onJump,
}: {
  rows: readonly BandRow[];
  now: number;
  onJump: (tab: SystemTabId, targetId: string) => void;
}) {
  return (
    <nav
      aria-labelledby="summary-band-heading"
      className="flex max-w-3xl flex-col gap-3"
    >
      <h2 id="summary-band-heading" className="text-lead font-semibold">
        要約
      </h2>
      <ul className="divide-y divide-border rounded-xl border border-border bg-card">
        {rows.map((row) => (
          <BandItem key={row.id} row={row} now={now} onJump={onJump} />
        ))}
      </ul>
      <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-small text-muted-foreground">
        <span>ほかの節</span>
        {SYSTEM_OTHER_SECTIONS.map((section) => (
          <JumpLink
            key={section.targetId}
            tab={section.tab}
            targetId={section.targetId}
            onJump={onJump}
          >
            {section.label}
          </JumpLink>
        ))}
      </p>
    </nav>
  );
}
