// ブラウザのキー入力を、ショートカットの規則(`lib/shortcutKeys.ts`)につなぐ。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  CHORD_IDLE,
  isPaletteKey,
  isTypingTarget,
  keyboardGate,
  type OpenDialog,
  type Platform,
  platformOf,
  stepShortcut,
} from "../lib/shortcutKeys.ts";
import {
  readShortcutsEnabled,
  type StorageLike,
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

/** 1文字のショートカットを有効にするか。切り替えは保存領域に残す。読めなければ有効にする。 */
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

/**
 * パレットのキーと、1文字のショートカットを受ける。外枠に1つだけ置く。
 * パレット以外のダイアログが開いている間は、どちらも受けない。
 * パレットのキーは入力欄の中でも働き、1文字のショートカットは`enabled`が偽のとき働かない。
 * Alt+T(通知)は、修飾キー付きなので奪わない。
 */
export function useKeyboardShortcuts({
  enabled,
  onTogglePalette,
  onOpenHelp,
}: {
  enabled: boolean;
  onTogglePalette: () => void;
  onOpenHelp: () => void;
}): void {
  const navigate = useNavigate();
  const platform = useBrowserPlatform();
  const chord = useRef(CHORD_IDLE);

  useEffect(() => {
    const targets = SCREENS.map((screen) => ({
      key: screen.shortcut,
      id: screen.id,
    }));
    const handle = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) {
        return;
      }
      const gate = keyboardGate(openDialogs());
      if (isPaletteKey(event, platform)) {
        if (gate !== "blocked") {
          event.preventDefault();
          onTogglePalette();
        }
        return;
      }
      if (gate !== "free") {
        chord.current = CHORD_IDLE;
        return;
      }
      const step = stepShortcut(chord.current, event, {
        now: event.timeStamp,
        enabled,
        typing: isTypingTarget(
          event.target instanceof HTMLElement ? event.target : null,
        ),
        targets,
      });
      chord.current = step.state;
      if (step.consumed) {
        event.preventDefault();
      }
      if (step.action?.kind === "help") {
        onOpenHelp();
      } else if (step.action?.kind === "go") {
        const { id } = step.action;
        const screen = SCREENS.find((candidate) => candidate.id === id);
        if (screen !== undefined) {
          void navigate(screen.path);
        }
      }
    };
    document.addEventListener("keydown", handle);
    return () => {
      document.removeEventListener("keydown", handle);
    };
  }, [enabled, navigate, onOpenHelp, onTogglePalette, platform]);
}
