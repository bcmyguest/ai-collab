"use client";
import { useTheme } from "next-themes";
import { Toaster as Sonner } from "sonner";

/** shadcn/ui Toaster: sonner themed from next-themes. */
export function Toaster(props) {
  const { theme = "system" } = useTheme();
  return <Sonner theme={theme} position="top-center" closeButton className="toaster group"
    style={{ "--normal-bg": "var(--popover)", "--normal-text": "var(--popover-foreground)", "--normal-border": "var(--border)" }} {...props}/>;
}
