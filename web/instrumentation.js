// Starts the messaging server with Next.js, so push notifications go out before any browser connects.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ui } = await import("./server/instance.js");
  await ui().catch(err => console.error("ai-collab UI failed to start:", err.message));
}
