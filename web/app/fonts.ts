import localFont from "next/font/local";

// Hanken Grotesk for the interface and IBM Plex Mono for code and ids, both self-hosted under the OFL (see app/fonts/).
export const grotesk = localFont({ src: "./fonts/hanken-grotesk-latin-wght-normal.woff2", weight: "100 900", variable: "--font-grotesk", display: "swap" });
export const plexMono = localFont({
  src: [{ path: "./fonts/ibm-plex-mono-latin-400-normal.woff2", weight: "400" }, { path: "./fonts/ibm-plex-mono-latin-500-normal.woff2", weight: "500" }],
  variable: "--font-plex-mono", display: "swap",
});
