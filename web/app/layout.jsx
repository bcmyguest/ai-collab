import { headers } from "next/headers";
import { Providers } from "./providers.jsx";
import "./globals.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "AI Collab · Messages" };
export const viewport = {
  width: "device-width", initialScale: 1, interactiveWidget: "resizes-content",
  themeColor: [{ media: "(prefers-color-scheme: dark)", color: "#141418" }, { media: "(prefers-color-scheme: light)", color: "#fafafb" }],
};

export default async function RootLayout({ children }) {
  // next-themes injects an inline script, so it needs the CSP nonce set by proxy.js.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return <html lang="en" suppressHydrationWarning><body><Providers nonce={nonce}>{children}</Providers></body></html>;
}
