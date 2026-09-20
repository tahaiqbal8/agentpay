/**
 * Same-origin proxy to the AgentPay gateway.
 *
 * Runs server-side, so the browser never talks to the gateway directly and the
 * gateway needs no CORS headers loosened for a dashboard to exist. The gateway
 * URL stays server-only; it is never shipped to the client.
 */
import { NextRequest, NextResponse } from "next/server";

const GATEWAY = process.env.AGENTPAY_GATEWAY_URL ?? "http://127.0.0.1:8080";

/**
 * The control-plane admin token.
 *
 * Read here, in a server-only route handler, and attached to the outgoing
 * request. It is never sent to the browser and never appears in a client
 * bundle — which is the whole reason the console talks to the gateway through
 * this proxy rather than directly.
 *
 * Note the name: no `NEXT_PUBLIC_` prefix, so Next will not inline it into
 * client code even by accident.
 */
const ADMIN_TOKEN = process.env.AGENTPAY_ADMIN_TOKEN?.trim();

async function proxy(req: NextRequest, path: string[]) {
  const target = `${GATEWAY}/${path.join("/")}`;
  try {
    const res = await fetch(target, {
      method: req.method,
      headers: {
        "content-type": "application/json",
        ...(ADMIN_TOKEN ? { authorization: `Bearer ${ADMIN_TOKEN}` } : {}),
      },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.text(),
      cache: "no-store",
    });
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch {
    // 502 rather than 500: the dashboard is fine, the upstream is not, and the
    // client distinguishes "gateway down" from "gateway said no".
    return NextResponse.json(
      {
        reason_code: "ERR_GATEWAY_UNREACHABLE",
        message: "Could not reach the AgentPay gateway.",
        request_id: "-",
      },
      { status: 502 }
    );
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await ctx.params).path);
}
export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await ctx.params).path);
}
// The registry's remove button uses DELETE; without this it got a 405 from
// Next rather than ever reaching the gateway.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await ctx.params).path);
}
