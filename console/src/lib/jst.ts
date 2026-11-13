// 日本時間(JST)の扱い。Backendと同じ`f/factory/lib/jst.ts`の定義を使う。
// 表示の整形は、`Intl.DateTimeFormat`に`Asia/Tokyo`を渡して行う。
// 日の境界の計算は、UTCとの差を足してからUTCの部品(`toISOString`など)で読む。

export {
  formatJstClock,
  JST_OFFSET_MS,
} from "../../../f/factory/lib/jst.ts";
