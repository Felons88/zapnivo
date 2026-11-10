import { NextResponse } from "next/server";
import { getSessionUser, isStaff } from "@/lib/auth";
import { verifyReceipt } from "@/lib/billing";
import { buildReceiptPdf } from "@/lib/pdf";
import { serviceClient } from "@/lib/supabase";

type Row = {
  reference: string; created_at: string; returned_at: string | null;
  kiosks: { station_id: string; venues: { name: string; city: string } | null } | null;
  payments: { state: string; receipt_email: string | null; amount_captured_cents: number | null; tax_cents: number | null; discount_cents: number | null; captured_at: string | null }[];
};

const notFound = () => NextResponse.json({ error: "Receipt not found." }, { status: 404 });

/** PDF receipt. Authorized by signed token (?t=), any staff, or the signed-in customer whose email matches the receipt email. */
export async function GET(req: Request, { params }: { params: Promise<{ reference: string }> }) {
  const { reference } = await params;
  if (!/^[A-Za-z0-9-]{4,24}$/.test(reference)) return notFound();
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Receipts are not available yet." }, { status: 503 });

  const { data } = await db.from("rentals")
    .select("reference,created_at,returned_at,kiosks!rentals_kiosk_id_fkey(station_id,venues(name,city)),payments(state,receipt_email,amount_captured_cents,tax_cents,discount_cents,captured_at)")
    .eq("reference", reference).maybeSingle();
  const r = data as unknown as Row | null;
  const pay = r?.payments?.[0];
  if (!r || !pay) return notFound();

  const token = new URL(req.url).searchParams.get("t");
  let allowed = verifyReceipt(token, r.reference, pay.receipt_email);
  if (!allowed) {
    const user = await getSessionUser().catch(() => null);
    allowed = isStaff(user) || (user?.role === "customer" && !!pay.receipt_email && user.email.toLowerCase() === pay.receipt_email.toLowerCase());
  }
  if (!allowed) return notFound(); // never reveal whether the reference exists

  const captured = pay.amount_captured_cents;
  const tax = pay.tax_cents ?? 0, discount = pay.discount_cents ?? 0;
  const pdf = buildReceiptPdf({
    reference: r.reference, dateIso: pay.captured_at ?? r.returned_at ?? r.created_at,
    venue: r.kiosks?.venues ? `${r.kiosks.venues.name}, ${r.kiosks.venues.city}` : "Zapnivo station",
    station: r.kiosks?.station_id ?? "-",
    subtotalCents: captured === null ? 0 : captured + discount - tax, discountCents: discount, taxCents: tax,
    totalCents: captured, taxApplied: tax > 0, paymentState: pay.state,
  });
  return new NextResponse(new Uint8Array(pdf), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="zapnivo-receipt-${r.reference}.pdf"`, "Cache-Control": "private, no-store" },
  });
}
