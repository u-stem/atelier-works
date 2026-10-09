import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Toaster } from "../components/ui/sonner.tsx";
import { TooltipProvider } from "../components/ui/tooltip.tsx";
import { authStore } from "./authState.ts";
import { createQueryClient } from "./queryClient.ts";

const queryClient = createQueryClient(authStore);

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
