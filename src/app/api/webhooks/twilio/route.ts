import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import { sendSms } from "@/lib/sms";
import { serviceClient } from "@/lib/supabase";

/**
 * Twilio webhook — inbound SMS + delivery status callbacks.
 * Signature: X-Twilio-Signature = base64(HMAC-SHA1(auth_token, url + sorted POST params)).
 * Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER (503 until configured).
 */
async function verify(url: string, params: URLSearchParams, signature: string | null): Promise<boolean> {
  if (!signature || !process.env.TWILIO_AUTH_TOKEN) return false;
  const data = url + [...params.keys()].sort().map((k) => k + params.get(k)).join("");
  const expected = createHmac("sha1", process.env.TWILIO_AUTH_TOKEN).update(data).digest("base64");
  return expected.length === signature.length && expected === signature;
}

export async function POST(req: Request) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    return NextResponse.json({ error: "SMS not configured" }, { status: 503 });
  }
  const params = new URLSearchParams(await req.text());
  if (!(await verify(req.url, params, req.headers.get("x-twilio-signature")))) {
    return NextResponse.json({ error: "Bad signature" }, { status: 403 });
  }
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const sid = params.get("MessageSid") ?? params.get("SmsSid") ?? "";
  const status = params.get("MessageStatus") ?? params.get("SmsStatus");
  const from = params.get("From") ?? "";
  const to = params.get("To") ?? "";
  const body = params.get("Body") ?? "";

  if (status) {
    // Delivery status callback — update the logged outbound message.
    await db.from("sms_messages").update({ status }).eq("provider_sid", sid);
    return new NextResponse("<Response/>", { headers: { "Content-Type": "text/xml" } });
  }

  // Inbound message — log it and auto-ack once. Staff see it in /admin/sms.
  await db.from("sms_messages").insert({ direction: "inbound", from_number: from, to_number: to, body, status: "received", provider_sid: sid || null });
  if (!params.get("NumMedia") || params.get("NumMedia") === "0") {
    await sendSms(db, { to: from, body: "Zapnivo: thanks for your message — the team has it. For faster help, open a request at support.zapnivo.com/new" });
  }
  return new NextResponse("<Response/>", { headers: { "Content-Type": "text/xml" } });
}
