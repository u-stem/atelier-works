// GitHub-style admonition markers (`> [!NOTE]`, `> [!WARNING]`,
// `> [!IMPORTANT]`) — components/Markdown.tsx's `blockquote` override uses
// this to turn a matching blockquote into a styled panel instead of a plain
// quote.

export type AlertKind = "note" | "warning" | "important";

export const ALERT_LABELS: Record<AlertKind, string> = {
  note: "NOTE",
  warning: "WARNING",
  important: "IMPORTANT",
};

const ALERT_MARKER_PATTERN = /^\[!(NOTE|WARNING|IMPORTANT)\]\s*/i;

function toAlertKind(marker: string): AlertKind | null {
  switch (marker.toUpperCase()) {
    case "NOTE":
      return "note";
    case "WARNING":
      return "warning";
    case "IMPORTANT":
      return "important";
    default:
      return null;
  }
}

/** Strips a GitHub-style `[!NOTE]` (or WARNING/IMPORTANT) marker off the
 * start of `text` (pure, for testing), returning the marker's kind and the
 * remaining text — or `null` when `text` doesn't start with one. Only the
 * plain-text case (the common one: the marker starts the blockquote's very
 * first line, with the rest of the note as follow-on text in the same
 * paragraph) is handled; a marker split across inline formatting is left
 * as-is and simply doesn't match. */
export function stripAlertMarker(
  text: string,
): { kind: AlertKind; rest: string } | null {
  const match = ALERT_MARKER_PATTERN.exec(text);
  if (match === null) {
    return null;
  }
  const marker = match[1];
  if (marker === undefined) {
    return null;
  }
  const kind = toAlertKind(marker);
  if (kind === null) {
    return null;
  }
  return { kind, rest: text.slice(match[0].length) };
}
