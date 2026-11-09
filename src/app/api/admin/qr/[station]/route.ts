import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { getSessionUser, isStaff } from "@/lib/auth";
import { SITE } from "@/lib/site";

/** Printable QR (SVG) for a station — encodes the customer rent URL for that station_id. */
export async function GET(_req: Request, { params }: { params: Promise<{ station: string }> }) {
  if (!isStaff(await getSessionUser())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { station } = await params;
  if (!/^[A-Za-z0-9-]{3,40}$/.test(station)) return NextResponse.json({ error: "Bad station id" }, { status: 400 });
  const svg = await QRCode.toString(`${SITE.url}/r/${station}`, { type: "svg", errorCorrectionLevel: "H", margin: 2, color: { dark: "#11122B", light: "#FFFFFF" } });
  return new NextResponse(svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "private, max-age=3600" } });
}
