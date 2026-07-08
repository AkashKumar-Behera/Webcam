import { NextResponse } from "next/server";

// Generates short-lived TURN credentials server-side so the TURN API token
// never ships in the client bundle.
export async function POST() {
  const keyId = process.env.CF_TURN_KEY_ID;
  const apiToken = process.env.CF_TURN_API_TOKEN;
  if (!keyId || !apiToken) {
    return NextResponse.json({ error: "TURN not configured" }, { status: 500 });
  }

  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json"
        },
        // 6h TTL — a watch party session comfortably fits, and leaked creds expire fast
        body: JSON.stringify({ ttl: 21600 }),
        cache: "no-store"
      }
    );
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "TURN upstream unreachable" }, { status: 502 });
  }
}
