import { ui } from "../../../../server/instance.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  return (await ui()).file((await params).name, request);
}
