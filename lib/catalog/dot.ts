/** team.dot: parses the DOT subset ai-collab reads and serializes the canonical form. Attribute rules: docs/teams.md. */
import { claudePermissionError, HARNESSES, isHarness, parseHarnessModel } from "../harness.ts";

const DOT_DONE = "done";
export const DOT_KINDS: readonly string[] = ["broadcast", "pair", "fan-in"];
const DOT_COUNT_MAX = 8;
const DOT_CAP_MAX = 10;
export const DOT_EVENT_MAX = 60;
const DOT_VISITS_MAX = 50;
// One limit for a role prompt in team.dot and in validatePattern (RESPONSIBILITY_MAX in pattern-model.ts).
export const DOT_PROMPT_MAX = 1000;

// Same shape as ROLE_ID in pattern-model.ts.
const NODE_ID = /^[a-z][a-z0-9_-]{0,23}$/;
const SKILL = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NODE_ATTRS = ["agent", "count", "skill", "prompt", "fallback", "code_mode"];
const EDGE_ATTRS = ["on", "kind", "required", "cap"];
// wteam display or session attributes: read, ignored, and reported as warnings.
const COSMETIC_ATTRS = ["shape", "label", "handoff_tokens", "continue"];
const GRAPH_ATTRS = ["description", "max_visits", "permission"];
const PUNCT = "{}[]=,;";
const WORD = /[A-Za-z_][A-Za-z0-9_]*|-?\d+(?:\.\d+)?/y;

export type DotWarning = { line: number; message: string };

export type DotNode = {
  id: string;
  agent: string;
  count: number;
  skill?: string;
  prompt?: string;
  fallback?: string;
  codeMode?: boolean;
  /** Non-enumerable on parsed nodes, so deepEqual on a node ignores it. */
  line?: number;
};

export type DotEdge = {
  from: string;
  to: string;
  on: string;
  kind: string;
  required: boolean;
  cap?: number;
};

export type DotTeam = {
  name: string;
  description: string;
  maxVisits: number | null;
  permission?: string;
  nodes: DotNode[];
  edges: DotEdge[];
  warnings: DotWarning[];
};

/** A team to serialize: count and kind default to 1 and "pair". */
export type DotTeamInput = {
  name: string;
  description?: string;
  maxVisits?: number | null;
  permission?: string;
  nodes: Array<Omit<DotNode, "count" | "line"> & { count?: number }>;
  edges: Array<Omit<DotEdge, "kind"> & { kind?: string }>;
};

type Token = { type: "string" | "id" | "punct"; value: string; line: number };
type Attr = { key: string; value: string; line: number };
type NodeStmt = { id: string; attrs: Attr[]; line: number };
type EdgeStmt = { ids: string[]; attrs: Attr[]; line: number };

export class DotError extends Error {
  line: number | null;

  constructor(message: string, line: number | null) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = "DotError";
    this.line = line;
  }
}

const isWord = (token: Token | undefined) => token?.type === "string" || token?.type === "id";
const isPunct = (token: Token | undefined, value: string) => token?.type === "punct" && token.value === value;
const countLines = (text: string) => text.split("\n").length - 1;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\n") { line += 1; i += 1; continue; }
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new DotError("unclosed comment", line);
      line += countLines(text.slice(i, end));
      i = end + 2;
      continue;
    }
    if (c === '"') {
      const start = line;
      let value = "";
      i += 1;
      for (;;) {
        if (i >= text.length) throw new DotError("unclosed string", start);
        const d = text[i];
        if (d === '"') { i += 1; break; }
        if (d === "\\" && i + 1 < text.length) {
          const e = text[i + 1];
          if (e === '"' || e === "\\") value += e;
          else if (e === "n") value += "\n";
          else value += `\\${e}`;
          if (e === "\n") line += 1;
          i += 2;
          continue;
        }
        if (d === "\n") line += 1;
        value += d;
        i += 1;
      }
      tokens.push({ type: "string", value, line: start });
      continue;
    }
    if (c === "-" && text[i + 1] === ">") {
      tokens.push({ type: "punct", value: "->", line });
      i += 2;
      continue;
    }
    if (PUNCT.includes(c)) {
      tokens.push({ type: "punct", value: c, line });
      i += 1;
      continue;
    }
    WORD.lastIndex = i;
    const match = WORD.exec(text);
    if (!match && c === "-") throw new DotError("quote ids containing -", line);
    if (!match) throw new DotError(`unexpected character "${c}"`, line);
    tokens.push({ type: "id", value: match[0], line });
    i += match[0].length;
  }
  return tokens;
}

