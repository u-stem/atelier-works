// ConsoleのURLのフラグメントから、開く作業項目を読み取る。
// `#requirements/<work_item_id>`(`attempt-<k>`付きも可)は要件定義書を、
// `#audit/<work_item_id>`は監査レポートを指す。
// どちらも`f/factory/lib/approval_support.ts`が作り、
// IssueのコメントやDiscordの通知に載せる。
//
// raw appは不透明なオリジン(サンドボックス)から配信されるため、
// 埋め込み元のページのURLを読める保証は無い。
// 確実に読めるのは自分の`window.location.hash`だけである。
// それでも、同一オリジンでの埋め込み(WindmillのUIのプレビュー用iframeなど)では
// `window.parent.location.hash`や`document.referrer`も読めるため、
// これらも候補にする。候補のうち最初に一致したものを使う。

export type RequirementsDeepLink = {
  readonly work_item_id: number;
  readonly attempt: number | null;
};

const DEEP_LINK_PATTERN = /#requirements\/(\d+)(?:\/attempt-(\d+))?/;

/**
 * `candidates`のうち`#requirements/<id>`のフラグメントを含む最初の文字列を解析する。
 * どれも一致しなければ`null`を返す。
 * `attempt-<k>`が無いか正の整数でなければ、`attempt`は`null`にする。
 */
export function parseDeepLink(
  candidates: readonly string[],
): RequirementsDeepLink | null {
  for (const candidate of candidates) {
    const match = DEEP_LINK_PATTERN.exec(candidate);
    if (match === null) {
      continue;
    }
    const workItemIdText = match[1];
    if (workItemIdText === undefined) {
      continue;
    }
    const workItemId = Number(workItemIdText);
    if (!Number.isInteger(workItemId) || workItemId <= 0) {
      continue;
    }
    const attemptText = match[2];
    const attempt =
      attemptText === undefined ? Number.NaN : Number(attemptText);
    return {
      work_item_id: workItemId,
      attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : null,
    };
  }
  return null;
}

export type AuditDeepLink = { readonly work_item_id: number };

const AUDIT_DEEP_LINK_PATTERN = /#audit\/(\d+)/;

/**
 * `candidates`のうち`#audit/<id>`のフラグメントを含む最初の文字列を解析する。
 * このフラグメントは監査から出た承認依頼のリンクに付き、
 * 監査タブでその監査の作業項目の詳細を開くのに使う。
 * `parseDeepLink`と同じ規則で、`attempt`の部分は無い。
 */
export function parseAuditDeepLink(
  candidates: readonly string[],
): AuditDeepLink | null {
  for (const candidate of candidates) {
    const match = AUDIT_DEEP_LINK_PATTERN.exec(candidate);
    const idText = match?.[1];
    if (idText === undefined) continue;
    const workItemId = Number(idText);
    if (Number.isInteger(workItemId) && workItemId > 0) {
      return { work_item_id: workItemId };
    }
  }
  return null;
}

/**
 * `parseDeepLink`に渡す候補の文字列を、優先する順に集めて返す。
 * 自分のウィンドウのハッシュ、親フレームのハッシュ
 * (同一オリジンで埋め込まれたときだけ)、参照元のURLの順。
 * `window`と`document`を読むだけで分岐を持たないため、単体テストはしない。
 */
export function collectDeepLinkCandidates(): string[] {
  const candidates: string[] = [window.location.hash];
  try {
    candidates.push(window.parent.location.hash);
  } catch {
    // 親フレームが別オリジンだと、`window.parent.location`は`SecurityError`を投げる。
  }
  if (document.referrer.length > 0) {
    candidates.push(document.referrer);
  }
  return candidates;
}
