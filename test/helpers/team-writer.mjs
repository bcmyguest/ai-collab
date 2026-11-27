// Child process for the projects.json concurrency test: creates teams one by one, retrying when the lock is busy.
import { loadConfig } from "../../lib/config.ts";
import { createTeam } from "../../lib/catalog/roster.ts";

async function main() {
  const [env, prefix, count] = [JSON.parse(process.argv[2]), process.argv[3], Number(process.argv[4])];
  const cfg = loadConfig(env);
  for (let i = 0; i < count; i += 1) {
    for (;;) {
      try {
        await createTeam(cfg, `${prefix}-${i}`, ["claude"], env);
        break;
      } catch (error) {
        if (!/busy/.test(String(error.message))) throw error;
      }
    }
  }
}

// Runs only as the child of catalog-projects.test.mjs (env CATALOG_TEAM_WRITER=1), never under node --test.
if (process.env.CATALOG_TEAM_WRITER === "1") await main();
