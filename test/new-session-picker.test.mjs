import { test } from "node:test";
import assert from "node:assert/strict";
import { activeModel, chooseHarness, flatModels, modelGroups, modelLabel, moveActive, placeOptions } from "../web/lib/new-session.js";
import { MODE_LABELS, START_MODES, modeFlags, startModes } from "../web/lib/start-mode.js";

const MODELS = {
  claude: ["opus-5-5", "sonnet-5"],
  codex: ["gpt-5.6-sol", "gpt-5-codex", "gpt-5.1-codex-mini"],
  cursor: ["deepseek-v41-flash-1017-high", "composer-2.5"],
  opencode: ["opencode/zen-1"],
};

test("the model menu groups only the startable harnesses, in the order they can start", () => {
  const groups = modelGroups({ startable: ["codex", "cursor"], models: MODELS });
  assert.deepEqual(groups.map(group => group.harness), ["codex", "cursor"]);
  assert.deepEqual(groups.map(group => group.label), ["Codex", "Cursor"]);
  assert.deepEqual(groups[0].models, ["gpt-5.6-sol", "gpt-5-codex", "gpt-5.1-codex-mini"]);
  // A startable harness with an empty list is not a group, so no empty heading shows.
  assert.deepEqual(modelGroups({ startable: ["opencode", "claude"], models: { ...MODELS, opencode: [] } }).map(group => group.harness), ["claude"]);
  assert.deepEqual(modelGroups({ startable: ["cursor"], models: {} }), []);
});

test("a search narrows across harnesses by model name, harness name and harness id", () => {
  const startable = ["claude", "codex", "cursor"];
  assert.deepEqual(modelGroups({ startable, models: MODELS, query: "opus" }).map(group => group.models), [["opus-5-5"]]);
  assert.equal(modelGroups({ startable, models: MODELS, query: "gpt-5-codex" })[0].models[0], "gpt-5-codex");
  // The harness label finds its models even when no model name matches.
  assert.deepEqual(modelGroups({ startable, models: MODELS, query: "claude code" }).map(group => group.harness), ["claude"]);
  assert.deepEqual(modelGroups({ startable, models: MODELS, query: "cursor" }).map(group => group.harness), ["cursor"]);
  assert.deepEqual(modelGroups({ startable, models: MODELS, query: "zzz" }), []);
  // Whitespace alone is not a query: the whole list stays.
  assert.deepEqual(modelGroups({ startable, models: MODELS, query: "   " }).map(group => group.harness), ["claude", "codex", "cursor"]);
});

test("the flat menu order matches the grouped rows, and the keyboard moves and wraps", () => {
  const groups = modelGroups({ startable: ["claude", "codex"], models: MODELS });
  const listed = flatModels(groups);
  assert.equal(listed.length, 5);
  assert.deepEqual(listed[2], { harness: "codex", model: "gpt-5.6-sol" });
  assert.equal(moveActive(0, 1, 5), 1);
  assert.equal(moveActive(4, 1, 5), 0, "down past the last row returns to the first");
  assert.equal(moveActive(0, -1, 5), 4, "up from the first row wraps to the last");
  assert.equal(moveActive(0, 1, 0), 0, "an empty list has one position");
  assert.deepEqual(activeModel(listed, 0), { harness: "claude", model: "opus-5-5" });
  assert.deepEqual(activeModel(listed, 99), { harness: "codex", model: "gpt-5.1-codex-mini" }, "a stale index clamps to the last row");
  assert.equal(activeModel([], 3), null, "Enter picks nothing from an empty menu");
});

test("the mode pill lists only the modes its harness has", () => {
  assert.deepEqual(startModes("cursor"), ["agent", "ask", "plan"]);
  assert.deepEqual(startModes("claude"), ["agent", "plan"], "Claude has no ask mode, so Ask is never offered");
  assert.deepEqual(startModes("codex"), ["agent", "plan"]);
  assert.deepEqual(startModes("nope"), []);
  assert.deepEqual(Object.keys(MODE_LABELS), ["agent", "ask", "plan"]);
  assert.deepEqual(Object.keys(START_MODES).sort(), ["claude", "codex", "cursor", "opencode"]);
});

test("mode flags are the harness's own read-only switches, and agent adds nothing", () => {
  assert.deepEqual(modeFlags("claude", "plan"), ["--permission-mode", "plan"]);
  assert.deepEqual(modeFlags("codex", "plan"), ["-s", "read-only"]);
  assert.deepEqual(modeFlags("cursor", "plan"), ["--mode", "plan"]);
  assert.deepEqual(modeFlags("cursor", "ask"), ["--mode", "ask"]);
  assert.deepEqual(modeFlags("opencode", "plan"), ["--agent", "plan"]);
  for (const harness of ["claude", "codex", "cursor", "opencode"]) assert.deepEqual(modeFlags(harness, "agent"), []);
  assert.equal(modeFlags("claude", "ask"), null, "a mode the harness lacks is refused, not mapped to another");
  assert.equal(modeFlags("cursor", "yolo"), null);
  assert.equal(modeFlags("bash", "plan"), null);
});

test("the place pill shows the server's places by name, in the server's order", () => {
  assert.deepEqual(placeOptions(["folder", "openshell"]), [
    { id: "folder", label: "Folder", name: "Local folder" },
    { id: "openshell", label: "OpenShell", name: "OpenShell sandbox" },
  ]);
  assert.deepEqual(placeOptions([]), []);
  assert.deepEqual(placeOptions(["elsewhere"]), [{ id: "elsewhere", label: "elsewhere", name: "elsewhere" }], "an unknown place still renders");
});

test("the model pill shows the model, else the harness name, else a generic word", () => {
  assert.equal(modelLabel({ harness: "cursor", model: "deepseek-v41-flash-1017-high" }), "deepseek-v41-flash-1017-high");
  assert.equal(modelLabel({ harness: "codex", model: "" }), "Codex");
  assert.equal(modelLabel({ harness: "opencode", model: "" }), "OpenCode");
  assert.equal(modelLabel({}), "Model");
  assert.equal(modelLabel(null), "Model");
});

test("choosing a harness keeps the model only when that harness lists it", () => {
  assert.deepEqual(chooseHarness({ harness: "codex", model: "gpt-5.6-sol" }, "codex", MODELS), { harness: "codex", model: "gpt-5.6-sol" });
  assert.deepEqual(chooseHarness({ harness: "codex", model: "gpt-5.6-sol" }, "claude", MODELS), { harness: "claude", model: "opus-5-5" });
  // The same model name on another harness is kept.
  assert.deepEqual(chooseHarness({ harness: "claude", model: "opus-5-5" }, "cursor", { ...MODELS, cursor: ["opus-5-5", "composer-2.5"] }), { harness: "cursor", model: "opus-5-5" });
  assert.deepEqual(chooseHarness({ harness: "claude", model: "opus-5-5" }, "opencode", MODELS), { harness: "opencode", model: "opencode/zen-1" });
  assert.deepEqual(chooseHarness({}, "claude", MODELS), { harness: "claude", model: "opus-5-5" });
});
