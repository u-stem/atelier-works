import { cn } from "../../lib/cn.ts";
import type { InboxChip } from "../../lib/inboxView.ts";

/** 種類の切り替え。押した種類だけを一覧に出す。件数はチップの横に添える。 */
export function KindChips({
  chips,
  counts,
  active,
  onChange,
}: {
  chips: readonly { id: InboxChip; label: string }[];
  counts: Readonly<Record<InboxChip, number>>;
  active: InboxChip;
  onChange: (chip: InboxChip) => void;
}) {
  return (
    <fieldset className="m-0 inline-flex w-fit min-w-0 gap-0.5 rounded-lg border-0 bg-muted p-0.5">
      <legend className="sr-only">種類で絞り込む</legend>
      {chips.map((chip) => {
        const pressed = chip.id === active;
        return (
          <button
            key={chip.id}
            type="button"
            aria-pressed={pressed}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-small text-muted-foreground outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
              pressed && "bg-card font-medium text-foreground shadow-sm",
            )}
            onClick={() => {
              onChange(chip.id);
            }}
          >
            {chip.label}
            <span className="text-subtle tabular-nums">{counts[chip.id]}</span>
          </button>
        );
      })}
    </fieldset>
  );
}
