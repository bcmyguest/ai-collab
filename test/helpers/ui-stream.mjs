import { subscribeUiEvents } from "../../web/lib/ui-events.js";

export async function* sse(response) {
  const abort = new AbortController();
  const body = response.body.pipeThrough(new TransformStream(), { signal: abort.signal });
  let subscription;
  const updates = new ReadableStream({
    start(controller) {
      subscription = subscribeUiEvents(() => Promise.resolve(new Response(body, response)), {
        next: update => controller.enqueue(update),
        error: error => controller.error(error),
        complete: () => controller.close(),
      });
    },
  });
  try {
    yield* updates;
  } finally {
    subscription.unsubscribe();
    abort.abort();
  }
}

export async function firstUpdate(response, name) {
  for await (const { event, data } of sse(response)) {
    if (event === name) return data;
    if (event === "problem") throw new Error(data.error);
  }
  throw new Error("stream ended");
}
