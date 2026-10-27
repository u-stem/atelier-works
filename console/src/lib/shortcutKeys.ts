// キーボードのショートカットの規則。DOMには触れず、キーの列と環境から、起こす操作を決める。

export type Platform = "mac" | "other";

export type KeyEventLike = {
  readonly key: string;
  readonly keyCode: number;
  readonly isComposing: boolean;
  readonly repeat: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
};

export type ShortcutTarget<Id extends string> = {
  readonly key: string;
  readonly id: Id;
};

export type ShortcutAction<Id extends string> =
  | { readonly kind: "go"; readonly id: Id }
  | { readonly kind: "help" };

export type ChordState = { readonly goAt: number | null };

export type ShortcutStep<Id extends string> = {
  readonly state: ChordState;
  readonly action: ShortcutAction<Id> | null;
  /** ブラウザの既定の動作を止めるか。 */
  readonly consumed: boolean;
};

export type ShortcutEnv<Id extends string> = {
  readonly now: number;
  readonly enabled: boolean;
  readonly typing: boolean;
  readonly targets: readonly ShortcutTarget<Id>[];
};

export type OpenDialog = { readonly isPalette: boolean };

export type KeyboardGate = "free" | "palette-only" | "blocked";

export const GO_WAIT_MS = 1000;

export const CHORD_IDLE: ChordState = { goAt: null };

export function platformOf(_navigator: {
  readonly platform: string;
  readonly userAgent: string;
}): Platform {
  return "other";
}

export function isComposingKey(_event: {
  readonly isComposing: boolean;
  readonly keyCode: number;
}): boolean {
  return false;
}

export function isPaletteKey(
  _event: {
    readonly key: string;
    readonly altKey: boolean;
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly shiftKey: boolean;
  },
  _platform: Platform,
): boolean {
  return false;
}

export function isTypingTarget(
  _target: {
    readonly tagName?: string;
    readonly isContentEditable?: boolean;
  } | null,
): boolean {
  return false;
}

export function keyboardGate(
  _openDialogs: readonly OpenDialog[],
): KeyboardGate {
  return "blocked";
}

export function stepShortcut<Id extends string>(
  state: ChordState,
  _event: KeyEventLike,
  _env: ShortcutEnv<Id>,
): ShortcutStep<Id> {
  return { state, action: null, consumed: false };
}

export type ShortcutRow = {
  readonly keys: readonly string[];
  /** キーの間に読む語。同時に押すときは`+`、順に押すときは`の次に`。 */
  readonly separator: "+" | "の次に";
  readonly description: string;
};

export function shortcutRows(
  _screens: readonly {
    readonly label: string;
    readonly shortcut: string;
  }[],
  _platform: Platform,
): readonly ShortcutRow[] {
  return [];
}
