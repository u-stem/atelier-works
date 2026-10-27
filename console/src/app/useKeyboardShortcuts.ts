// ブラウザのキー入力を、ショートカットの規則(`lib/shortcutKeys.ts`)につなぐ。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  CHORD_IDLE,
  isTypingTarget,
  type OpenDialog,
  type Platform,
  platformOf,
  routeKeydown,
} from "../lib/shortcutKeys.ts";
import {
  readShortcutsEnabled,
  type StorageLike,
  shortcutsEnabledFromStorageEvent,
  writeShortcutsEnabled,
} from "../lib/shortcutStore.ts";
import { SCREENS } from "./screens.ts";

/** 保存領域。使えない環境(プライベートブラウズなど)では`null`。 */
function browserStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * 1文字のショートカットを有効にするか。既定は無効で、切り替えは保存領域に残す。
 * 別のタブでの切り替えも、`storage`イベントで反映する。
 */
export function useShortcutsEnabled(): readonly [
  boolean,
  (enabled: boolean) => void,
] {
  const [enabled, setEnabled] = useState(() =>
    readShortcutsEnabled(browserStorage()),
  );
  const update = useCallback((next: boolean) => {
    setEnabled(next);
    writeShortcutsEnabled(browserStorage(), next);
  }, []);
  useEffect(() => {
    const handle = (event: StorageEvent): void => {
      const next = shortcutsEnabledFromStorageEvent(event);
      if (next !== null) {
        setEnabled(next);
      }
    };
    window.addEventListener("storage", handle);
    return () => {
      window.removeEventListener("storage", handle);
    };
  }, []);
  return [enabled, update];
}

export function useBrowserPlatform(): Platform {
  return useMemo(() => platformOf(navigator), []);
}

/** 開いている`<dialog>`。パレット自身は目印(`data-command-palette`)で見分ける。 */
function openDialogs(): OpenDialog[] {
  return Array.from(document.querySelectorAll("dialog[open]")).map(
    (dialog) => ({ isPalette: dialog.hasAttribute("data-command-palette") }),
  );
}

/** キーを受けた要素が、文字を打ち込む場所か。 */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return isTypingTarget({
    tagName: target.tagName,
    isContentEditable: target.isContentEditable,
    ...(target instanceof HTMLInputElement ? { type: target.type } : {}),
  });
}

/**
 * パレットのキーと、1文字のショートカットを受ける。外枠に1つだけ置く。
 * 何を行うかは`routeKeydown`が決め、ここは結果を実行する。
 */
export function useKeyboardShortcuts({
  enabled,
  platform,
  onTogglePalette,
  onOpenHelp,
}: {
  enabled: boolean;
  platform: Platform;
  onTogglePalette: () => void;
  onOpenHelp: () => void;
}): void {
  const navigate = useNavigate();
  const chord = useRef(CHORD_IDLE);

  useEffect(() => {
    const targets = SCREENS.map((screen) => ({
      key: screen.shortcut,
      id: screen.id,
    }));
    const handle = (event: KeyboardEvent): void => {
      const result = routeKeydown(event, chord.current, {
        now: event.timeStamp,
        enabled,
        typing: isTyping(event.target),
        targets,
        platform,
        openDialogs: openDialogs(),
      });
      chord.current = result.nextChord;
      if (result.preventDefault) {
        event.preventDefault();
      }
      if (result.togglePalette) {
        onTogglePalette();
      }
      if (result.help) {
        onOpenHelp();
      }
      const screen = SCREENS.find((candidate) => candidate.id === result.go);
      if (screen !== undefined) {
        void navigate(screen.path);
      }
    };
    document.addEventListener("keydown", handle);
    return () => {
      document.removeEventListener("keydown", handle);
    };
  }, [enabled, navigate, onOpenHelp, onTogglePalette, platform]);
}
