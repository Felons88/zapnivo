import { NextResponse } from "next/server";
import { DEV_COOKIE, DEV_USERS, devAuth } from "@/lib/auth";

/** DEV ONLY role switcher. 404s everywhere except `next dev` with HELPDESK_DEV_STORE=1. */
export async function GET(req: Request) {
  if (!devAuth()) return new NextResponse("Not found", { status: 404 });
  const url = new URL(req.url);
  const role = url.searchParams.get("role") ?? "admin";
  if (!(role in DEV_USERS)) return NextResponse.json({ error: "Unknown role" }, { status: 400 });
  const back = url.searchParams.get("back");
  const res = NextResponse.redirect(new URL(back && back.startsWith("/") && !back.startsWith("//") ? back : "/admin/support", url));
  res.cookies.set(DEV_COOKIE, role, { path: "/", httpOnly: true, sameSite: "lax" });
  return res;
}
