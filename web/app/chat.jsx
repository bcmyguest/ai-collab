"use client";
// Entry point: the sign-in gate over the console. The console itself lives in chat-console.jsx;
// its parts in chat-sidebar/-message/-composer/-stream/-shared, and the network layer in chat-api.js.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { AUTH_CHECK } from "./chat-api";
import { Console } from "./chat-console";

// With GitHub sign-in on, a signed-out visitor sees only the sign-in button; a 401 or closed stream checks again.
export default function Chat() {
  const [account, setAccount] = useState(null);
  useEffect(() => {
    let live = true;
    const check = () => fetch("/api/auth/me", { cache: "no-store" }).then(response => response.json())
      .then(result => { if (live) setAccount(result); }, () => { if (live) setAccount(current => current || { enabled: false, user: null }); });
    check();
    window.addEventListener(AUTH_CHECK, check);
    return () => { live = false; window.removeEventListener(AUTH_CHECK, check); };
  }, []);
  if (!account) return null;
  if (account.enabled && !account.user) return <SignIn/>;
  return <Console account={account}/>;
}

function SignIn() {
  return <main className="flex h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
    <h1 className="text-xl font-semibold">AI Collab</h1>
    <p className="text-sm text-muted-foreground">Sign in to message your agents.</p>
    <Button asChild className="rounded-md"><a href="/api/auth/login">Sign in with GitHub</a></Button>
  </main>;
}
