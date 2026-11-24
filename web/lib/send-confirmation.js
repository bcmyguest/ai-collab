export const SEND_CONFIRMATION = "application/x-ndjson";

export async function readSendConfirmation(response) {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  async function next() {
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        return JSON.parse(line);
      }
      const { done, value } = await reader.read();
      if (done) throw new Error("Send confirmation ended unexpectedly");
      buffer += value;
    }
  }

  const confirmed = await next();
  const followup = next().catch(() => null).finally(() => reader.cancel().catch(() => {}));
  return { ...confirmed, followup };
}
