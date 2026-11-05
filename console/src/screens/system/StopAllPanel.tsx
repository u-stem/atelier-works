import type { StopAllRead } from "../../api/guards/holds.ts";

type PanelProps = {
  readonly view: StopAllRead | undefined;
  readonly locked: boolean;
  readonly onRequestStop: () => void;
  readonly onRequestRelease: () => void;
};

export function StopAllPanel(_props: PanelProps) {
  return null;
}
