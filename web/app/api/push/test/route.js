import { ui } from "../../../../server/instance.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  return (await ui()).push(request, "test");
}
