import { headers } from "next/headers";
import { Providers } from "./providers";
import { grotesk, plexMono } from "./fonts";
import "./globals.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "ai-collab" };
export const viewport = {
  width: "device-width", initialScale: 1, interactiveWidget: "resizes-content",
  themeColor: [{ media: "(prefers-color-scheme: dark)", color: "#1d1b19" }, { media: "(prefers-color-scheme: light)", color: "#fbfaf8" }],
};

export default async function RootLayout({ children }) {
  // next-themes injects an inline script, so it needs the CSP nonce set by proxy.js.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return <html lang="en" suppressHydrationWarning className={grotesk.variable + " " + plexMono.variable}><body><Providers nonce={nonce}>{children}</Providers></body></html>;
}
