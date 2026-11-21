import { NextResponse } from "next/server";

export const config = {
  matcher: [{
    source: "/((?!api|_next/static|_next/image|favicon.ico|sw.js).*)",
    missing: [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }],
  }],
};

// Per-request script nonce; Next.js applies it to its own inline scripts.
export function proxy(request) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const dev = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  const csp = [
    "default-src 'self'", `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev}`,
    "style-src 'self' 'unsafe-inline'", "font-src 'self' data:", "img-src 'self' data: blob:", "connect-src 'self'",
    "worker-src 'self'", "manifest-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join("; ");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}
