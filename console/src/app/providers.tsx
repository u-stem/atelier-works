import { onlineManager, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Toaster } from "../components/ui/sonner.tsx";
import { TooltipProvider } from "../components/ui/tooltip.tsx";
import { authStore } from "./authState.ts";
import { createQueryClient, syncInitialOnlineState } from "./queryClient.ts";

const queryClient = createQueryClient(authStore);
syncInitialOnlineState(onlineManager, navigator);

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {children}
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
