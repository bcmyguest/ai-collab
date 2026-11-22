// Tool inputs as file diffs: Claude Edit, MultiEdit and Write, and Codex apply_patch.
const EDIT_TOOL = /^(edit|multiedit)$/i;
const WRITE_TOOL = /^write$/i;
const PATCH_TOOL = /^apply_patch$/i;
const CONTEXT = 3;
export const DIFF_MAX_LINES = 400;

// Lines of a text: "" has none, one trailing newline adds none.
const linesOf = text => typeof text === "string" && text !== "" ? text.replace(/\n$/, "").split("\n") : [];
const lineOf = (t, s) => ({ t, s });
const countOf = (lines, t) => lines.filter(line => line.t === t).length;

// The hunk for one replacement: changed lines with up to CONTEXT unchanged lines around them.
function replaceHunk(oldText, newText) {
  const a = linesOf(oldText);
  const b = linesOf(newText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const before = a.slice(Math.max(0, head - CONTEXT), head).map(s => lineOf(" ", s));
  const after = a.slice(a.length - Math.min(CONTEXT, tail)).map(s => lineOf(" ", s));
  const removed = a.slice(head, a.length - tail).map(s => lineOf("-", s));
  const added = b.slice(head, b.length - tail).map(s => lineOf("+", s));
  return { lines: [...before, ...removed, ...added, ...after] };
}

const withHunks = (path, kind, hunks) => {
  const kept = hunks.filter(hunk => hunk.lines.some(line => line.t !== " "));
  const lines = kept.flatMap(hunk => hunk.lines);
  return { path, kind, hunks: kept, added: countOf(lines, "+"), removed: countOf(lines, "-") };
};

// Claude's Edit, MultiEdit and Write inputs: old and new text, or the full content of a new file.
function claudeFiles(tool, value) {
  const path = value.file_path ?? value.filePath;
  if (typeof path !== "string" || !path) return null;
  if (WRITE_TOOL.test(tool)) {
    if (typeof value.content !== "string") return null;
    return [withHunks(path, "add", [{ lines: linesOf(value.content).map(s => lineOf("+", s)) }])];
  }
  const edits = /^multiedit$/i.test(tool) ? value.edits : [value];
  if (!Array.isArray(edits) || !edits.length) return null;
  if (!edits.every(edit => typeof edit?.old_string === "string" && typeof edit?.new_string === "string")) return null;
  return [withHunks(path, "update", edits.map(edit => replaceHunk(edit.old_string, edit.new_string)))];
}

// Codex apply_patch envelope: "*** Begin Patch" with Add, Update and Delete File sections.
function envelopeFiles(lines) {
  const files = [];
  let file = null;
  let hunk = null;
  for (const line of lines) {
    const section = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (section) {
      file = { path: section[2].trim(), kind: { add: "add", update: "update", delete: "delete" }[section[1].toLowerCase()], hunks: [] };
      files.push(file);
      hunk = null;
    } else if (/^\*\*\* Move to: /.test(line) && file) {
      file.path = line.slice("*** Move to: ".length).trim();
    } else if (/^\*\*\* (End Patch|End of File)/.test(line) || !file) {
      continue;
    } else if (line.startsWith("@@")) {
      hunk = { lines: [] };
      file.hunks.push(hunk);
    } else if (/^[ +-]/.test(line) || line === "") {
      if (!hunk) {
        hunk = { lines: [] };
        file.hunks.push(hunk);
      }
      hunk.lines.push(lineOf(line === "" ? " " : line[0], line.slice(1)));
    }
  }
  return files.map(item => withHunks(item.path, item.kind, item.hunks));
}

// Unified diff text (git or plain ---/+++ headers): one entry per file.
function unifiedFiles(lines) {
  const files = [];
  let file = null;
  let hunk = null;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      file = { path: line.split(" b/").pop(), kind: "update", hunks: [] };
      files.push(file);
      hunk = null;
    } else if (line.startsWith("--- ")) {
      // A git header already opened this file; a plain header opens the next one.
      if (!file || file.hunks.length) {
        file = { path: "", kind: "update", hunks: [] };
        files.push(file);
        hunk = null;
      }
      if (line.startsWith("--- /dev/null")) file.kind = "add";
      else file.path ||= line.slice(4).trim().replace(/^a\//, "");
    } else if (line.startsWith("+++ ") && file) {
      if (line.startsWith("+++ /dev/null")) file.kind = "delete";
      else file.path = line.slice(4).trim().replace(/^b\//, "");
    } else if (line.startsWith("@@") && file) {
      hunk = { lines: [] };
      file.hunks.push(hunk);
    } else if (hunk && /^[ +-]/.test(line)) {
      hunk.lines.push(lineOf(line[0], line.slice(1)));
    }
  }
  return files.filter(item => item.path).map(item => withHunks(item.path, item.kind, item.hunks));
}

// The patch text of an apply_patch input: a bare string, or the command, input or patch field of an object.
function patchTextOf(input) {
  let value;
  try { value = JSON.parse(input); } catch { return input; }
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const text = [value.input, value.command, value.patch].find(item => typeof item === "string" || Array.isArray(item));
  return Array.isArray(text) ? text.findLast(item => typeof item === "string") ?? null : text ?? null;
}

// Parses a Codex or unified patch into files; null when the text is neither.
function patchFiles(text) {
  if (typeof text !== "string") return null;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.includes("*** Begin Patch")) return envelopeFiles(lines);
  if (lines.some(line => line.startsWith("+++ ")) && lines.some(line => line.startsWith("@@"))) return unifiedFiles(lines);
  return null;
}

