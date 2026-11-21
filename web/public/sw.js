// AI Collab service worker: shows Web Push notifications and opens the UI at the item's thread on tap.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : "" }; }
  const tag = typeof data.tag === "string" && data.tag ? data.tag : undefined;
  const important = data.important === true;
  event.waitUntil(self.registration.showNotification(String(data.title || "AI Collab"), {
    body: String(data.body || ""), tag, renotify: Boolean(tag && important), requireInteraction: important,
    data: { url: typeof data.url === "string" ? data.url : "/" },
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  let url = new URL(event.notification.data?.url || "/", self.location.origin);
  if (url.origin !== self.location.origin) url = new URL("/", self.location.origin);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (!open) return self.clients.openWindow(url.href);
    await open.focus();
    open.postMessage({ type: "ai-collab-open", hash: url.hash });
  })());
});

// The push service rotated the subscription: subscribe again with the same key and tell the server.
self.addEventListener("pushsubscriptionchange", event => {
  event.waitUntil((async () => {
    const key = event.oldSubscription?.options?.applicationServerKey;
    const subscription = event.newSubscription || (key && await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
    if (!subscription) return;
    const post = (method, body) => fetch("/api/push/subscribe", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (event.oldSubscription) await post("DELETE", { endpoint: event.oldSubscription.endpoint }).catch(() => {});
    await post("POST", { subscription: subscription.toJSON() });
  })());
});
