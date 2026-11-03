import type { ViewMode } from "../lib/requirementsView.ts";
import { ToggleChip, ToggleChipGroup } from "./ToggleChip.tsx";

const CHOICES: readonly { readonly mode: ViewMode; readonly label: string }[] =
  [
    { mode: "preview", label: "プレビュー" },
    { mode: "text", label: "Markdownの文字" },
  ];

/**
 * 本文の表示の形式を、プレビューとMarkdownの文字から選ぶ切り替え。
 * 選んだ形式は呼び出し側が持つ。目次や注記が本文の外にあり、形式で出し分けるためである。
 * `target`は、読み上げの名前に含める対象(例: 「設計書」)。
 */
export function ViewModeSwitch({
  target,
  mode,
  onChange,
}: {
  target: string;
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
}) {
  return (
    <ToggleChipGroup legend={`${target}の表示の形式`}>
      {CHOICES.map((choice) => (
        <ToggleChip
          key={choice.mode}
          pressed={choice.mode === mode}
          className="h-7 px-3 text-small"
          onClick={() => {
            onChange(choice.mode);
          }}
        >
          {choice.label}
        </ToggleChip>
      ))}
    </ToggleChipGroup>
  );
}
