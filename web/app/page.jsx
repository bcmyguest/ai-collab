"use client";
import dynamic from "next/dynamic";

// The chat reads location.hash and the DOM, so it renders only in the browser.
const Chat = dynamic(() => import("./chat.jsx"), { ssr: false });

export default function Page() {
  return <Chat/>;
}
