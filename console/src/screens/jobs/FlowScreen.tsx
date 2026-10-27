import type { FlowsData } from "../../lib/flowsData.ts";

/** flowの図の画面の表示の部分。経路の引数と、データと、図を包む要素の幅から描く。 */
export function FlowScreenView(_props: {
  name: string;
  data: FlowsData | null;
  back: string | null;
  width: number;
  widthRef?: (element: HTMLElement | null) => (() => void) | undefined;
}) {
  return null;
}

/** flowの図の画面。経路の`:name`を読み、図を包む要素の幅を測る。 */
export function FlowScreen() {
  return null;
}
