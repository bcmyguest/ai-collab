/** Who receives a thread-channel post (docs/threads.md "Who receives a post"); no imports, so the browser bundle uses it too. */

export type ThreadRole = "subagent" | "cooperative";
export type ListenCase = { role: ThreadRole; member: boolean; listening?: boolean | null; mentioned?: boolean };

export const THREAD_TARGET = /^thread:(th_[a-f0-9]{16})$/;

/** A session with a parent is a subagent; one without is cooperative. */
export function threadRole(parent: unknown): ThreadRole {
  return typeof parent === "string" && parent ? "subagent" : "cooperative";
}

/** True when the session listens without a mention: its setting, else the role default (cooperative members listen). */
export function listens({ role, member, listening }: ListenCase): boolean {
  if (listening === true || listening === false) return listening;
  return role === "cooperative" && member;
}

/** True when a post reaches the session: a mention always does, otherwise only listening. */
export function delivered(c: ListenCase): boolean {
  return c.mentioned === true || listens(c);
}
