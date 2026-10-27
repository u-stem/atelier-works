// キーボードのショートカットの規則。DOMには触れず、キーの列と環境から、起こす操作を決める。
// 1文字のショートカット(`g`の後の移動、`?`)は、入力中と、他のダイアログが開いている間は働かない。
// コマンドパレットのキーは修飾キーを伴うので、入力欄の中でも働く。

import { hasModifierKey } from "./tabs.ts";

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

/** `g`を押した時刻。待っていないときは`null`。 */
export type ChordState = { readonly goAt: number | null };

export type ShortcutStep<Id extends string> = {
  readonly state: ChordState;
  readonly action: ShortcutAction<Id> | null;
  /** ブラウザの既定の動作を止めるか。 */
  readonly consumed: boolean;
};

export type ShortcutEnv<Id extends string> = {
  /** キーを押した時刻(ミリ秒)。 */
  readonly now: number;
  /** 1文字のショートカットを有効にしているか。 */
  readonly enabled: boolean;
  /** 入力欄にフォーカスがあるか。 */
  readonly typing: boolean;
  readonly targets: readonly ShortcutTarget<Id>[];
};

export type OpenDialog = { readonly isPalette: boolean };

/**
 * ショートカットを受けてよいか。
 * `palette-only`は、パレットだけが開いている状態で、パレットのキー(閉じる)だけを受ける。
 */
export type KeyboardGate = "free" | "palette-only" | "blocked";

/** `g`の後に次のキーを待つ長さ。 */
export const GO_WAIT_MS = 1000;

export const CHORD_IDLE: ChordState = { goAt: null };

/** 修飾キーそのものの押下。`g`の後に押されても、待ちを取り消さない。 */
const MODIFIER_ONLY_KEYS: ReadonlySet<string> = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "AltGraph",
  "CapsLock",
]);

const TYPING_TAGS: ReadonlySet<string> = new Set([
  "INPUT",
  "TEXTAREA",
  "SELECT",
]);

/** IMEの変換中のキーか。変換を確定するEnterは、`isComposing`か`keyCode`の229で見分ける。 */
export function isComposingKey(event: {
  readonly isComposing: boolean;
  readonly keyCode: number;
}): boolean {
  return event.isComposing || event.keyCode === 229;
}

/** macのブラウザか。iPadOSは自分をMacと名乗るので、同じ扱いになる。 */
export function platformOf(navigatorLike: {
  readonly platform: string;
  readonly userAgent: string;
}): Platform {
  return /Mac|iPhone|iPad|iPod/i.test(
    `${navigatorLike.platform} ${navigatorLike.userAgent}`,
  )
    ? "mac"
    : "other";
}

/**
 * コマンドパレットを開くキーか。
 * macはCommandだけ、それ以外はCtrlだけを見る。
 * macの入力欄ではCtrl+Kが行末までの削除なので、奪わない。
 */
export function isPaletteKey(
  event: {
    readonly key: string;
    readonly altKey: boolean;
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly shiftKey: boolean;
  },
  platform: Platform,
): boolean {
  if (event.key.toLowerCase() !== "k" || event.altKey || event.shiftKey) {
    return false;
  }
  return platform === "mac"
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

/** 文字を入力する要素か。1文字のショートカットを奪わないために使う。 */
export function isTypingTarget(
  target: {
    readonly tagName?: string;
    readonly isContentEditable?: boolean;
  } | null,
): boolean {
  if (target === null) {
    return false;
  }
  return (
    TYPING_TAGS.has(target.tagName?.toUpperCase() ?? "") ||
    target.isContentEditable === true
  );
}

/**
 * 開いているダイアログから、ショートカットを受けてよいかを決める。
 * パレットを除く他のダイアログが1つでも開いていたら、すべて受けない。
 */
export function keyboardGate(openDialogs: readonly OpenDialog[]): KeyboardGate {
  if (openDialogs.some((dialog) => !dialog.isPalette)) {
    return "blocked";
  }
  return openDialogs.length === 0 ? "free" : "palette-only";
}

function idleStep<Id extends string>(
  state: ChordState = CHORD_IDLE,
): ShortcutStep<Id> {
  return { state, action: null, consumed: false };
}

/**
 * 1つのキー押下から、起こす操作と次の状態を決める。
 * `g`の後、1秒以内に画面のキーが来たらその画面へ移る。別のキーが来たら取り消す。
 * `?`はShiftを伴うので、Shiftは見ない。Ctrl、Alt、Metaが付いたキーは、ブラウザや他の部品のものなので使わない。
 */
export function stepShortcut<Id extends string>(
  state: ChordState,
  event: KeyEventLike,
  env: ShortcutEnv<Id>,
): ShortcutStep<Id> {
  if (!env.enabled || env.typing || isComposingKey(event)) {
    return idleStep();
  }
  if (event.repeat || MODIFIER_ONLY_KEYS.has(event.key)) {
    return idleStep(state);
  }
  if (hasModifierKey(event)) {
    return idleStep();
  }
  const waiting =
    state.goAt !== null &&
    env.now >= state.goAt &&
    env.now - state.goAt <= GO_WAIT_MS;
  if (waiting) {
    const target = env.targets.find((candidate) => candidate.key === event.key);
    if (target === undefined) {
      return idleStep();
    }
    return {
      state: CHORD_IDLE,
      action: { kind: "go", id: target.id },
      consumed: true,
    };
  }
  if (event.key === "g") {
    return { state: { goAt: env.now }, action: null, consumed: true };
  }
  if (event.key === "?") {
    return { state: CHORD_IDLE, action: { kind: "help" }, consumed: true };
  }
  return idleStep();
}

export type ShortcutRow = {
  readonly keys: readonly string[];
  /** キーの間に読む語。同時に押すときは`+`、順に押すときは`の次に`。 */
  readonly separator: "+" | "の次に";
  readonly description: string;
};

/** ヘルプに並べるショートカットの一覧。画面の移動は、画面の表から作る。 */
export function shortcutRows(
  screens: readonly {
    readonly label: string;
    readonly shortcut: string;
  }[],
  platform: Platform,
): readonly ShortcutRow[] {
  return [
    {
      keys: [platform === "mac" ? "⌘" : "Ctrl", "K"],
      separator: "+",
      description: "コマンドパレットを開く",
    },
    { keys: ["?"], separator: "+", description: "ショートカットの一覧を開く" },
    ...screens.map(
      (screen): ShortcutRow => ({
        keys: ["g", screen.shortcut],
        separator: "の次に",
        description: `${screen.label}へ移る`,
      }),
    ),
  ];
}
