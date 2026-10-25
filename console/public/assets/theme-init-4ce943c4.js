// 描画の前に、保存したテーマの選択をhtmlのdata-themeに写す。
// CSPがインラインのscriptを拒否するので、外部のファイルにしている。
// キーと値はsrc/lib/theme.tsのTHEME_STORAGE_KEYとparseThemePreference、resolveThemeに合わせる。
// 「OSに合わせる」のときも、OSの配色の設定を解決してdata-themeを付ける。
// メディアクエリに色を任せると、OSの設定が変わったとき、遷移を止めるより先に色が替わり始める。
// 選択はdata-theme-preferenceに残す。OSの設定の変更を受けるとき、これで「OSに合わせる」かを見分ける。
(() => {
  const root = document.documentElement;
  let preference = "system";
  try {
    const value = window.localStorage.getItem("factory-console.theme");
    if (value === "light" || value === "dark") {
      preference = value;
    }
  } catch {
    // 保存領域を読めないときは、OSの設定に従う。
  }
  root.dataset.themePreference = preference;
  if (preference !== "system") {
    root.dataset.theme = preference;
    return;
  }
  try {
    root.dataset.theme = window.matchMedia("(prefers-color-scheme: dark)")
      .matches
      ? "dark"
      : "light";
  } catch {
    // OSの設定を読めないときは、data-themeを付けず、スタイルシートの既定に任せる。
  }
})();
