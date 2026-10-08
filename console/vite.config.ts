import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// /console/の下で配信する。ハッシュ付きのファイルはassets/に出し、Caddyが長期のキャッシュで返す。
// modulepreloadのpolyfillはインラインのscriptになりうるので入れない(CSPがインラインを拒否する)。
export default defineConfig({
  base: "/console/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    assetsDir: "assets",
    emptyOutDir: true,
    sourcemap: false,
    modulePreload: { polyfill: false },
  },
});
