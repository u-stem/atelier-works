// 描画の前に、保存したテーマの選択をhtmlのdata-themeに写す。
// CSPがインラインのscriptを拒否するので、外部のファイルにしている。
// キーと値はsrc/lib/theme.tsのTHEME_STORAGE_KEYとparseThemePreferenceに合わせる。
(() => {
  try {
    const value = window.localStorage.getItem("factory-console.theme");
    if (value === "light" || value === "dark") {
      document.documentElement.dataset.theme = value;
    }
  } catch {
    // 保存領域を読めないときは、OSの設定に従う。
  }
})();
