import type { ViewMode } from "../lib/requirementsView.ts";

export function ViewModeSwitch(_props: {
  target: string;
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
}) {
  return <fieldset />;
}
