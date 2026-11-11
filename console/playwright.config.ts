// ビルド済みのConsole(`dist/`)をブラウザで開いて、アクセシビリティと書き込みの操作を検査する設定。
// 配信は`scripts/console-branch-server.ts`で行う。本番のCaddyと同じCSPなどのヘッダーを付けるため、
// CSPの下でも検査が動くことを確かめられる。APIは、書き込みも含めて各検査が固定の値で受けるので、中継先には繋がない。
// 検査の起動は`bun run test:a11y`。先に`bun run build`が要る。

import { defineConfig, devices } from "@playwright/test";
import { ORIGIN, PORT } from "./e2e/origin.ts";

const inCi = process.env.CI !== undefined && process.env.CI !== "";

export default defineConfig({
  testDir: "e2e",
  // 検査の名前は、`bun test`が拾わない名前(`*.a11y.ts`と`*.e2e.ts`)にする。
  testMatch: ["**/*.a11y.ts", "**/*.e2e.ts"],
  fullyParallel: true,
  // 検査はaxeの解析でCPUを使うので、CIでは論理コアの数だけ並列にする。
  // ローカルはPlaywrightの既定(論理コアの半分)のままにする。
  workers: inCi ? "100%" : "50%",
  forbidOnly: inCi,
  retries: 0,
  reporter: inCi
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: ORIGIN,
    // 動きの途中の色を測らない。
    reducedMotion: "reduce",
    viewport: { width: 1280, height: 800 },
    locale: "ja-JP",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `bun ../scripts/console-branch-server.ts --dist dist --port ${PORT}`,
    url: `${ORIGIN}/console/`,
    reuseExistingServer: !inCi,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
