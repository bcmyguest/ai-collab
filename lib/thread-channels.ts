/**
 * Thread channels, sender side (docs/threads.md "Thread channels"): resolve who a `thread:<id>` post reaches, publish
 * the post once on its thread topic and one direct copy per recipient, and read or toggle a session's listening.
 */
import { listOwned, listSessions } from "./sessions/registry.ts";
import { mentionsAgent, parseEnvelope, publishThreadPost, sendMessage, type AttachmentInput, type Cfg, type TransportEvent } from "./messaging.ts";
import { channelClient, type Channel, type ChannelClient } from "./thread-channel-store.ts";
import { THREAD_TARGET, delivered, threadRole } from "./thread-listening.ts";

// oxlint-disable-next-line typescript/no-explicit-any -- registry records and envelopes are JSON
type Json = any;

const FULL_MENTION = /(^|[^\w#-])@([a-z0-9-]{1,24}#[a-f0-9]{16})(?:\/[A-Za-z0-9_-]{1,64})?(?![\w-])/g;

export type ThreadSendOptions = {
  attachment?: AttachmentInput; urgent?: boolean; priority?: string; replyTo?: string; by?: string; expectReply?: boolean;
  onPublished?: (ev: TransportEvent) => void; client?: ChannelClient; sessions?: Json[]; owned?: Json[]; [other: string]: unknown;
};

const clientOf = (cfg: Cfg): ChannelClient => channelClient({ url: cfg.url, token: cfg.token, timeoutMs: cfg.timeoutMs });
const senderOf = (cfg: Cfg): string => (cfg.session ? `${cfg.peer}#${cfg.session}` : cfg.peer);

function threadIdOf(target: unknown): string {
  const id = THREAD_TARGET.exec(String(target))?.[1];
  if (!id) throw new Error(`invalid thread "${target}": use thread:th_<16 hex>`);
  return id;
}

async function ownChannel(cfg: Cfg, client: ChannelClient, id: string): Promise<Channel> {
  const channel = await client.channel(id);
  if (channel.thread.project !== cfg.project) throw Object.assign(new Error("Unknown thread"), { status: 404 });
  return channel;
}

/** The addresses a post reaches, in channel order then mention order; registry sessions only, the sender never. */
export function channelRecipients(channel: Channel, { sessions = [], owned = [], body = "", sender = "" }: { sessions?: Json[]; owned?: Json[]; body?: string; sender?: string }): string[] {
  const known = new Set<string>();
  const parents = new Map<string, string>();
  for (const s of sessions) {
    if (typeof s?.id !== "string") continue;
    known.add(s.id);
    if (typeof s.parent === "string" && s.parent) parents.set(s.id, s.parent);
  }
  for (const o of owned) {
    if (typeof o?.address === "string" && typeof o.parent === "string" && o.parent && !parents.has(o.address)) parents.set(o.address, o.parent);
  }
  const candidates = new Map(channel.sessions.map((s) => [s.session, s]));
  const full = new Set([...String(body).matchAll(FULL_MENTION)].map((m) => m[2]));
  for (const address of full) if (!candidates.has(address)) candidates.set(address, { session: address, member: false, listening: null });
  const out: string[] = [];
  for (const [address, c] of candidates) {
    if (address === sender || !known.has(address)) continue;
    const [peer, session] = address.split("#");
    // A member or a session with a setting answers to @peer too; anyone else only to its full address.
    const mentioned = c.member || c.listening !== null ? mentionsAgent(body, { peer, session }) : full.has(address);
    if (delivered({ role: threadRole(parents.get(address)), member: c.member, listening: c.listening, mentioned })) out.push(address);
  }
  return out;
}

/** Posts body to thread:<id>: the post once on the thread topic, then a direct copy to each recipient. */
export async function sendToThread(cfg: Cfg, target: string, body: string, options: ThreadSendOptions = {}) {
  const { attachment, urgent, priority, replyTo, by, expectReply, onPublished, client = clientOf(cfg), sessions, owned, ...rest } = options;
  const id = threadIdOf(target);
  const unsupported = Object.keys(rest).filter((key) => rest[key] !== undefined && key !== "threadId" && key !== "operatorThread");
  if (unsupported.length) throw new Error(`a thread post takes no ${unsupported.join(", ")}`);
  if (expectReply === true) throw new Error("expect_reply needs a direct, non-fyi message");
  if (rest.threadId !== undefined && rest.threadId !== id) throw new Error("threadId must match the thread target");
  if (typeof body !== "string" || (!body.trim() && attachment === undefined)) throw new Error("empty message");
  const channel = await ownChannel(cfg, client, id);
  const recipients = channelRecipients(channel, {
    sessions: sessions ?? listSessions(cfg), owned: owned ?? listOwned(cfg), body, sender: senderOf(cfg),
  });
  const post = await publishThreadPost(cfg, id, body, { attachment, ...(by ? { by } : {}) });
  if (!post.id) throw new Error("the bus returned no id for the thread post");
  const operator = cfg.peer === "operator";
  for (const to of recipients) {
    await sendMessage(cfg, to, body, {
      threadId: id, channelOf: post.id, attachment, urgent, priority, replyTo, onPublished,
      ...(operator ? { operatorThread: true, ...(by ? { by } : {}) } : {}),
    });
  }
  return { topic: post.topic, id: post.id, thread: id, delivered: recipients, members: channel.sessions.filter((s) => s.member).map((s) => s.session) };
}

/** The thread's posts as message views, oldest first (docs/threads.md "Listening toggle"). */
export async function threadMessages(cfg: Cfg, thread: string, { since, limit, client = clientOf(cfg) }: { since?: string; limit?: number; client?: ChannelClient } = {}) {
  const id = threadIdOf(thread.startsWith("thread:") ? thread : `thread:${thread}`);
  const channel = await ownChannel(cfg, client, id);
  const page = await client.messages(id, { since, limit });
  const messages = page.events.flatMap((ev) => {
    const m: Json = parseEnvelope(ev.message);
    if (m?.kind !== "msg" || typeof m.body !== "string") return [];
    return [{
      id: ev.id, ts: new Date(ev.time * 1000).toISOString(),
      from: m.session ? `${m.from}#${m.session}` : m.from, to: m.toSession ? `${m.to}#${m.toSession}` : m.to,
      body: m.body, ...(ev.attachment ? { attachment: ev.attachment } : {}),
    }];
  });
  return { thread: id, title: channel.thread.title, messages, more: page.more };
}

/** Turns listening on or off for the caller's own session in the thread. */
export async function threadListen(cfg: Cfg, thread: string, on: boolean, { client = clientOf(cfg) }: { client?: ChannelClient } = {}) {
  if (!cfg.session) throw new Error("thread listen needs a session");
  if (typeof on !== "boolean") throw new Error("on must be true or false");
  const id = threadIdOf(thread.startsWith("thread:") ? thread : `thread:${thread}`);
  await ownChannel(cfg, client, id);
  return client.setListening(id, senderOf(cfg), on);
}
