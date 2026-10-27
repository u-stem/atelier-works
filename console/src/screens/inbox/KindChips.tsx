import { ToggleChip, ToggleChipGroup } from "../../components/ToggleChip.tsx";
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
    <ToggleChipGroup legend="種類で絞り込む">
      {chips.map((chip) => (
        <ToggleChip
          key={chip.id}
          pressed={chip.id === active}
          className="h-7 gap-1.5 px-3 text-small"
          onClick={() => {
            onChange(chip.id);
          }}
        >
          {chip.label}
          <span className="text-subtle tabular-nums">{counts[chip.id]}</span>
        </ToggleChip>
      ))}
    </ToggleChipGroup>
  );
}
