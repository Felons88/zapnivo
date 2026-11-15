import { NextResponse } from "next/server";
import { getSessionUser, isStaff } from "@/lib/auth";
import {
  isActivityKind, isPlacementStage,
  moveStage, addActivity, updatePlacementMeta, saveAssessment,
} from "@/lib/placement";
import { serviceClient } from "@/lib/supabase";
import { recordLog } from "@/lib/observability";

const back = (req: Request, applicationId: string | null, result: string, detail?: string) => {
  const url = new URL(applicationId ? `/admin/placements/${applicationId}` : "/admin/placements", req.url);
  url.searchParams.set("result", result);
  if (detail) url.searchParams.set("detail", detail.slice(0, 200));
  return NextResponse.redirect(url, 303);
};

const placementsLog = (message: string, attrs?: Record<string, unknown>) =>
  recordLog("info", message, { service: "placements", route: "api/admin/placements", attrs });

/**
 * Staff placement pipeline actions: move_stage, add_note, update_meta,
 * save_assessment. Stage moves into 'approved'/'active' are admin-only —
 * same convention as partner agreement terms and payout approvals.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const form = await req.formData();
  const action = String(form.get("action") ?? "");
  const applicationId = String(form.get("application_id") ?? "") || null;

  if (action === "move_stage") {
    const to = String(form.get("stage") ?? "");
    const note = String(form.get("note") ?? "") || null;
    if (!applicationId || !isPlacementStage(to)) return back(req, applicationId, "error", "Choose a valid stage.");
    // Sensitive transitions are admin-only.
    if ((to === "approved" || to === "active") && user!.role !== "admin") {
      return back(req, applicationId, "error", "Only admins can approve or activate a placement.");
    }
    const res = await moveStage(db, user!.id, applicationId, to, note);
    if (!res.ok) return back(req, applicationId, "error", res.error);
    placementsLog("placement_stage_moved", { applicationId, to, actorRole: user!.role });
    return back(req, applicationId, "moved");
  }

  if (action === "add_note") {
    const kind = String(form.get("kind") ?? "note");
    const body = String(form.get("body") ?? "");
    if (!applicationId) return back(req, applicationId, "error", "Missing application.");
    if (!isActivityKind(kind)) return back(req, applicationId, "error", "Unknown activity kind.");
    if (!body.trim() || body.length > 4000) return back(req, applicationId, "error", "Enter a note (max 4000 characters).");
    const res = await addActivity(db, user!.id, applicationId, kind, body);
    if (!res.ok) return back(req, applicationId, "error", res.error);
    return back(req, applicationId, "note");
  }

  if (action === "update_meta") {
    if (!applicationId) return back(req, applicationId, "error", "Missing application.");
    const res = await updatePlacementMeta(db, user!.id, applicationId, {
      assigned_to: form.get("assigned_to") ? String(form.get("assigned_to")) : null,
      follow_up_at: form.get("follow_up_at") ? String(form.get("follow_up_at")) : null,
      next_action: form.get("next_action") ? String(form.get("next_action")) : null,
    });
    if (!res.ok) return back(req, applicationId, "error", res.error);
    placementsLog("placement_meta_updated", { applicationId, actorRole: user!.role });
    return back(req, applicationId, "meta");
  }

  if (action === "save_assessment") {
    if (!applicationId) return back(req, applicationId, "error", "Missing application.");
    const fields = Object.fromEntries(
      ["traffic_estimate", "electrical_availability", "floor_space", "accessibility", "indoor_outdoor",
        "product_preferences", "maintenance_access", "equipment_category", "constraints", "notes"]
        .map((f) => [f, form.get(f) ? String(form.get(f)) : null]),
    );
    const res = await saveAssessment(db, user!.id, {
      application_id: applicationId,
      venue_id: form.get("venue_id") ? String(form.get("venue_id")) : null,
      ...fields,
    });
    if (!res.ok) return back(req, applicationId, "error", res.error);
    placementsLog("placement_assessment_saved", { applicationId });
    return back(req, applicationId, "assessment");
  }

  return back(req, applicationId, "error", "Unknown placement action.");
}
