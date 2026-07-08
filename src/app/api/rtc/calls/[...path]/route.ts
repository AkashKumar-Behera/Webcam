import { NextRequest, NextResponse } from "next/server";

// Proxies Cloudflare Calls (SFU) session/track requests, injecting the app
// token server-side so it never ships in the client bundle.
const ALLOWED = /^sessions(\/[A-Za-z0-9_-]+)?(\/(tracks\/new|tracks\/close|renegotiate))?$|^sessions\/new$/;

async function proxy(req: NextRequest, path: string[], method: "POST" | "PUT" | "GET") {
  const appId = process.env.CF_CALLS_APP_ID;
  const appToken = process.env.CF_CALLS_APP_TOKEN;
  if (!appId || !appToken) {
    return NextResponse.json({ error: "Calls not configured" }, { status: 500 });
  }

  const subPath = path.join("/");
  if (!ALLOWED.test(subPath)) {
    return NextResponse.json({ error: "Path not allowed" }, { status: 403 });
  }

  try {
    const upstream = await fetch(
      `https://rtc.live.cloudflare.com/v1/apps/${appId}/${subPath}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${appToken}`,
          "Content-Type": "application/json"
        },
        body: method === "GET" ? undefined : await req.text(),
        cache: "no-store"
      }
    );
    const data = await upstream.text();
    return new NextResponse(data, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" }
    });
  } catch {
    return NextResponse.json({ error: "Calls upstream unreachable" }, { status: 502 });
  }
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { path } = await ctx.params;
  return proxy(req, path, "POST");
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const { path } = await ctx.params;
  return proxy(req, path, "PUT");
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { path } = await ctx.params;
  return proxy(req, path, "GET");
}
