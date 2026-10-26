import type { ReactNode } from "react";

/**
 * 開閉できる部分。見出し行を押すか、キーボードで開く。
 * 開閉はURLにも履歴にも残さない。
 */
export function Disclosure({
  summary: _summary,
  children: _children,
  jumpOpen: _jumpOpen = false,
  initiallyOpen: _initiallyOpen = false,
  onToggle: _onToggle,
}: {
  summary: ReactNode;
  children: ReactNode;
  /** 節へ移るときに開く。 */
  jumpOpen?: boolean;
  initiallyOpen?: boolean;
  /** 開閉が変わったときに、開いているかを受け取る。 */
  onToggle?: (open: boolean) => void;
}) {
  return null;
}
