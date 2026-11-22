import { join } from "node:path";
import { isGithubLogin } from "../../lib/config.mjs";

function error(status, message) {
  return Response.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
}

// Each UI instance sees only one owner's projects, including its implicit default,
// Home, archives, attachments and actions that broadcast to every visible project.
export function createHostedUi({ auth, projects, stateDir, origin, createUi }) {
  const groups = new Map();
  const credentials = new Map();
  const names = new Set();
  for (const cfg of projects) {
    if (!isGithubLogin(cfg.owner) || !cfg.token) throw new Error("Hosted projects require an owner and a dedicated ntfy token");
    const owner = cfg.owner.toLowerCase();
    if (credentials.has(cfg.token) && credentials.get(cfg.token) !== owner) {
      throw new Error("Hosted users must not share ntfy tokens");
    }
    if (names.has(cfg.project)) throw new Error("Hosted projects require unique topic namespaces");
    names.add(cfg.project);
    credentials.set(cfg.token, owner);
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push({ ...cfg, owner, stateDir: join(stateDir, "hosted", owner) });
  }
  const instances = new Map();
  function call(request, method, ...args) {
    const caller = request && auth.user(request);
    if (!caller) return error(401, "Sign in with GitHub");
    const login = caller.login.toLowerCase();
    if (!groups.has(login)) return error(404, "No project is assigned to your account");
    if (!instances.has(login)) {
      instances.set(login, createUi({ projects: groups.get(login), allowedOrigin: origin, auth, hosted: true }));
    }
    const instance = instances.get(login);
    return method === "file" ? instance.file(args[0], request) : instance[method](request, ...args);
  }

  const unavailable = request => auth.user(request)
    ? error(404, "Unavailable in hosted mode")
    : error(401, "Sign in with GitHub");

  return {
    auth: auth.route,
    events: request => call(request, "events"),
    handle: (request, action) => call(request, "handle", action),
    file: (name, request) => call(request, "file", name),
    push: unavailable,
    schedules: unavailable,
    close() {
      for (const instance of instances.values()) instance.close();
      instances.clear();
    },
  };
}
