// ビルド済みのConsole(`dist/`)をブラウザで開いて、アクセシビリティを検査する設定。
// 配信は`scripts/console-branch-server.ts`で行う。本番のCaddyと同じCSPなどのヘッダーを付けるため、
// CSPの下でも検査が動くことを確かめられる。APIは各検査が固定の値で受けるので、中継先には繋がない。
// 検査の起動は`bun run test:a11y`。先に`bun run build`が要る。

import { defineConfig, devices } from "@playwright/test";
import { ORIGIN, PORT } from "./e2e/origin.ts";

const inCi = process.env.CI !== undefined && process.env.CI !== "";

export default defineConfig({
  testDir: "e2e",
  // `bun test`が拾わないよう、検査の名前は`*.a11y.ts`にする。
  testMatch: "**/*.a11y.ts",
  fullyParallel: true,
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
