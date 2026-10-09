// 旧Console(raw app)のURLのフラグメントを、新しい経路に読み替える。
// 旧ConsoleのリンクはIssueのコメントやDiscordの通知に残っているため、新しいConsoleが受け取る。

/** idと試行の番号。先頭が0の数と符号つきの数は受け付けない。 */
const ID_PATTERN = "[1-9][0-9]*";
const REQUIREMENTS_HASH = new RegExp(
  `^#requirements/(${ID_PATTERN})(?:/attempt-(${ID_PATTERN}))?$`,
);
const AUDIT_HASH = new RegExp(`^#audit/(${ID_PATTERN})$`);

const CONSOLE_BASE = "/console";

function isPositiveSafeInteger(text: string): boolean {
  return Number.isSafeInteger(Number(text));
}

/**
 * 旧ConsoleのフラグメントをConsole内のパス(`/console/`から始まる)にする。
 * `#requirements/<id>`は要件定義書へ、`#requirements/<id>/attempt-<k>`は試行つきで、
 * `#audit/<id>`は監査レポートへ読み替える。形が合わないフラグメントは`null`にする。
 * フラグメントは外から来る値なので、idは正の整数の文字列に限って経路に埋める。
 */
export function legacyDeepLinkTarget(hash: string): string | null {
  const requirements = REQUIREMENTS_HASH.exec(hash);
  if (requirements !== null) {
    const id = requirements[1];
    const attempt = requirements[2];
    if (id === undefined || !isPositiveSafeInteger(id)) {
      return null;
    }
    if (attempt === undefined) {
      return `${CONSOLE_BASE}/items/${id}/requirements`;
    }
    return isPositiveSafeInteger(attempt)
      ? `${CONSOLE_BASE}/items/${id}/requirements?attempt=${attempt}`
      : null;
  }
  const audit = AUDIT_HASH.exec(hash);
  const auditId = audit?.[1];
  if (auditId !== undefined && isPositiveSafeInteger(auditId)) {
    return `${CONSOLE_BASE}/reports/audit/${auditId}`;
  }
  return null;
}

/** `/console`から始まるパスを、routerのbasenameを除いたパスにする。 */
export function consolePathToRoute(path: string): string {
  const rest = path.slice(CONSOLE_BASE.length);
  return rest.startsWith("/") ? rest : `/${rest}`;
}
