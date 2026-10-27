import type { Platform } from "../lib/shortcutKeys.ts";

export function ShortcutHelp(_props: {
  open: boolean;
  onClose: () => void;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  platform: Platform;
}) {
  return null;
}
