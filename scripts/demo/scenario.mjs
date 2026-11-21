/**
 * The demo story: the operator asks two agents for a calculator and watches them work from a phone.
 * Every row comes from the real system: hook processes with fake payloads, lib/inbox.mjs sendMessage, the
 * Next.js UI. Selectors use roles, labels and text; optional beats (approval card, Home) are skipped when absent.
 */
import { broadcastTopic } from "../../lib/config.mjs";

const PROMPT = ["@cl", "@claude", " build a small calculator app; ", "@co", "@codex", " write its tests"];
const CALC_SOURCE = `<output aria-label="Display">0</output>
<div class="keys"><button>7</button><button class="op">×</button></div>
<script>
  const apply = { "+": (a, b) => a + b, "×": (a, b) => a * b };
</script>`;
const TESTS = "▶ calculator\n  ✔ adds 2 + 3 (0.4ms)\n  ✔ multiplies 12 × 7 (0.1ms)\n  ✔ divides by zero → ∞ (0.1ms)\n  ✔ chains 1 + 2 × 3 (0.1ms)\n  ✔ clears with C (0.1ms)\n  ✔ toggles sign ± (0.1ms)\nℹ tests 6\nℹ pass 6\nℹ fail 0";

// Runs the scenario; rec records camera, caption and speed marks against the live screencast.
export async function scenario({ page, rec, agents, fake, screenshot, project }) {
  const { claude, codex } = agents;
  const log = page.getByRole("log");
  const composer = page.getByLabel("Message", { exact: true });
  const ticks = (label) => log.getByRole("img", { name: label, exact: true }).last();
  const skipped = [];

  // 1. Chat: a broadcast with two @mentions, picked from the mention list; ticks go ✓ → ✓✓ → read.
  rec.caption("Chat with your agents", "@mention a harness or a session");
  await composer.waitFor();
  await rec.wait(600);
  await composer.click();
  await rec.fast(async () => {
    for (let i = 0; i < PROMPT.length; i++) {
      const part = PROMPT[i];
      if (part.startsWith("@") && PROMPT[i + 1]?.startsWith("@")) {
        await composer.pressSequentially(part, { delay: 90 });
        const full = PROMPT[++i];
        const picker = page.getByRole("listbox", { name: /mention/i });
        if (await picker.waitFor({ timeout: 1500 }).then(() => true, () => false)) {
          await rec.wait(900);
          // Prefer the harness entry ("@claude") over a session ("@claude#…").
          const option = picker.getByRole("option").filter({ hasText: new RegExp(full + "(?!#)") }).first();
          if (await option.count()) await option.click(); else await page.keyboard.press("Tab");
        } else await composer.pressSequentially(full.slice(part.length) + " ", { delay: 60 });
        // The picker inserts "@name "; drop the extra space before the next typed chunk.
        if ((await composer.inputValue()).endsWith(" ")) await page.keyboard.press("Backspace");
        continue;
      }
      await composer.pressSequentially(part, { delay: 40 });
    }
  });
  await rec.wait(300);
  await page.keyboard.press("Enter");
  const sent = log.getByText("build a small calculator app", { exact: false }).last();
  await sent.waitFor();
  const state = log.getByRole("img", { name: /^(Sent|Delivered|Read)$/ }).last();
  await state.waitFor({ timeout: 5000 }).catch(() => {});
  await rec.focus([state.locator("xpath=.."), state], { zoom: 2.3 });
  await rec.wait(600);
  await rec.fast(async () => {
    await claude.run({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/work/calc-demo/package.json" }, tool_use_id: "t_pkg" }, true);
    await ticks("Delivered").waitFor({ timeout: 8000 }).catch(() => {});
  });
  await rec.wait(700);
  await rec.fast(async () => {
    await claude.run({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/work/calc-demo/package.json" }, tool_response: { type: "text", file: { filePath: "/work/calc-demo/package.json", content: "{ \"scripts\": { \"test\": \"node --test\" } }" } }, tool_use_id: "t_pkg" }, true);
    await claude.run({ hook_event_name: "UserPromptSubmit", prompt: "build a small calculator app" });
    await codex.run({ hook_event_name: "UserPromptSubmit", turn_id: "t1", prompt: "write the calculator tests" });
    await ticks("Read").waitFor({ timeout: 8000 }).catch(() => {});
  });
  await rec.wait(900);
  await rec.wide();
  await claude.say("On it: one `calc.html`, no build step. I'll post a screenshot when it runs.");
  const reply = log.getByText("On it: one", { exact: false }).last();
  await reply.waitFor();
  await rec.spotlight([reply], { left: true });
  await rec.wait(1000);

  // 2. Agent working: open Claude's session thread and stream its tool calls.
  rec.caption("Watch an agent work", "Live tool calls, results and code");
  await rec.wide();
  await log.getByRole("button", { name: "Open " + claude.id, exact: true }).last().click();
  await composer.waitFor();
  await rec.fast(async () => {
    await claude.run({ hook_event_name: "MessageDisplay", message_id: "m1", index: 0, final: true, delta: "I'll write the page, then run the tests." }, true);
    await claude.run({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/work/calc-demo/calc.html", content: CALC_SOURCE }, tool_use_id: "t_write" }, true);
  });
  const write = log.getByLabel("Tool call Write").last();
  await write.waitFor();
  await page.getByRole("status").filter({ hasText: /working/i }).waitFor({ timeout: 3000 }).catch(() => {});
  await rec.wait(800);
  await rec.fast(() => claude.run({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/work/calc-demo/calc.html", content: CALC_SOURCE }, tool_response: { type: "create", filePath: "/work/calc-demo/calc.html" }, tool_use_id: "t_write" }, true));
  await write.click();
  await rec.wait(300);
  await rec.spotlight([write], { anchor: "top", left: true });
  await rec.wait(1500);
  await rec.wide();
  await write.click();

  // 3. Subagent: one collapsed row that counts steps; expand it, then it finishes.
  rec.caption("Subagents stay tidy", "One row per run · tap to expand");
  const sub = { agent_id: "agent-explore-1", agent_type: "Explore" };
  await rec.fast(async () => {
    await claude.run({ ...sub, hook_event_name: "SubagentStart" }, true);
    await claude.run({ ...sub, hook_event_name: "PreToolUse", tool_name: "Glob", tool_input: { pattern: "**/*.test.mjs" }, tool_use_id: "t_s1" }, true);
    await claude.run({ ...sub, hook_event_name: "PostToolUse", tool_name: "Glob", tool_input: { pattern: "**/*.test.mjs" }, tool_response: { filenames: ["test/calc.test.mjs"] }, tool_use_id: "t_s1" }, true);
  });
  const run = log.getByRole("button", { name: /^Subagent · Explore( · in \S+)? · running/ }).last();
  await run.waitFor();
  await rec.spotlight([run], { left: true });
  await rec.fast(async () => {
    await claude.run({ ...sub, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/work/calc-demo/test/calc.test.mjs" }, tool_use_id: "t_s2" }, true);
    await claude.run({ ...sub, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/work/calc-demo/test/calc.test.mjs" }, tool_response: { type: "text", file: { filePath: "/work/calc-demo/test/calc.test.mjs", content: "test(\"adds\", () => assert.equal(add(2, 3), 5));" } }, tool_use_id: "t_s2" }, true);
  });
  await rec.wait(500);
  await run.click();
  await rec.wait(300);
  await rec.spotlight([run, log.locator("[data-subagent]").last()], { anchor: "top", left: true });
  await rec.wait(600);
  await rec.fast(async () => {
    await claude.run({ ...sub, hook_event_name: "SubagentStop", last_assistant_message: "Tests live in test/calc.test.mjs and cover +, −, ×, ÷." }, true);
    await log.getByRole("button", { name: /^Subagent · Explore( · in \S+)? · done/ }).last().waitFor();
  });
  await rec.wait(1000);
  await rec.wide();
  await rec.fast(async () => {
    await claude.run({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test", description: "Run the calculator tests" }, tool_use_id: "t_bash" }, true);
    await rec.wait(600);
    await claude.run({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { stdout: TESTS, stderr: "" }, tool_use_id: "t_bash" }, true);
  });
  await rec.wait(600);

  // 4. Another harness: Codex runs the suite and reports back in the project chat.
  rec.caption("Every harness, one chat", "Claude Code, Codex and Cursor side by side");
  await rec.fast(async () => {
    await goProject(page, project);
    await log.getByText("On it: one", { exact: false }).last().waitFor();
    await codex.run({ hook_event_name: "PreToolUse", turn_id: "t1", tool_name: "Bash", tool_input: { command: "node --test test/calc.test.mjs" }, tool_use_id: "c_test" }, true);
    await codex.run({ hook_event_name: "PostToolUse", turn_id: "t1", tool_name: "Bash", tool_input: { command: "node --test test/calc.test.mjs" }, tool_response: TESTS, tool_use_id: "c_test" }, true);
    await codex.say("@claude 6 tests for calc.html, all passing ✅");
  });
  const passing = log.getByText("all passing", { exact: false }).last();
  await passing.waitFor();
  await rec.spotlight([passing], { left: true });
  await rec.wait(1100);
  await rec.wide();

  // 5. Image: Claude sends a real screenshot of the finished calculator through the attachment path.
  rec.caption("Screenshots, inline", "Agents attach images to their messages");
  await claude.say("Done ✨ 12 × 7 = 84 on the live page:", { attachment: screenshot });
  const image = log.getByRole("img", { name: /calculator/i }).last();
  await image.waitFor();
  await image.evaluate((img) => img.complete || new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; }));
  await rec.wait(500);
  await image.scrollIntoViewIfNeeded();
  await rec.spotlight([image]);
  await rec.wait(1600);
  await rec.wide();

  // 6a. Optional: an approval card answered with Allow, when this build has phone approvals.
  if (!(await approval({ page, rec, claude, fake, project }))) skipped.push("approval card");

  // 6b. Optional: the Home overview, else the Activity overview.
  rec.caption("Everything at a glance", "Who is online, working, or waiting");
  if (!(await overview(page))) skipped.push("overview");
  await rec.wait(1800);
  return { skipped };
}

// Opens the project chat through the Projects menu, falling back to the URL hash.
async function goProject(page, project) {
  try {
    await page.getByRole("button", { name: "Projects", exact: true }).click({ timeout: 2000 });
    await page.getByRole("dialog").getByRole("button", { name: project, exact: true }).click({ timeout: 2000 });
  } catch {
    await page.keyboard.press("Escape").catch(() => {});
    await page.evaluate((name) => { location.hash = "project=" + encodeURIComponent(name); }, project);
  }
}

// A real PermissionRequest hook blocks until the operator taps Allow; returns false when no card appears.
async function approval({ page, rec, claude, fake, project }) {
  fake.inject(broadcastTopic(project), JSON.stringify({ v: 1, kind: "mode", from: "operator", mode: "on", ts: Date.now() }));
  const decision = claude.run({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "git commit -am \"feat: calculator\"", description: "Commit the calculator" } });
  const allow = page.getByRole("button", { name: "Allow", exact: true }).last();
  if (!(await allow.waitFor({ timeout: 8000 }).then(() => true, () => false))) return false;
  await allow.scrollIntoViewIfNeeded();
  await rec.wait(300);
  rec.caption("Approve from anywhere", "Allow or deny a tool call");
  const card = page.locator("[data-card=approval]").last();
  await rec.spotlight([(await card.count()) ? card : allow]);
  await rec.wait(1100);
  await allow.click();
  await decision;
  await page.getByText(/allowed/i).last().waitFor({ timeout: 5000 }).catch(() => {});
  await rec.wait(1200);
  await rec.wide();
  return true;
}

// Shows a Home overview when the build has one, else the Activity overview of all agents.
async function overview(page) {
  const home = page.getByRole("button", { name: /^home$/i }).or(page.getByRole("link", { name: /^home$/i })).or(page.getByRole("tab", { name: /^home$/i }));
  if (await home.count()) { await home.first().click(); return true; }
  try {
    await page.getByRole("button", { name: "Projects", exact: true }).click({ timeout: 2000 });
    await page.getByRole("dialog").getByRole("button", { name: /^Activity/ }).first().click({ timeout: 2000 });
    await page.getByText(/Activity · all agents/).waitFor({ timeout: 4000 });
    return true;
  } catch {
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  }
}
