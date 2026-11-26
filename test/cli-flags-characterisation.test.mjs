// Pins how the CLI splits argv into flags and words, so the parser can move to util.parseArgs unchanged.
import assert from "node:assert/strict";
import test from "node:test";
import { parseFlags, readProgram } from "../lib/cli.mjs";

const SEND = { "--file": 1, "--await": 1, "--urgent": 0, "--priority": 1, "--expect-reply": 0, "--reply-to": 1, "--progress": 0 };

test("known flags take their arity; everything else is a word, in order", () => {
  assert.deepEqual(parseFlags(["bob", "--urgent", "hello", "--priority", "fyi", "world"], SEND), {
    flags: { "--urgent": true, "--priority": "fyi" }, words: ["bob", "hello", "world"],
  });
});

test("a repeated many-flag collects every value", () => {
  assert.deepEqual(parseFlags(["--tag", "a", "x", "--tag", "b"], { "--tag": "many" }), { flags: { "--tag": ["a", "b"] }, words: ["x"] });
});

test("unknown dash tokens stay words, so a message may start with a dash", () => {
  assert.deepEqual(parseFlags(["bob", "-1 is wrong", "--nope", "-x"], SEND), { flags: {}, words: ["bob", "-1 is wrong", "--nope", "-x"] });
});

test("a value flag takes the next token even when it starts with a dash", () => {
  assert.deepEqual(parseFlags(["--reply-to", "--urgent", "bob"], SEND), { flags: { "--reply-to": "--urgent" }, words: ["bob"] });
});

test("a value flag at the end marks the parse bad", () => {
  assert.equal(parseFlags(["bob", "hi", "--await"], SEND).flags.bad, true);
});

test("a single value flag keeps the last value", () => {
  assert.deepEqual(parseFlags(["--limit", "1", "--limit", "5"], { "--limit": 1 }).flags, { "--limit": "5" });
});

test("readProgram maps agents, history and peers onto run_code reads", () => {
  assert.equal(readProgram(["agents", "--all", "--tag", "a", "--tag", "b"]), 'return await ai.list_agents({"all":true,"tags":["a","b"]});');
  assert.equal(readProgram(["history", "--limit", "5"]), 'return await ai.channel_history({"limit":5});');
  assert.equal(readProgram(["history", "--limit", "x"]), "return await ai.channel_history({});");
  assert.equal(readProgram(["peers"]), 'return await ai.list_agents({"all":true});');
  assert.equal(readProgram(["agents", "--help"]), null);
});
