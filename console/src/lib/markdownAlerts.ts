// GitHub形式の注記(`> [!NOTE]`、`> [!WARNING]`、`> [!IMPORTANT]`)の目印の解析。
// `components/markdown/Markdown.tsx`の`blockquote`の描画がこれを使い、
// 目印のある引用を、ただの引用ではなく装飾したパネルとして描く。

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

/**
 * `text`の先頭にある`[!NOTE]`(または`WARNING`/`IMPORTANT`)の目印を取り除き、
 * 目印の種類と残りの文字列を返す。先頭に目印が無ければ`null`を返す。
 * 扱うのは、目印が引用の1行目の先頭にあり、注記の本文が同じ段落に続く
 * 平文の場合だけである(よくある書き方)。
 * インラインの書式で分断された目印は一致せず、そのまま残る。
 */
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