/** Files a tool input changes as diffs, or null when the input is not a file edit: { files: [{ path, kind, hunks, added, removed }] }. */
export function toolDiff(tool, input) {
  if (!input || typeof tool !== "string") return null;
  if (PATCH_TOOL.test(tool)) {
    const files = patchFiles(patchTextOf(input));
    return files?.length ? { files } : null;
  }
  if (!EDIT_TOOL.test(tool) && !WRITE_TOOL.test(tool)) return null;
  let value;
  try { value = JSON.parse(input); } catch { return null; }
  const files = value && typeof value === "object" ? claudeFiles(tool, value) : null;
  return files ? { files } : null;
}

/** A unified diff for one file: headers, then each hunk with counts recomputed from its lines (line numbers are not known). */
export function patchOf(file) {
  const name = file.path.replace(/^\/+/, "");
  const out = [`--- ${file.kind === "add" ? "/dev/null" : "a/" + name}`, `+++ ${file.kind === "delete" ? "/dev/null" : "b/" + name}`];
  for (const hunk of file.hunks) {
    const old = countOf(hunk.lines, " ") + countOf(hunk.lines, "-");
    const next = countOf(hunk.lines, " ") + countOf(hunk.lines, "+");
    out.push(`@@ -${old ? 1 : 0},${old} +${next ? 1 : 0},${next} @@`);
    for (const line of hunk.lines) out.push(line.t + line.s);
  }
  return out.join("\n");
}

/** The files with at most max diff lines across them, and the count of lines left out. */
export function limitFiles(files, max = DIFF_MAX_LINES) {
  const total = files.reduce((sum, file) => sum + file.hunks.reduce((n, hunk) => n + hunk.lines.length, 0), 0);
  let budget = max;
  const shown = files.map(file => {
    const hunks = [];
    for (const hunk of file.hunks) {
      if (budget <= 0) break;
      const lines = hunk.lines.slice(0, budget);
      budget -= lines.length;
      hunks.push({ lines });
    }
    return { ...file, hunks };
  });
  const kept = shown.reduce((sum, file) => sum + file.hunks.reduce((n, hunk) => n + hunk.lines.length, 0), 0);
  return { files: shown, hidden: total - kept };
}
