import { ui } from "../../../server/instance.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  return (await ui()).land(request);
}

export async function POST(request) {
  return (await ui()).handle(request, "land");
}
