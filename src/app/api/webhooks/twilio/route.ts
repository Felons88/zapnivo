import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { handleInboundSms } from "@/lib/sms";
import { serviceClient } from "@/lib/supabase";

/**
 * Twilio webhook — inbound SMS + delivery status callbacks.
 * Signature: X-Twilio-Signature = base64(HMAC-SHA1(auth_token, url + sorted POST params)).
 * Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER (503 until configured).
 * Inbound handling (logging, STOP/START opt-outs, auto-ack) lives in lib/sms.handleInboundSms.
 */
async function verify(url: string, params: URLSearchParams, signature: string | null): Promise<boolean> {
  if (!signature || !process.env.TWILIO_AUTH_TOKEN) return false;
  const data = url + [...params.keys()].sort().map((k) => k + params.get(k)).join("");
  const expected = createHmac("sha1", process.env.TWILIO_AUTH_TOKEN).update(data).digest("base64");
  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

const twiml = () => new NextResponse("<Response/>", { headers: { "Content-Type": "text/xml" } });

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
    // Delivery status callback — update the logged outbound message (incl. carrier error codes).
    const errCode = params.get("ErrorCode");
    await db.from("sms_messages").update({
      status,
      ...(errCode ? { error_code: errCode, error_message: (params.get("ErrorMessage") ?? "").slice(0, 300) || null } : {}),
    }).eq("provider_sid", sid);
    return twiml();
  }

  // Inbound message — log it, apply STOP/START, auto-ack once (staff see it in /admin/sms).
  const numMedia = params.get("NumMedia");
  await handleInboundSms(db, {
    from, to, body, sid: sid || null,
    hasMedia: !!numMedia && numMedia !== "0",
  });
  return twiml();
}