const intIn = (value: string, lo: number, hi: number): number | null => {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= lo && n <= hi ? n : null;
};

function checkAgent(value: string, line: number): string {
  if (parseHarnessModel(String(value))) return String(value);
  const [harness, ...rest] = String(value).split(":");
  if (!isHarness(harness)) {
    throw new DotError(`agent harness must be one of ${HARNESSES.join(", ")}; got "${harness}"`, line);
  }
  throw new DotError(`invalid model "${rest.join(":")}" for ${harness}`, line);
}

/** Attributes by key, each checked against the allowed list and seen at most once. */
function attrMap(attrs: Attr[], allowed: string[], what: string, warnings: DotWarning[]): Map<string, Attr> {
  const seen = new Map<string, Attr>();
  for (const attr of attrs) {
    if (!allowed.includes(attr.key) && COSMETIC_ATTRS.includes(attr.key)) {
      warnings.push({ line: attr.line, message: `ignored ${what} attribute "${attr.key}" (wteam display attribute)` });
      continue;
    }
    if (!allowed.includes(attr.key)) throw new DotError(`unknown ${what} attribute "${attr.key}"`, attr.line);
    if (seen.has(attr.key)) throw new DotError(`duplicate ${what} attribute "${attr.key}"`, attr.line);
    seen.set(attr.key, attr);
  }
  return seen;
}

function nodeFrom(id: string, attrs: Attr[], line: number, warnings: DotWarning[]): DotNode {
  if (!NODE_ID.test(id) || id === DOT_DONE) throw new DotError(`invalid node id "${id}"`, line);
  const seen = attrMap(attrs, NODE_ATTRS, "node", warnings);
  if (!seen.has("agent")) throw new DotError(`node "${id}" needs agent="harness" or agent="harness:model"`, line);
  const node: DotNode = { id, agent: checkAgent(seen.get("agent")?.value ?? "", seen.get("agent")?.line ?? line), count: 1 };
  if (seen.has("count")) {
    const { value, line: at } = seen.get("count") ?? { value: "", line };
    const count = intIn(value, 1, DOT_COUNT_MAX);
    if (count === null) throw new DotError(`count must be a whole number 1-${DOT_COUNT_MAX}; got "${value}"`, at);
    node.count = count;
  }
  if (seen.has("skill")) {
    const { value, line: at } = seen.get("skill") ?? { value: "", line };
    if (!SKILL.test(value)) throw new DotError(`invalid skill "${value}"`, at);
    node.skill = value;
  }
  if (seen.has("prompt")) {
    const { value, line: at } = seen.get("prompt") ?? { value: "", line };
    if (value.length > DOT_PROMPT_MAX) throw new DotError(`prompt is longer than ${DOT_PROMPT_MAX} characters`, at);
    if (value.trim()) node.prompt = value.trim();
  }
  if (seen.has("fallback")) {
    const { value, line: at } = seen.get("fallback") ?? { value: "", line };
    node.fallback = checkAgent(value, at);
  }
  if (seen.has("code_mode")) {
    const { value, line: at } = seen.get("code_mode") ?? { value: "", line };
    if (value !== "on" && value !== "off") throw new DotError(`code_mode must be on or off; got "${value}"`, at);
    node.codeMode = value === "on";
  }
  Object.defineProperty(node, "line", { value: line, enumerable: false });
  return node;
}

