import type { ViewMode } from "../lib/requirementsView.ts";
import { ToggleChip, ToggleChipGroup } from "./ToggleChip.tsx";

/** 文字の選択肢の既定の名前。 */
const DEFAULT_TEXT_LABEL = "Markdownの文字";

/**
 * 本文の表示の形式を、プレビューと文字から選ぶ切り替え。
 * 選んだ形式は呼び出し側が持つ。目次や注記が本文の外にあり、形式で出し分けるためである。
 * `target`は、読み上げの名前に含める対象(例: 「設計書」)。
 * `textLabel`は、文字の選択肢の名前。承認画面は「原文」を渡し、省略すると「Markdownの文字」になる。
 */
export function ViewModeSwitch({
  target,
  mode,
  onChange,
  textLabel = DEFAULT_TEXT_LABEL,
}: {
  target: string;
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
  textLabel?: string;
}) {
  const choices: readonly {
    readonly mode: ViewMode;
    readonly label: string;
  }[] = [
    { mode: "preview", label: "プレビュー" },
    { mode: "text", label: textLabel },
  ];
  return (
    <ToggleChipGroup legend={`${target}の表示の形式`}>
      {choices.map((choice) => (
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
