export const dynamic = "force-dynamic";

// The running server's build id, inlined at build time like the page's own.
export function GET() {
  return Response.json({ build: process.env.AI_COLLAB_BUILD }, { headers: { "Cache-Control": "no-store" } });
}
