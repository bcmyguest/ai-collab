// Run after the UI service has been activated. Pass its URL as the first argument,
// or set AI_COLLAB_UI_VERIFY_URL. The default targets the local operator service.
// The smoke opens Home and the decision inbox, then returns Home without acting on decisions.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const url = process.argv[2] || process.env.AI_COLLAB_UI_VERIFY_URL
  || `http://127.0.0.1:${process.env.AI_COLLAB_UI_PORT || 8795}/`;
const smoke = fileURLToPath(new URL("../tools/smoke-ui.mjs", import.meta.url));
const result = spawnSync(process.execPath, [smoke, url, "--operator-workflow"], {
  stdio: "inherit",
  timeout: 90_000,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
