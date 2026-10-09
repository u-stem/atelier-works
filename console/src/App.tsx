import { ReloadBanner } from "./ReloadBanner.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";
import { useReleaseWatch } from "./useReleaseWatch.ts";

/** 切り替えまでの間は、Windmillのraw appの旧Consoleへ案内する。 */
const LEGACY_CONSOLE_PATH = "/apps/get/f/factory/factory_console";

export function App() {
  const releaseNotice = useReleaseWatch();
  return (
    <>
      <ReloadBanner notice={releaseNotice} />
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-12">
        <header className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold">Factory Console</h1>
          <ThemeToggle />
        </header>
        <p className="text-muted-foreground">
          新しいConsoleを準備しています。それまでは旧Consoleを使ってください。
        </p>
        <a
          className="w-fit text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          href={LEGACY_CONSOLE_PATH}
        >
          旧Consoleを開く
        </a>
      </main>
    </>
  );
}
