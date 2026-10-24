import { TriangleAlert } from "lucide-react";
import type { HoldsSnapshot } from "../../api/guards/holds.ts";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  deployFreezeItems,
  type FailureView,
  freezesFailureView,
  type HoldItem,
  holdItems,
  holdsFailureView,
  isExpiredAt,
  type ReleaseTarget,
  remainingText,
  scheduleFreezeItems,
} from "../../lib/holdsView.ts";
import { HOLDS_TEXT } from "../../lib/labels.ts";
import { formatAbsoluteIso } from "../../lib/relativeTime.ts";
import { EmptyNote } from "./SystemSection.tsx";

type PanelProps = {
  readonly data: HoldsSnapshot;
  readonly now: number;
  readonly isLocked: (target: ReleaseTarget) => boolean;
  readonly onRequestRelease: (item: HoldItem) => void;
  readonly onRetry: () => void;
  /** 取得中は「もう一度取得する」を押せなくする。押すと進行中の取得を打ち切るためである。 */
  readonly isFetching: boolean;
};

const BIDI = "[unicode-bidi:isolate]";

function ReleaseAction({
  item,
  now,
  locked,
  onRequestRelease,
}: {
  item: HoldItem;
  now: number;
  locked: boolean;
  onRequestRelease: (item: HoldItem) => void;
}) {
  if (isExpiredAt(item.expiresAt, now)) {
    return (
      <span className="text-small text-warning">{HOLDS_TEXT.expired}</span>
    );
  }
  return (
    <Button
      size="sm"
      variant="outline"
      data-release={item.key}
      disabled={locked}
      onClick={() => {
        onRequestRelease(item);
      }}
    >
      {locked ? HOLDS_TEXT.releasing : HOLDS_TEXT.release}
    </Button>
  );
}

function Row({
  item,
  now,
  locked,
  onRequestRelease,
}: {
  item: HoldItem;
  now: number;
  locked: boolean;
  onRequestRelease: (item: HoldItem) => void;
}) {
  const absolute = formatAbsoluteIso(item.expiresAt);
  return (
    <li className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Badge variant="muted">{item.kindLabel}</Badge>
          <span
            dir="ltr"
            className={`min-w-0 text-body font-medium break-words ${BIDI}`}
          >
            {item.targetText}
          </span>
        </p>
        <p
          dir="ltr"
          className={`text-small break-words whitespace-pre-wrap text-foreground ${BIDI}`}
        >
          {item.reasonText}
        </p>
        <p className="text-small text-subtle">
          {`${HOLDS_TEXT.holderField}: ${item.holderLabel}(`}
          <span dir="ltr" className={`break-words ${BIDI}`}>
            {item.holderText}
          </span>
          {")"}
        </p>
        <p className="text-small text-subtle">
          {`${HOLDS_TEXT.expiryField}: `}
          <time dateTime={item.expiresAt} title={absolute}>
            {remainingText(item.expiresAt, now)}
          </time>
          <span className="sr-only">({absolute})</span>
        </p>
        {item.note === null ? null : (
          <p className="text-small text-muted-foreground">{item.note}</p>
        )}
      </div>
      <div className="shrink-0">
        <ReleaseAction
          item={item}
          now={now}
          locked={locked}
          onRequestRelease={onRequestRelease}
        />
      </div>
    </li>
  );
}

function RowList({
  items,
  now,
  isLocked,
  onRequestRelease,
}: {
  items: readonly HoldItem[];
} & Pick<PanelProps, "now" | "isLocked" | "onRequestRelease">) {
  return (
    <ul className="divide-y divide-border rounded-xl border border-border bg-card">
      {items.map((item) => (
        <Row
          key={item.key}
          item={item}
          now={now}
          locked={isLocked(item.target)}
          onRequestRelease={onRequestRelease}
        />
      ))}
    </ul>
  );
}

function FailureBox({
  view,
  onRetry,
  isFetching,
}: {
  view: FailureView;
  onRetry: () => void;
  isFetching: boolean;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-xl border border-warning/40 bg-warning/10 p-4"
    >
      <p className="flex items-center gap-2 text-body font-semibold text-warning">
        <TriangleAlert aria-hidden="true" className="size-4" />
        {view.title}
      </p>
      <p className="text-small">{view.detail}</p>
      {view.hint === null ? null : <p className="text-small">{view.hint}</p>}
      <details open={view.reasonOpen}>
        <summary className="cursor-pointer text-small text-muted-foreground">
          {HOLDS_TEXT.reasonSummary}
        </summary>
        <p
          dir="ltr"
          className={`mt-1 text-small break-words whitespace-pre-wrap ${BIDI}`}
        >
          {view.reason}
        </p>
      </details>
      {view.retry ? (
        <div>
          <Button
            size="sm"
            variant="outline"
            aria-disabled={isFetching}
            onClick={isFetching ? undefined : onRetry}
          >
            {HOLDS_TEXT.retry}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Card({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <h3 className="text-body font-semibold">{title}</h3>
        <p className="text-small text-muted-foreground">{note}</p>
      </div>
      {children}
    </div>
  );
}

function HoldsCard(props: PanelProps) {
  const { holds } = props.data;
  return (
    <Card title={HOLDS_TEXT.holdsCardTitle} note={HOLDS_TEXT.holdsCardNote}>
      {!holds.ok ? (
        <FailureBox
          view={holdsFailureView(holds)}
          onRetry={props.onRetry}
          isFetching={props.isFetching}
        />
      ) : holds.rows.length === 0 ? (
        <EmptyNote>{HOLDS_TEXT.holdsEmpty}</EmptyNote>
      ) : (
        <RowList
          items={holdItems(holds.rows)}
          now={props.now}
          isLocked={props.isLocked}
          onRequestRelease={props.onRequestRelease}
        />
      )}
    </Card>
  );
}

function FreezesCard(props: PanelProps) {
  const { freezes } = props.data;
  return (
    <Card title={HOLDS_TEXT.freezesCardTitle} note={HOLDS_TEXT.freezesCardNote}>
      {!freezes.ok ? (
        <FailureBox
          view={freezesFailureView(freezes)}
          onRetry={props.onRetry}
          isFetching={props.isFetching}
        />
      ) : freezes.schedule.length + freezes.deploy.length === 0 ? (
        <EmptyNote>{HOLDS_TEXT.freezesEmpty}</EmptyNote>
      ) : (
        <RowList
          items={[
            ...deployFreezeItems(freezes.deploy),
            ...scheduleFreezeItems(freezes.schedule),
          ]}
          now={props.now}
          isLocked={props.isLocked}
          onRequestRelease={props.onRequestRelease}
        />
      )}
    </Card>
  );
}

/**
 * 有効な保留と凍結の一覧。保留の表と凍結の変数は別々の源なので、カードごとに成功と失敗を分ける。
 * 読めなかった源は、保留なしとは書かず、止まる旨と回復の手順を出す。
 * 行の文字列はDBや変数に書ける主体が決めるので、文字としてだけ描く(リンクにも画像にもしない)。
 * 期限は画面の時計で判定し、取得の間に期限が来た行は、解除のボタンを外して「期限切れ」と出す。
 */
export function HoldsPanel(props: PanelProps) {
  return (
    <div className="flex flex-col gap-6">
      <HoldsCard {...props} />
      <FreezesCard {...props} />
      <p className="text-small text-muted-foreground">{HOLDS_TEXT.placeHint}</p>
    </div>
  );
}
