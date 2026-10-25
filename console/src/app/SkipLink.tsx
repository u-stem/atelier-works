import type { FocusTarget } from "../lib/routeFocus.ts";

export function skipToMain(
  _event: { preventDefault(): void },
  _main: FocusTarget | null,
): void {}

export function SkipLink() {
  return null;
}
