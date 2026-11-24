"use client";
import { useEffect, type ReactNode } from "react";
import type { createAgent } from "@ui-sdk/react/agent";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

declare global {
  interface Window {
    aiCollabTestBridge?: ReturnType<typeof createAgent>;
  }
}

export function Providers({ nonce, children }: { nonce?: string; children: ReactNode }) {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_AI_COLLAB_TEST_BRIDGE === "1") {
      void import("@ui-sdk/react/agent").then(({ createAgent }) => {
        window.aiCollabTestBridge ??= createAgent();
      });
    }
  }, []);

  return <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange nonce={nonce}>
    <TooltipProvider>{children}</TooltipProvider>
    <Toaster/>
  </ThemeProvider>;
}
