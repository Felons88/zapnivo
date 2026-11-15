import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit";
import { getSessionUser } from "@/lib/auth";
import { sameOrigin } from "@/lib/helpdesk/http";
import { limit } from "@/lib/helpdesk/http";
import { recordLog } from "@/lib/observability";
import { serviceClient } from "@/lib/supabase";
import { createServiceRequestForOrg, listOrgServiceRequests, SERVICE_REQUEST_CATEGORIES, SERVICE_REQUEST_PRIORITIES } from "@/lib/vending-ops";
import { looksLikeCardNumber } from "@/lib/validation";

const back = (req: Request, result: string, detail?: string) => {
  const url = new URL("/partners/equipment", req.url);
  url.searchParams.set("result", result);
  if (detail) url.searchParams.set("detail", detail);
  return NextResponse.redirect(url, 303);
};

const schema = z.object({
  venue_id: z.string().uuid(),
  unit_id: z.string().uuid().optional().or(z.literal("")),
  category: z.enum(SERVICE_REQUEST_CATEGORIES),
  description: z.string().trim().min(10).max(3000),
  priority: z.enum(SERVICE_REQUEST_PRIORITIES).optional(),
});

/**
 * Partner-filed equipment service requests. The org comes from the session —
 * never the request body — and the venue must belong to that org (enforced in
 * createServiceRequestForOrg; RLS is the second layer).
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  const user = await getSessionUser();
  if (!user || user.role !== "partner" || !user.organizationId) {
    return NextResponse.json({ error: "Partner sign-in required." }, { status: 403 });
  }
  if (!limit(`svc-req:${user.id}`, 10, 10 * 60_000).ok) return NextResponse.json({ error: "Too many requests. Please wait a few minutes." }, { status: 429 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const form = await req.formData();
  const parsed = schema.safeParse({
    venue_id: form.get("venue_id"),
    unit_id: form.get("unit_id") || undefined,
    category: form.get("category"),
    description: form.get("description"),
    priority: form.get("priority") || undefined,
  });
  if (!parsed.success) return back(req, "error", "Check the request fields (description needs at least 10 characters).");
  if (looksLikeCardNumber(parsed.data.description)) return back(req, "error", "Please remove anything that looks like a payment card number.");

  const res = await createServiceRequestForOrg(db, user.organizationId, user.id, {
    venue_id: parsed.data.venue_id,
    unit_id: parsed.data.unit_id || null,
    category: parsed.data.category,
    description: parsed.data.description,
    priority: parsed.data.priority ?? "normal",
  });
  if (!res.ok) return back(req, "error", res.error);

  await auditLog(user.id, "service_request_created", "service_request", res.request.id, {
    venue_id: res.request.venue_id, category: res.request.category, priority: res.request.priority, organization_id: user.organizationId,
  });
  recordLog("info", "partner_service_request", { service: "vending", route: "partners/service-requests", attrs: { requestId: res.request.id, venueId: res.request.venue_id, priority: res.request.priority } });
  return back(req, "created");
}

/** GET: the caller org's own service requests (JSON). */
export async function GET() {
  const user = await getSessionUser();
  if (!user || user.role !== "partner" || !user.organizationId) {
    return NextResponse.json({ error: "Partner sign-in required." }, { status: 403 });
  }
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const requests = await listOrgServiceRequests(db, user.organizationId);
  return NextResponse.json({ requests });
}
