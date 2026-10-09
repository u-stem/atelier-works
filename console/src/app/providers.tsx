import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import { shouldRetryQuery } from "../api/queryPolicy.ts";
import { TooltipProvider } from "../components/ui/tooltip.tsx";
import { authStore } from "./authState.ts";

/**
 * 取得の失敗と成功をログインの状態に反映する。
 * 書き込みは再試行しない。結果が不明なまま2回実行しないため。
 */
function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        authStore.reportError(error);
      },
      onSuccess: () => {
        authStore.reportSuccess();
      },
    }),
    defaultOptions: {
      queries: { retry: shouldRetryQuery },
      mutations: { retry: 0 },
    },
  });
}

const queryClient = createQueryClient();

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}
