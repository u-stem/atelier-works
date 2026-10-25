import type { ReactNode } from "react";

/** タブ1つ分の指定。 */
export type TabSpec<Id extends string> = {
  readonly id: Id;
  readonly label: string;
  /** タブが指す本体の`id`。 */
  readonly panelId: string;
  /** 名前に添える件数。 */
  readonly count?: number | undefined;
  /** 名前に添える印の文言。色だけに頼らず、文字で伝える。 */
  readonly mark?: string | undefined;
};

export function Tabs<Id extends string>(_props: {
  tabs: readonly TabSpec<Id>[];
  selected: Id;
  onSelect: (id: Id) => void;
  label: string;
  idPrefix: string;
}): ReactNode {
  return null;
}
