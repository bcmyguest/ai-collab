import { fileURLToPath } from "node:url";

import { PHASE_PRODUCTION_SERVER } from "next/constants.js";
import { productionDistDir } from "../lib/ui-build-output.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = fileURLToPath(new URL("server/ui.mjs", import.meta.url));
// One id per build; the page compares its own with the server's to offer a reload after a deploy.
const build = Date.now().toString(36);

let serverDistDir;

export default (phase) => ({
  turbopack: { root },
  outputFileTracingRoot: root,
  env: { AI_COLLAB_UI_SERVER: server, AI_COLLAB_BUILD: build },
  generateBuildId: () => build,
  // Pin the actual directory for this server process, even when Next loads config more than once.
  distDir: phase === PHASE_PRODUCTION_SERVER
    ? (serverDistDir ??= productionDistDir())
    : process.env.AI_COLLAB_NEXT_DIST || ".next",
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
});
