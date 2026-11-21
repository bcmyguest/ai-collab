import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = fileURLToPath(new URL("server/ui.mjs", import.meta.url));
// One id per build; the page compares its own with the server's to offer a reload after a deploy.
const build = Date.now().toString(36);

export default {
  turbopack: { root },
  outputFileTracingRoot: root,
  env: { AI_COLLAB_UI_SERVER: server, AI_COLLAB_BUILD: build },
  generateBuildId: () => build,
  // The demo recorder builds into its own folder so it never replaces the build the live service serves.
  distDir: process.env.AI_COLLAB_NEXT_DIST || ".next",
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: [{ key: "X-Content-Type-Options", value: "nosniff" }] },
      // The service worker skips proxy.js; it gets its own CSP and is revalidated on every update check.
      { source: "/sw.js", headers: [
        { key: "Content-Type", value: "text/javascript; charset=utf-8" }, { key: "Cache-Control", value: "no-cache" },
        { key: "Content-Security-Policy", value: "default-src 'none'; connect-src 'self'" },
      ] },
    ];
  },
};
