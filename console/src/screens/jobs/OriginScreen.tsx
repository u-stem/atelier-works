import type { FlowsData } from "../../lib/flowsData.ts";

/** 起動の図の画面の表示の部分。 */
export function OriginScreenView(props: {
  name: string;
  data: FlowsData | null;
  back: string | null;
  width: number;
  widthRef?: (element: HTMLElement | null) => (() => void) | undefined;
}) {
  void props;
  return null;
}

/** 起動の図の画面。 */
export function OriginScreen() {
  return null;
}
