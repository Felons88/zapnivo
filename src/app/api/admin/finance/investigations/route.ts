import { NextResponse } from "next/server";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase";
import { fail, readJson, staffGate } from "@/lib/finance/http";
import { createCase, FIN_CASE_TYPES, FIN_SEVERITIES, FIN_CASE_STATUSES, listCases } from "@/lib/finance/investigations";

export const dynamic = "force-dynamic";

const UNCONFIGURED = { error: "Finance investigations aren't connected yet.", code: "backend_unconfigured" };

const createSchema = z.object({
  case_type: z.enum(FIN_CASE_TYPES).default("general"),
  subject: z.string().trim().min(3).max(300),
  description: z.string().trim().max(8000).optional().default(""),
  severity: z.enum(FIN_SEVERITIES).optional().default("normal"),
  customer_ref: z.string().trim().max(200).nullish(),
  rental_id: z.string().uuid().nullish(),
  payment_id: z.string().uuid().nullish(),
  station_id: z.string().trim().max(80).nullish(),
  claimed_amount_cents: z.number().int().min(0).max(10_000_000).nullish(),
});

/** GET /api/admin/finance/investigations?status=&case_type=&severity=&q= */
export async function GET(req: Request) {
  const gate = await staffGate(req, "fin-list", 240);
  if (gate instanceof NextResponse) return gate;
  const db = serviceClient();
  if (!db) return NextResponse.json(UNCONFIGURED, { status: 503 });
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? undefined;
  const caseType = url.searchParams.get("case_type") ?? undefined;
  const severity = url.searchParams.get("severity") ?? undefined;
  const q = url.searchParams.get("q") ?? undefined;
  if (status && !FIN_CASE_STATUSES.includes(status as never)) return fail(422, "Unknown status filter.");
  if (caseType && !FIN_CASE_TYPES.includes(caseType as never)) return fail(422, "Unknown case_type filter.");
  if (severity && !FIN_SEVERITIES.includes(severity as never)) return fail(422, "Unknown severity filter.");
  const res = await listCases(db, { status, caseType, severity, q });
  if (!res.ok) return fail(res.status, res.error);
  return NextResponse.json({ cases: res.data });
}

/** POST /api/admin/finance/investigations — staff create a case (agents may do this too; decide is human-only). */
export async function POST(req: Request) {
  const gate = await staffGate(req, "fin-create", 60);
  if (gate instanceof NextResponse) return gate;
  const db = serviceClient();
  if (!db) return NextResponse.json(UNCONFIGURED, { status: 503 });
  const parsed = createSchema.safeParse(await readJson(req));
  if (!parsed.success) return fail(422, "Invalid case payload.", { issues: parsed.error.issues.slice(0, 5).map((i) => i.message) });
  const res = await createCase(db, {
    caseType: parsed.data.case_type,
    subject: parsed.data.subject,
    description: parsed.data.description,
    severity: parsed.data.severity,
    customerRef: parsed.data.customer_ref ?? null,
    rentalId: parsed.data.rental_id ?? null,
    paymentId: parsed.data.payment_id ?? null,
    stationId: parsed.data.station_id ?? null,
    claimedAmountCents: parsed.data.claimed_amount_cents ?? null,
    createdBy: gate.id,
  });
  if (!res.ok) return fail(res.status, res.error);
  return NextResponse.json({ case: res.data }, { status: 201 });
}
