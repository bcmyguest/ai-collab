// @peer, @peer#session, @harness:model and @peer#session/run tags; the run is a subagent run ID.
export const MENTION = /(^|[\s(])@([a-z][\w-]*(?:#[a-f0-9]{16}(?:\/[A-Za-z0-9_-]+)?|:[A-Za-z0-9._/-]*[A-Za-z0-9_/-])?)(?![\w#])/g;

/** Marks @tags as "#mention" links so Markdown colours only the tag. */
export function withMentions(body) {
  return String(body).replace(MENTION, "$1[@$2](#mention)");
}