function edgeFrom(attrs: Attr[], line: number, warnings: DotWarning[]): Omit<DotEdge, "from" | "to"> {
  const seen = attrMap(attrs, EDGE_ATTRS, "edge", warnings);
  if (!seen.has("on")) throw new DotError('edge needs on="event"', line);
  const on = (seen.get("on")?.value ?? "").trim();
  if (!on || on.length > DOT_EVENT_MAX) throw new DotError(`edge event must be 1-${DOT_EVENT_MAX} characters`, seen.get("on")?.line ?? line);
  const kind = seen.get("kind")?.value ?? "pair";
  if (!DOT_KINDS.includes(kind)) throw new DotError(`kind must be one of ${DOT_KINDS.join(", ")}; got "${kind}"`, seen.get("kind")?.line ?? line);
  let required = false;
  if (seen.has("required")) {
    const { value, line: at } = seen.get("required") ?? { value: "", line };
    if (value !== "true" && value !== "false") throw new DotError(`required must be true or false; got "${value}"`, at);
    required = value === "true";
  }
  const edge: Omit<DotEdge, "from" | "to"> = { on, kind, required };
  if (seen.has("cap")) {
    const { value, line: at } = seen.get("cap") ?? { value: "", line };
    const cap = intIn(value, 1, DOT_CAP_MAX);
    if (cap === null) throw new DotError(`cap must be a whole number 1-${DOT_CAP_MAX}; got "${value}"`, at);
    edge.cap = cap;
  }
  return edge;
}

/** Parses team.dot text; throws DotError with the line of the first problem. */
export function parseDot(text: string): DotTeam {
  const tokens = tokenize(String(text));
  const lastLine = tokens.at(-1)?.line ?? 1;
  let at = 0;
  const peek = () => tokens[at];
  const take = () => tokens[at++];
  const expect = (value: string) => {
    const token = peek();
    if (!isPunct(token, value)) throw new DotError(`expected "${value}"${token ? ` before "${token.value}"` : " at end of file"}`, token?.line ?? lastLine);
    at += 1;
  };
  const attrList = (): Attr[] => {
    const attrs: Attr[] = [];
    expect("[");
    while (!isPunct(peek(), "]")) {
      const key = take();
      if (!key) throw new DotError('missing "]" at end of file', lastLine);
      if (isPunct(key, "}")) throw new DotError('missing "]" before "}"', key.line);
      if (!isWord(key)) throw new DotError(`expected an attribute name, found "${key.value}"`, key.line);
      expect("=");
      const value = take();
      if (!isWord(value)) throw new DotError(`expected a value for "${key.value}"`, key.line);
      attrs.push({ key: key.value, value: value.value, line: key.line });
      if (isPunct(peek(), ",") || isPunct(peek(), ";")) at += 1;
    }
    at += 1;
    return attrs;
  };

  const head = take();
  if (head?.type !== "id" || head.value !== "digraph") throw new DotError('expected "digraph"', head?.line ?? 1);
  const nameToken = take();
  if (!isWord(nameToken)) throw new DotError("expected a team name after digraph", nameToken?.line ?? lastLine);
  expect("{");
  const graphs: Array<{ attrs: Attr[]; line: number }> = [];
  const nodeStmts: NodeStmt[] = [];
  const edgeStmts: EdgeStmt[] = [];
  while (!isPunct(peek(), "}")) {
    const token = peek();
    if (!token) throw new DotError('missing "}" at end of file', lastLine);
    if (isPunct(token, ";")) { at += 1; continue; }
    if (token.type === "id" && token.value === "graph" && isPunct(tokens[at + 1], "[")) {
      at += 1;
      graphs.push({ attrs: attrList(), line: token.line });
      continue;
    }
    if (!isWord(token)) throw new DotError(`unexpected "${token.value}"`, token.line);
    if (token.type === "id" && ["node", "edge", "subgraph"].includes(token.value) && isPunct(tokens[at + 1], "[")) {
      throw new DotError(`"${token.value}" defaults are not supported; set attributes on each node or edge`, token.line);
    }
    at += 1;
    if (isPunct(peek(), "=")) throw new DotError("graph attribute assignments are not supported; use graph [key=value]", token.line);
    if (isPunct(peek(), "->")) {
      const ids = [token.value];
      while (isPunct(peek(), "->")) {
        at += 1;
        const target = take();
        if (!isWord(target)) throw new DotError('expected a node name after "->"', token.line);
        ids.push(target.value);
      }
      const attrs = isPunct(peek(), "[") ? attrList() : [];
      edgeStmts.push({ ids, attrs, line: token.line });
    } else {
      const attrs = isPunct(peek(), "[") ? attrList() : [];
      nodeStmts.push({ id: token.value, attrs, line: token.line });
    }
    if (isPunct(peek(), ";")) at += 1;
  }
  at += 1;
  if (at < tokens.length) throw new DotError(`unexpected "${tokens[at].value}" after the graph`, tokens[at].line);

  const warnings: DotWarning[] = [];
  const graphAttrs = attrMap(graphs.flatMap((graph) => graph.attrs), GRAPH_ATTRS, "graph", warnings);
  let maxVisits: number | null = null;
  if (graphAttrs.has("max_visits")) {
    const { value, line } = graphAttrs.get("max_visits") ?? { value: "", line: 0 };
    maxVisits = intIn(value, 1, DOT_VISITS_MAX);
    if (maxVisits === null) throw new DotError(`max_visits must be a whole number 1-${DOT_VISITS_MAX}; got "${value}"`, line);
  }
  // A Claude permission setting for this team's starts; bypassPermissions is refused at start unless OpenShell allows it.
  const permissionAttr = graphAttrs.get("permission");
  if (permissionAttr && claudePermissionError(permissionAttr.value)) throw new DotError(claudePermissionError(permissionAttr.value), permissionAttr.line);

  const nodes: DotNode[] = [];
  const ids = new Set<string>();
  for (const stmt of nodeStmts) {
    if (ids.has(stmt.id)) throw new DotError(`node "${stmt.id}" is declared twice`, stmt.line);
    ids.add(stmt.id);
    nodes.push(nodeFrom(stmt.id, stmt.attrs, stmt.line, warnings));
  }
  if (!nodes.length) throw new DotError("team needs at least one node", 1);

  const edges: DotEdge[] = [];
  for (const stmt of edgeStmts) {
    const base = edgeFrom(stmt.attrs, stmt.line, warnings);
    for (let k = 0; k < stmt.ids.length - 1; k += 1) {
      const from = stmt.ids[k];
      const to = stmt.ids[k + 1];
      if (from === DOT_DONE) throw new DotError(`"${DOT_DONE}" can only receive handoffs`, stmt.line);
      if (!ids.has(from)) throw new DotError(`edge from unknown node "${from}"`, stmt.line);
      if (to !== DOT_DONE && !ids.has(to)) throw new DotError(`edge to unknown node "${to}"`, stmt.line);
      if (from === to) throw new DotError(`edge from "${from}" to itself`, stmt.line);
      if (to === DOT_DONE && base.cap !== undefined) throw new DotError("cap applies to a handoff between roles, not to done", stmt.line);
      edges.push({ from, to, ...base });
    }
  }

  return { name: nameToken.value, description: graphAttrs.get("description")?.value ?? "", maxVisits, ...(permissionAttr ? { permission: permissionAttr.value } : {}), nodes, edges, warnings };
}

