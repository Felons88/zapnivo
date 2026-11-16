import { NextResponse } from "next/server";

/**
 * Stripe Checkout lands here for native-app rentals; the page hands control back to the app via its
 * custom scheme. Only the fixed scheme + a whitelisted status are ever emitted.
 */
export function GET(req: Request) {
  const status = new URL(req.url).searchParams.get("status") === "success" ? "success" : "cancelled";
  const target = `com.zapnivo.charging://payment?status=${status}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Returning to Zapnivo</title><meta http-equiv="refresh" content="0;url=${target}"></head><body style="font-family:system-ui;background:#0b0d24;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center"><div><h1>${status === "success" ? "Payment received" : "Payment cancelled"}</h1><p>Returning you to the Zapnivo app…</p><p><a style="color:#dcff70" href="${target}">Open the app</a></p></div><script>location.href=${JSON.stringify(target)}</script></body></html>`;
  return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
