import { NextResponse } from "next/server";
import { runRentalSweep } from "@/lib/email-triggers";

/** Vercel cron — daily rental sweep: deadline reminders + non-return notices. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const out = await runRentalSweep();
  return NextResponse.json({ ok: true, ...out });
}
