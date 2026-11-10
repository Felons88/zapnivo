import { NextResponse } from "next/server";
import { getSessionUser, isStaff } from "@/lib/auth";
import { EMAIL_TRIGGER_REGISTRY } from "@/lib/email/routing";
import type { StudioTriggerRow } from "@/lib/email-studio";

/**
 * GET /api/admin/email-studio/triggers — staff-only.
 * Read-only view of the email routing registry: which business event sends as
 * which sender/template/recipient. Triggers are NOT runtime-configurable yet.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const triggers: StudioTriggerRow[] = Object.entries(EMAIL_TRIGGER_REGISTRY)
    .map(([event, t]) => ({
      event,
      sender: typeof t?.sender === "string" ? t.sender : "",
      template: typeof t?.template === "string" ? t.template : null,
      recipientKind: typeof t?.recipientKind === "string" ? t.recipientKind : "",
      description: typeof t?.description === "string" ? t.description : "",
      status: typeof t?.status === "string" ? t.status : "unknown",
    }))
    .sort((a, b) => a.event.localeCompare(b.event));

  return NextResponse.json({
    ok: true,
    available: true,
    triggers,
    note: "Informational only — triggers are defined in code and can't be enabled or edited here yet.",
  });
}
