import { ui } from "../../../../server/instance.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  return (await ui()).auth(request, (await params).step);
}

export async function POST(request, { params }) {
  return (await ui()).auth(request, (await params).step);
}
