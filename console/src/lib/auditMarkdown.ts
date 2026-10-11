// 監査レポートのMarkdownを描くときの判定。
// 本文は監査のClaudeが、信頼できない運用記録から書いた文章である。
// 管理者のWindmillと同じオリジンで描くので、リンクは1つも張らず、行き先は文字で見せる。
// 監査レポートの本文にはURLを書かない決まりで、リポジトリの情報も渡されないため、
// 張ってよいリンクが無い。

/** 注記に出すURLの最大の長さ。長い`data:`のURLで表示が崩れないようにする。 */
const MAX_NOTE_LENGTH = 200;

export type AlertKind = "note" | "warning" | "important";

export const ALERT_LABELS: Readonly<Record<AlertKind, string>> = {
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
 * 引用の先頭にある`[!NOTE]`(または`WARNING`、`IMPORTANT`)の目印を取り除き、
 * 目印の種類と残りの文字列を返す。先頭に目印が無ければ`null`を返す。
 * 扱うのは、目印が1行目の先頭にあり、本文が同じ段落に続く平文の場合だけである。
 */
export function stripAlertMarker(
  text: string,
): { kind: AlertKind; rest: string } | null {
  const match = ALERT_MARKER_PATTERN.exec(text);
  const marker = match?.[1];
  if (match === null || marker === undefined) {
    return null;
  }
  const kind = toAlertKind(marker);
  if (kind === null) {
    return null;
  }
  return { kind, rest: text.slice(match[0].length) };
}

/**
 * リンクの文字と違うときに、読み手に見せる行き先。見せなくてよいときは`null`。
 * 読み手が行き先を取り違えないよう、文字で出す。
 */
export function linkNote(
  href: string | undefined,
  label: string,
): string | null {
  if (href === undefined || href === "" || label.trim() === href) {
    return null;
  }
  return href.length > MAX_NOTE_LENGTH
    ? `${href.slice(0, MAX_NOTE_LENGTH)}…`
    : href;
}
