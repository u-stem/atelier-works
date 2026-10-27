// コマンドパレットの項目、絞り込み、キー操作、選んだ後の手順。DOMには触れない。

export type PaletteGroupId = "screens" | "help";

export type PaletteTarget =
  | { readonly kind: "screen"; readonly path: string }
  | { readonly kind: "help" };

export type PaletteItem = {
  readonly id: string;
  readonly group: PaletteGroupId;
  readonly label: string;
  /** 項目の横に添えるキー。 */
  readonly hint: readonly string[];
  readonly keywords: string;
  readonly target: PaletteTarget;
};

export type PaletteSection = {
  readonly id: PaletteGroupId;
  readonly label: string;
  readonly items: readonly PaletteItem[];
};

export type PaletteKeyAction =
  | { readonly kind: "ignore" }
  | { readonly kind: "move"; readonly index: number }
  | { readonly kind: "choose"; readonly index: number };

export type ChooseEnv = {
  close(): void;
  navigate(path: string): void;
  openHelp(): void;
};

export function paletteItems(
  _screens: readonly {
    readonly id: string;
    readonly label: string;
    readonly path: string;
    readonly shortcut: string;
  }[],
): readonly PaletteItem[] {
  return [];
}

export function filterPaletteItems(
  _items: readonly PaletteItem[],
  _query: string,
): readonly PaletteItem[] {
  return [];
}

export function paletteSections(
  _items: readonly PaletteItem[],
): readonly PaletteSection[] {
  return [];
}

export function paletteKeyAction(
  _event: {
    readonly key: string;
    readonly keyCode: number;
    readonly isComposing: boolean;
  },
  _active: number,
  _count: number,
): PaletteKeyAction {
  return { kind: "move", index: -1 };
}

export function paletteStatus(_count: number): string {
  return "";
}

export function chooseItem(_item: PaletteItem, _env: ChooseEnv): void {}
