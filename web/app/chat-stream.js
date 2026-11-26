// The console's live stream: one /api/events subscription per view, its reconnect ladder, and the view cache
// that lets a screen switch render from the last frame while the new stream revalidates it.
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { subscribeUiEvents } from "@/lib/ui-events";
import { streamViews } from "@/lib/stream-views";
import { AUTH_CHECK, checkBuild, CONNECTION_TOAST, initial } from "./chat-api";

const QUIET_RETRY_MS = 500;
const RECONNECT_GRACE_MS = 3_000;
const STALE_AFTER_MS = 20_000;

/**
 * Owns the streamed screen for one `requested` stream key.
 * `route` is the console's live route ref: frames for a stream the console has left are dropped.
 * `onReady` runs on the first state frame (the console refreshes its clock there).
 */
export function useStream({ requested, route, account, onReady }) {
  const [cached] = useState(() => streamViews.restore(requested));
  const [data, setData] = useState(cached?.data || initial);
  const [activity, setActivity] = useState(cached?.activity || []);
  // A2UI surfaces by id, from the stream's ACTIVITY_SNAPSHOT frames.
  const [surfaces, setSurfaces] = useState(cached?.surfaces || {});
  // A restored view is already complete, so its screen renders at once instead of waiting for the new state frame.
  const [ready, setReady] = useState(Boolean(cached));
  const [loadError, setLoadError] = useState("");
  const [revision, setRevision] = useState(0);
  const retrying = useRef(false);
  const shown = useRef(false);
  const autoRetry = useRef(true);
  const hiddenAt = useRef(0);

  // A switch to a screen already in the cache shows its last frame at once; the new stream revalidates it.
  function restore(nextStream) {
    const view = streamViews.restore(nextStream);
    if (view) { setData(view.data); setActivity(view.activity); setSurfaces(view.surfaces); }
    else setActivity([]);
    setReady(Boolean(view));
    setLoadError("");
    return view;
  }

  // Pull to refresh and the error banner's Retry: reconnect now, and say so if it fails.
  function retry() {
    retrying.current = true;
    setRevision(n => n + 1);
  }

  useEffect(() => {
    let controller;
    let subscription;
    let closed = false;
    let bannerTimer = 0;
    let retryTimer = 0;
    // Error banners wait for one quiet reconnect; a manual Retry or a visible error ends in one toast.
    const show = error => { clearTimeout(bannerTimer); shown.current = true; setLoadError(error); };
    // A failure that heals within RECONNECT_GRACE_MS (a phone waking up) shows nothing, so no "Reconnected" follows.
    const fail = error => {
      if (!retrying.current) { clearTimeout(bannerTimer); bannerTimer = setTimeout(() => show(error), RECONNECT_GRACE_MS); return; }
      show(error);
      retrying.current = false; toast.error("Reconnect failed", { id: CONNECTION_TOAST, description: error });
    };
    const reconnect = () => { autoRetry.current = true; setRevision(n => n + 1); };
    const disconnected = error => {
      if (controller.signal.aborted || requested !== route.current) return;
      controller.abort();
      if (error?.status) {
        closed = true;
        if (account.enabled) window.dispatchEvent(new Event(AUTH_CHECK));
        if (autoRetry.current && !retrying.current) { autoRetry.current = false; retryTimer = setTimeout(() => setRevision(n => n + 1), QUIET_RETRY_MS); return; }
        return fail("Connection closed");
      }
      if (retrying.current) fail("Server unreachable. Still retrying automatically.");
      else if (!bannerTimer) bannerTimer = setTimeout(() => show("Reconnecting…"), RECONNECT_GRACE_MS);
      retryTimer = setTimeout(open, RECONNECT_GRACE_MS);
    };
    function open() {
      controller = new AbortController();
      let checked = false;
      // Every frame of this stream also builds the cached view, so a switch back shows the newest one.
      const view = streamViews.connect(requested);
      subscription = subscribeUiEvents(() => fetch("/api/events?" + requested, {
        headers: { Accept: "text/event-stream" }, signal: controller.signal,
      }), {
        next({ event, data }) {
          if (requested !== route.current) return;
          if (event === "problem") {
            closed = true;
            controller.abort();
            subscription.unsubscribe();
            return fail(data.error);
          }
          const next = view(event, data);
          if (!next) return;
          if (event === "state") {
            if (!checked) { checked = true; checkBuild(); }
            clearTimeout(bannerTimer); bannerTimer = 0;
            setReady(true); setLoadError(""); onReady();
            toast.dismiss(CONNECTION_TOAST);
            retrying.current = false; shown.current = false; autoRetry.current = true;
          }
          // The cached view is the one source for all three, so a reconnect keeps a surface that did not change.
          setData(next.data); setActivity(next.activity); setSurfaces(next.surfaces);
        },
        error: disconnected,
        complete: disconnected,
      });
    }
    open();
    // Phones suspend background pages and can leave a dead stream open; reconnect quietly on return.
    const resume = () => {
      if (document.visibilityState === "hidden") { hiddenAt.current = Date.now(); return; }
      const away = hiddenAt.current && Date.now() - hiddenAt.current > STALE_AFTER_MS;
      hiddenAt.current = 0;
      if (closed || away) reconnect();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", reconnect);
    return () => {
      clearTimeout(bannerTimer); clearTimeout(retryTimer); controller.abort(); subscription.unsubscribe();
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", reconnect);
    };
  }, [requested, revision]);

  return { cached, data, activity, surfaces, ready, loadError, setLoadError, setReady, restore, retry };
}
