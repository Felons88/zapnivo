import { NextResponse } from "next/server";
import { confirmSubscription } from "@/lib/newsletter/service";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const page = (title: string, body: string, ok: boolean) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f1f4ed;font-family:Arial,Helvetica,sans-serif;color:#172018">
<div style="max-width:440px;margin:24px;padding:40px 32px;background:#fff;border-radius:16px;text-align:center;box-shadow:0 12px 40px -18px rgba(0,0,0,.25)">
<p style="margin:0 0 8px;font-size:11px;font-weight:800;letter-spacing:2px;color:#719f0d">ZAPNIVO</p>
<h1 style="margin:0 0 12px;font-size:26px;color:#11122b">${esc(title)}</h1>
<p style="margin:0 0 24px;font-size:14px;line-height:1.7;color:#4c5560">${esc(body)}</p>
<a href="/" style="display:inline-block;background:${ok ? "#d9ff73" : "#11122b"};color:${ok ? "#11122b" : "#fff"};padding:13px 26px;border-radius:10px;font-weight:800;font-size:13px;text-decoration:none">Back to Zapnivo</a>
</div></body></html>`;

/**
 * GET /api/newsletter/confirm?token=… — completes double opt-in.
 * Idempotent: confirmed rows show "already confirmed"; invalid/burned tokens 404.
 */
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  const res = await confirmSubscription(token);
  if (!res.ok) {
    return new NextResponse(page("Link not valid", res.error, false), { status: res.status, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  const already = res.status === "already_confirmed";
  return new NextResponse(
    page(
      already ? "Already confirmed" : "You're subscribed",
      already
        ? "This address is already confirmed — nothing else to do."
        : "Your subscription is confirmed. Watch your inbox for occasional Zapnivo updates.",
      true,
    ),
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
