import { NextResponse } from "next/server";
import { unsubscribeSubscription } from "@/lib/newsletter/service";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const shell = (inner: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Newsletter preferences</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f1f4ed;font-family:Arial,Helvetica,sans-serif;color:#172018">
<div style="max-width:440px;margin:24px;padding:40px 32px;background:#fff;border-radius:16px;text-align:center;box-shadow:0 12px 40px -18px rgba(0,0,0,.25)">${inner}</div></body></html>`;

const tokenOf = (req: Request) => new URL(req.url).searchParams.get("token") ?? "";

/**
 * GET /api/newsletter/unsubscribe?token=… — shows a confirmation button instead of
 * mutating on GET, so email-scanner link prefetches can't unsubscribe anyone.
 * The actual opt-out happens on POST (one click).
 */
export async function GET(req: Request) {
  const token = tokenOf(req);
  if (token.length < 20 || token.length > 200) {
    return new NextResponse(shell(`<h1 style="margin:0 0 12px;font-size:24px;color:#11122b">Invalid link</h1><p style="margin:0;font-size:14px;color:#4c5560">This unsubscribe link is missing or malformed.</p>`), { status: 400, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  const inner = `<p style="margin:0 0 8px;font-size:11px;font-weight:800;letter-spacing:2px;color:#719f0d">ZAPNIVO</p>
<h1 style="margin:0 0 12px;font-size:24px;color:#11122b">Unsubscribe?</h1>
<p style="margin:0 0 24px;font-size:14px;line-height:1.7;color:#4c5560">Stop Zapnivo newsletter emails to this address. You can subscribe again anytime.</p>
<form method="post" action="/api/newsletter/unsubscribe?token=${encodeURIComponent(token)}">
<button type="submit" style="background:#11122b;color:#fff;border:0;padding:13px 30px;border-radius:10px;font-weight:800;font-size:13px;cursor:pointer">Unsubscribe</button>
</form>`;
  return new NextResponse(shell(inner), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

/** POST — performs the opt-out (token-authenticated, no login). Idempotent. */
export async function POST(req: Request) {
  const res = await unsubscribeSubscription(tokenOf(req));
  if (!res.ok) {
    return new NextResponse(shell(`<h1 style="margin:0 0 12px;font-size:24px;color:#11122b">Couldn't unsubscribe</h1><p style="margin:0;font-size:14px;color:#4c5560">${esc(res.error)}</p>`), { status: res.status, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  return new NextResponse(shell(`<p style="margin:0 0 8px;font-size:11px;font-weight:800;letter-spacing:2px;color:#719f0d">ZAPNIVO</p>
<h1 style="margin:0 0 12px;font-size:24px;color:#11122b">You're unsubscribed</h1>
<p style="margin:0 0 24px;font-size:14px;line-height:1.7;color:#4c5560">You won't receive more Zapnivo newsletter emails. Changed your mind? You can subscribe again anytime.</p>
<a href="/" style="display:inline-block;background:#d9ff73;color:#11122b;padding:13px 30px;border-radius:10px;font-weight:800;font-size:13px;text-decoration:none">Back to Zapnivo</a>`), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}
