"use client";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

export function Providers({ nonce, children }) {
  return <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange nonce={nonce}>
    <TooltipProvider>{children}</TooltipProvider>
    <Toaster/>
  </ThemeProvider>;
}
