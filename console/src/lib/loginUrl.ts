// 401のときにWindmillのログイン画面へ渡す、戻り先つきのURLを作る。

/** Windmillのログイン画面。戻り先は`rd`引数で渡す。 */
const LOGIN_PATH = "/user/login";
const CONSOLE_ROOT = "/console/";

type LocationParts = {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
};

/**
 * 戻り先に使ってよいパスか。Console配下の絶対パスに限る。
 * `//`で始まるパスや`..`・`\`を含むパスは、別のオリジンや別のパスへ解釈されうるため除く。
 */
function isConsolePath(pathname: string): boolean {
  if (!pathname.startsWith(CONSOLE_ROOT)) {
    return false;
  }
  if (pathname.includes("\\")) {
    return false;
  }
  return !pathname.split("/").includes("..");
}

/**
 * ログイン画面のURLを返す。戻り先`rd`は現在の`pathname + search + hash`にする。
 * 現在のパスが`/console/`で始まらないときは`/console/`に戻す。
 * 戻り先はオープンリダイレクトにならないよう、パスだけを`URLSearchParams`で組み立てる。
 */
export function buildLoginUrl(location: LocationParts): string {
  const returnTo = isConsolePath(location.pathname)
    ? `${location.pathname}${location.search}${location.hash}`
    : CONSOLE_ROOT;
  const params = new URLSearchParams({ rd: returnTo });
  return `${LOGIN_PATH}?${params.toString()}`;
}