const quote = (text: unknown): string => `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;

/** Team text in canonical form: graph attrs, then nodes, then edges, every edge attr written out. */
export function serializeDot(team: DotTeamInput): string {
  const lines = [`digraph ${quote(team.name)} {`];
  const graphAttrs: string[] = [];
  if (team.description) graphAttrs.push(`description=${quote(team.description)}`);
  if (team.maxVisits !== null && team.maxVisits !== undefined) graphAttrs.push(`max_visits=${team.maxVisits}`);
  if (team.permission) graphAttrs.push(`permission=${quote(team.permission)}`);
  if (graphAttrs.length) lines.push(`  graph [${graphAttrs.join(", ")}];`);
  for (const node of team.nodes) {
    const fields = [`agent=${quote(node.agent)}`, `count=${node.count ?? 1}`];
    if (node.skill) fields.push(`skill=${quote(node.skill)}`);
    if (node.prompt) fields.push(`prompt=${quote(node.prompt)}`);
    if (node.fallback) fields.push(`fallback=${quote(node.fallback)}`);
    if (typeof node.codeMode === "boolean") fields.push(`code_mode=${quote(node.codeMode ? "on" : "off")}`);
    lines.push(`  ${quote(node.id)} [${fields.join(", ")}];`);
  }
  for (const edge of team.edges) {
    const fields = [`on=${quote(edge.on)}`, `kind=${quote(edge.kind ?? "pair")}`, `required=${edge.required ? "true" : "false"}`];
    if (edge.cap !== undefined) fields.push(`cap=${edge.cap}`);
    lines.push(`  ${quote(edge.from)} -> ${quote(edge.to)} [${fields.join(", ")}];`);
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}
