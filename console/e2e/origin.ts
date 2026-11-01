// 検査用のサーバーの待ち受け。`playwright.config.ts`と、API受け口の判定が同じ値を使う。
// `mise run console:branch`の既定(5174)と重ならない番号にする。

export const PORT = 5183;
export const ORIGIN = `http://127.0.0.1:${PORT}`;
