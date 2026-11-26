// A2UI operations for a run-in-terminal card (lib/run-terminal.mjs), and the mapping of its Run or Reject action back.
import { A2UI_CATALOG_ID, A2UI_VERSION } from "./a2ui.js";

const RUN_ID = /^[a-f0-9]{24}$/;
const HEX64 = /^[a-f0-9]{64}$/;
export const runSurfaceId = id => "run-" + id;

const op = (kind, body) => ({ version: A2UI_VERSION, [kind]: body });
const text = (id, value, variant) => ({ id, component: "Text", text: value, ...(variant ? { variant } : {}) });
const button = (id, label, variant, name, context, checks) => [
  { id, component: "Button", child: id + "-label", variant, action: { event: { name, context } }, ...(checks ? { checks } : {}) },
  text(id + "-label", label),
];
const seconds = ms => (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) + " s";

/** The status line of a request that is no longer waiting for a click. */
export function runOutcome(request) {
  const by = request.by ? " · " + request.by : "";
  if (request.status === "rejected") return "Rejected" + by;
  if (request.status === "expired") return "Expired before anyone ran it";
  if (request.status === "refused") return "Refused: " + (request.why || "closed") + by;
  if (request.status === "running") return "Running" + by;
  if (request.status !== "done") return "";
  if (request.error) return "Could not start bash: " + request.error;
  if (request.timedOut) return `Killed at the ${request.timeoutS} s timeout · ${seconds(request.durationMs)}` + by;
  const end = request.signal ? "Ended by " + request.signal : "Exit " + request.exitCode;
  return `${end} · ${seconds(request.durationMs)}` + by;
}

/** createSurface, components and data model for one request; Run sends the hash the browser computed from the shown bytes. */
export function runOperations(request, now = Date.now()) {
  const surfaceId = runSurfaceId(request.id);
  const pending = request.status === "pending" && request.expiresAt > now;
  const status = pending ? "" : request.status === "pending" ? "Expired before anyone ran it" : runOutcome(request);
  const components = [
    { id: "root", component: "Column", children: [] },
    text("title", "Run in terminal"),
    { id: "badge", component: "Chip", text: pending ? "waiting" : request.status === "pending" ? "expired" : request.status, tone: pending ? "default" : "muted" },
    { id: "heading", component: "Row", children: ["title", "badge"], justify: "spaceBetween", align: "center" },
    text("reason", request.reason),
    text("from", "From " + request.session, "caption"),
    { id: "cwd", component: "Script", label: "cwd", text: request.cwd },
    { id: "script", component: "Script", label: "Script", text: { path: "/script" }, sha256: request.sha256, shown: { path: "/shown" } },
  ];
  const children = ["heading", "reason", "from", "cwd", "script"];
  if (pending) {
    const checks = [{ condition: { call: "required", args: { value: { path: "/shown" } } }, message: "Checking the script hash" }];
    components.push(...button("run", "Run", "primary", "run", { id: request.id, sha256: { path: "/shown" } }, checks));
    components.push(...button("reject", "Reject", "default", "reject", { id: request.id }));
    components.push({ id: "actions", component: "Row", children: ["reject", "run"], justify: "end" });
    components.push(text("expires", `Expires ${new Date(request.expiresAt).toISOString().slice(11, 16)} UTC · times out after ${request.timeoutS} s`, "caption"));
    children.push("actions", "expires");
  } else {
    components.push(text("status", status));
    children.push("status");
    if (request.stdoutTail) { components.push({ id: "stdout", component: "Script", label: "stdout", text: { path: "/stdout" } }); children.push("stdout"); }
    if (request.stderrTail) { components.push({ id: "stderr", component: "Script", label: "stderr", text: { path: "/stderr" } }); children.push("stderr"); }
  }
  components[0].children = children;
  return [
    op("createSurface", { surfaceId, catalogId: A2UI_CATALOG_ID }),
    op("updateComponents", { surfaceId, components }),
    op("updateDataModel", { surfaceId, path: "/", value: { script: request.script, shown: "", stdout: request.stdoutTail || "", stderr: request.stderrTail || "" } }),
  ];
}

/** {id, decision, sha256} from a run card's action, or null when the action is not one. */
export function runAnswer(userAction) {
  const context = userAction?.context;
  if (!context || typeof context !== "object" || typeof context.id !== "string" || !RUN_ID.test(context.id)) return null;
  if (userAction.surfaceId !== runSurfaceId(context.id)) return null;
  if (userAction.name === "reject") return { id: context.id, decision: "reject" };
  if (userAction.name === "run" && typeof context.sha256 === "string" && HEX64.test(context.sha256)) return { id: context.id, decision: "run", sha256: context.sha256 };
  return null;
}
