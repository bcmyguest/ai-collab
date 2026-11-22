import { EventType } from "@ag-ui/core";
import { parseSSEStream, runHttpRequest } from "@ag-ui/client";
import { parseEvent, projectEvent } from "../../lib/agui.mjs";
import { A2UI_ACTIVITY } from "./a2ui.js";

export const ACTIVITY_BATCH = "ai-collab.activity-batch";
export const STREAM_ERROR = "ai-collab.stream-error";

/** Collect activity rows until the server completes a reset or append batch. */
export function projectUiEvents() {
  let items = [];
  return raw => {
    const event = parseEvent(raw);
    if (!event) return null;
    if (event.type === EventType.STATE_SNAPSHOT) {
      return { type: event.type, event: "state", data: event.snapshot };
    }
    if (event.type === EventType.ACTIVITY_SNAPSHOT && event.activityType === A2UI_ACTIVITY && Array.isArray(event.content.a2ui_operations)) {
      return { type: event.type, event: "surface", data: { id: event.messageId, operations: event.content.a2ui_operations } };
    }
    if (event.type === EventType.CUSTOM && event.name === STREAM_ERROR) {
      return { type: event.type, event: "problem", data: event.value };
    }
    if (event.type === EventType.CUSTOM && event.name === ACTIVITY_BATCH) {
      if (typeof event.value?.reset !== "boolean") return null;
      const data = { reset: event.value.reset, items };
      items = [];
      return { type: event.type, event: "activity", data };
    }
    const meta = event.metadata?.aiCollabUi;
    if (!meta) return null;
    const row = projectEvent(event);
    if (row?.kind !== "activity") return null;
    const { id, time, attachment } = meta;
    const { from, session, harness, type, tool, callId, input, output, agent } = row;
    items.push({
      id, time, agent: from + "#" + session, harness, type,
      ...(tool ? { tool } : {}), ...(callId ? { callId } : {}),
      ...(input ? { input } : {}), ...(output ? { output } : {}),
      ...(agent ? { subagent: agent } : {}), ...(attachment ? { attachment } : {}),
    });
    return null;
  };
}

export function subscribeUiEvents(fetchResponse, observer) {
  const project = projectUiEvents();
  return parseSSEStream(runHttpRequest(fetchResponse)).subscribe({
    ...observer,
    next(raw) {
      const update = project(raw);
      if (update) observer.next(update);
    },
  });
}
