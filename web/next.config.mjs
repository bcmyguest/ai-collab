import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PHASE_PRODUCTION_SERVER } from "next/constants.js";
import { productionDistDir } from "../lib/ui-build-output.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
// The source tree runs server/ui.ts; the built package ships it compiled as server/ui.js.
const source = fileURLToPath(new URL("server/ui.ts", import.meta.url));
const server = existsSync(source) ? source : fileURLToPath(new URL("server/ui.js", import.meta.url));
// One id per build; the page compares its own with the server's to offer a reload after a deploy.
const build = Date.now().toString(36);

let serverDistDir;

export default (phase) => ({
  turbopack: { root },
  outputFileTracingRoot: root,
  env: {
    AI_COLLAB_UI_SERVER: server,
    AI_COLLAB_BUILD: build,
    NEXT_PUBLIC_AI_COLLAB_TEST_BRIDGE: process.env.NEXT_PUBLIC_AI_COLLAB_TEST_BRIDGE === "1" ? "1" : "0",
  },
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
