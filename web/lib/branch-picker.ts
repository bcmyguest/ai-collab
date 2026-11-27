// The new-session toolbar's two pickers: which environment to start in, and which branch to start it from.
export type EnvId = "folder" | "worktree" | "existing" | "openshell";

export const ENV_LABELS: Record<EnvId, string> = { folder: "Local folder", worktree: "New worktree", existing: "Existing worktree", openshell: "OpenShell" };

export type Ref = { name: string; remote: boolean; date: number; sha: string };
export type Worktree = { path: string; branch: string | null; head: string; locked: boolean; dirty: boolean };
export type Pr = { number: number; title: string; head: string; base: string | null };

export type Pick = { base: string; branch: string; worktreePath: string };
export const EMPTY_PICK: Pick = { base: "", branch: "", worktreePath: "" };

const PR_NUMBER = /^#([1-9][0-9]{0,6})$/;
// What git check-ref-format --branch rejects that a plain name would otherwise slip past.
const BRANCH_BAD_CHARS = /[\s\x00-\x1f\x7f~^:?*[\\]/;
const SHA = /^[0-9a-f]{7,64}$/;

/** The environment select's menu: only the places the server lists, with the two worktree rows kept together. */
export function envOptions(places: string[]): { id: EnvId; label: string }[] {
  const options: { id: EnvId; label: string }[] = [];
  if (places.includes("folder")) options.push({ id: "folder", label: ENV_LABELS.folder });
  if (places.includes("worktree")) {
    options.push({ id: "worktree", label: ENV_LABELS.worktree }, { id: "existing", label: ENV_LABELS.existing });
  }
  if (places.includes("openshell")) options.push({ id: "openshell", label: ENV_LABELS.openshell });
  return options;
}

/** The selected environment: the current one while still offered, else the preferred one, else Folder, else the first. */
export function envChoice(current: string, options: { id: EnvId }[], preferred = "folder"): EnvId {
  const offered = (id: string): id is EnvId => options.some(option => option.id === id);
  if (offered(current)) return current;
  if (offered(preferred)) return preferred;
  if (offered("folder")) return "folder";
  return options[0]?.id ?? "folder";
}

/** The start body's place fields. */
export type StartWhere = { place: "folder" | "worktree" | "openshell"; base?: string; branch?: string; worktreePath?: string };

/** The start body's place fields: only a new worktree carries a base and branch, only an existing one a path. */
export function envPayload(env: EnvId, pick: Pick): StartWhere {
  if (env === "worktree") {
    return { place: "worktree", ...(pick.base ? { base: pick.base } : {}), ...(pick.branch ? { branch: pick.branch } : {}) };
  }
  if (env === "existing") return pick.worktreePath ? { place: "worktree", worktreePath: pick.worktreePath } : { place: "worktree" };
  return { place: env };
}

/** The pull request a query asks for: "#123" on its own, else nothing. */
export function prNumber(query: string): number | null {
  const match = PR_NUMBER.exec(query.trim());
  return match ? Number(match[1]) : null;
}

/** Whether a query could be a new branch name: git's own check is the authority, this only stops the obvious. */
export function looksLikeBranch(name: string): boolean {
  if (!name || name.length > 200 || name === "@") return false;
  if (name.startsWith("-") || name.startsWith("/")) return false;
  if (name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
  if (BRANCH_BAD_CHARS.test(name)) return false;
  return !name.split("/").some(part => part.startsWith("."));
}

/** The "Create branch" row: a name worth offering, or null when the query is empty, a pull request, or an existing branch. */
export function createOption(query: string, refs: Ref[], base: string): { name: string; base: string } | null {
  const name = query.trim();
  if (!name || prNumber(name) !== null || !looksLikeBranch(name)) return null;
  if (refs.some(ref => !ref.remote && ref.name === name)) return null;
  return { name, base };
}

/** The branch button's text: what it would start from, or the branch it would create and start from. */
export function triggerLabel(env: EnvId, pick: Pick, current: string): string {
  const head = current || "HEAD";
  if (env === "folder") return head;
  if (env === "openshell") return `from ${head}`;
  if (env === "existing") return pick.worktreePath.split("/").filter(Boolean).pop() || "Choose a worktree";
  const base = pick.base || head;
  return pick.branch ? `${pick.branch} from ${base}` : `from ${base}`;
}

/** What a worktree row flags beside its path. */
export function worktreeMarks(row: Worktree): string[] {
  const marks: string[] = [];
  if (row.dirty) marks.push("dirty");
  if (row.locked) marks.push("locked");
  if (row.branch === null) marks.push("detached");
  return marks;
}

/** A commit's short id, or nothing when the value isn't one. */
export function shortSha(sha: string): string {
  return SHA.test(sha) ? sha.slice(0, 7) : "";
}
