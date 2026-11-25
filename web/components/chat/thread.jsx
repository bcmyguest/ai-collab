"use client";
// The chat thread on assistant-ui: the feed's thread entries (chat messages interleaved with activity rows)
// ride an external-store runtime so the message list and markdown come from maintained primitives instead of
// hand-rolled ones. The console keeps its own scroll container: the feed's pull-to-refresh and scroll memory
// need raw scroll control the assistant-ui viewport does not expose, so only the message list moved.
import { createContext, useCallback, useContext } from "react";
import { AssistantRuntimeProvider, useExternalStoreRuntime } from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { MARKDOWN_COMPONENTS } from "@/components/ui/markdown";
import { withMentions } from "@/lib/mentions";

/**
 * Runtime over the thread entries from web/lib/chat-turns.js and project-feed.js.
 * A chat message becomes a text part; an activity row becomes a data part so one ordered
 * list drives the thread, and the renderer dispatches on the entry bound to each message.
 */
export function ChatRuntimeProvider({ entries, operator, children }) {
  const convertMessage = useCallback((entry) => entry.message
    ? {
      id: String(entry.message.id),
      role: entry.message.from === operator ? "user" : "assistant",
      createdAt: entry.message.time ? new Date(entry.message.time * 1000) : undefined,
      content: [{ type: "text", text: entry.message.body || "" }],
    }
    : {
      id: String(entry.activity.id),
      role: "assistant",
      createdAt: entry.activity.time ? new Date(entry.activity.time * 1000) : undefined,
      content: [{ type: "data-activity", data: entry.activity }],
    }, [operator]);
  // The composer sends through the console's own action path; the runtime only renders the thread.
  const onNew = useCallback(async () => {}, []);
  const runtime = useExternalStoreRuntime({ messages: entries, convertMessage, onNew, isRunning: false });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

/** Per-bubble render settings, read by BubbleText inside the message part context. */
export const BubbleContext = createContext({ plugins: null });

/** The maintained markdown renderer, with the app's remark config, mention links and shiki code blocks. */
export function BubbleText() {
  const { plugins } = useContext(BubbleContext);
  return <MarkdownTextPrimitive className="contents" smooth={false} remarkPlugins={plugins || undefined}
    components={MARKDOWN_COMPONENTS} preprocess={withMentions}/>;
}
