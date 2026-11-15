export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { getSessionUser, isStaff } from "@/lib/auth";
import { EQUIPMENT_LABELS, equipmentLabelOr } from "@/lib/equipment";
import {
  ASSESSMENT_EQUIPMENT_CATEGORIES, ASSESSMENT_FIELDS, STAGE_LABELS,
  legalMoves, loadActivities, loadAssessment, isPlacementStage,
  type ActivityKind, type VenueAssessment,
} from "@/lib/placement";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Placement", robots: { index: false, follow: false } };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
const input = "min-h-10 w-full rounded-lg border border-silver/70 bg-white px-3 text-sm";
const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = { note: "Note", stage_change: "Stage change", call: "Call", email: "Email", meeting: "Meeting", document: "Document" };

type App = {
  id: string; business_name: string; contact_name: string; email: string; phone: string | null;
  venue_type: string; street: string; city: string; state: string; hours: string | null;
  guest_traffic: string | null; install_location: string | null; questions: string | null;
  product_interest: string | null; space_notes: string | null; timeline: string | null;
  status: string; placement_stage: string | null; assigned_to: string | null;
  follow_up_at: string | null; next_action: string | null; created_at: string;
};

const ASSESSMENT_LABELS: Record<(typeof ASSESSMENT_FIELDS)[number], string> = {
  traffic_estimate: "Traffic estimate",
  electrical_availability: "Electrical availability",
  floor_space: "Floor space",
  accessibility: "Accessibility",
  indoor_outdoor: "Indoor / outdoor",
  product_preferences: "Product preferences",
  maintenance_access: "Maintenance access",
  equipment_category: "Recommended equipment",
  constraints: "Constraints",
  notes: "Notes",
};

export default async function PlacementDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ result?: string; detail?: string }> }) {
  const { id } = await params;
  const fb = await searchParams;
  const viewer = await getSessionUser();
  if (!viewer) redirect("/login");
  if (!isStaff(viewer)) redirect("/partners");
  const isAdmin = viewer.role === "admin";
  const db = serviceClient();
  if (!db) return <AdminGate title="Placement" nav="placements"><EmptyCard title="Placement data not connected">Connect Supabase.</EmptyCard></AdminGate>;

  const { data: appRow } = await db.from("partner_applications").select("*").eq("id", id).maybeSingle();
  if (!appRow) notFound();
  const app = appRow as unknown as App;
  const stage: import("@/lib/placement").PlacementStage = isPlacementStage(app.placement_stage) ? app.placement_stage : "inquiry";

  const [activities, assessment, staffRes, venuesRes] = await Promise.all([
    loadActivities(db, app.id),
    loadAssessment(db, app.id),
    db.from("profiles").select("id,full_name,email").in("role", ["admin", "staff"]).order("email").limit(200),
    db.from("venues").select("id,name,city,state").order("name").limit(200),
  ]);
  const staff = (staffRes.data ?? []) as { id: string; full_name: string | null; email: string }[];
  const venues = (venuesRes.data ?? []) as { id: string; name: string; city: string; state: string }[];
  const moves = legalMoves(stage).filter((to) => isAdmin || (to !== "approved" && to !== "active"));
  const assignee = staff.find((s) => s.id === app.assigned_to);

  const msg = fb.result === "error" ? (fb.detail || "Something went wrong.")
    : fb.result === "moved" ? "Stage updated."
    : fb.result === "note" ? "Activity saved."
    : fb.result === "meta" ? "Placement details saved."
    : fb.result === "assessment" ? "Assessment saved." : null;

  return (
    <AdminGate title={app.business_name} nav="placements">
      <div className="space-y-6">
        <Link href="/admin/placements" className="text-sm font-bold underline underline-offset-4">← All placements</Link>
        {msg && <div role="status" className={`rounded-xl px-5 py-3 text-sm font-bold ${fb.result === "error" ? "bg-red-100 text-red-900" : "bg-lime text-ink"}`}>{msg}</div>}

        <div className="grid gap-6 lg:grid-cols-3">
          {/* ── Pipeline controls ── */}
          <section className="space-y-4 lg:col-span-1">
            <div className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-lg font-bold">Stage</h2>
                <Pill tone={stage === "declined" ? "red" : stage === "active" || stage === "installed" ? "ink" : "lime"}>{STAGE_LABELS[stage]}</Pill>
              </div>
              <p className="mt-1 text-xs text-graphite">Legacy status: <b>{app.status}</b> · applied {when(app.created_at)}</p>
              {moves.length === 0 ? (
                <p className="mt-4 text-sm text-graphite">{stage === "active" ? "Active placements are live partner relationships — no pipeline moves." : stage === "declined" ? "Declined applications can only reopen to Inquiry." : "No legal moves from this stage."}</p>
              ) : (
                <div className="mt-4 space-y-2">
                  {moves.map((to) => {
                    const sensitive = to === "approved" || to === "active";
                    const disabled = sensitive && !isAdmin;
                    return (
                      <form key={to} method="post" action="/api/admin/placements" className="flex items-center gap-2">
                        <input type="hidden" name="action" value="move_stage" />
                        <input type="hidden" name="application_id" value={app.id} />
                        <input type="hidden" name="stage" value={to} />
                        <input name="note" maxLength={500} placeholder={`Note (optional) → ${STAGE_LABELS[to]}`} className={`${input} flex-1`} />
                        <button disabled={disabled} title={disabled ? "Admins only" : undefined} className="min-h-10 shrink-0 rounded-full bg-ink px-4 text-xs font-bold text-white disabled:cursor-not-allowed disabled:bg-mist disabled:text-graphite">
                          {STAGE_LABELS[to]}{sensitive ? " · admin" : ""}
                        </button>
                      </form>
                    );
                  })}
                  {!isAdmin && <p className="text-[11px] text-graphite">Approve/activate moves are admin-only.</p>}
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <h2 className="font-display text-lg font-bold">Assignment &amp; follow-up</h2>
              <form method="post" action="/api/admin/placements" className="mt-4 space-y-3">
                <input type="hidden" name="action" value="update_meta" />
                <input type="hidden" name="application_id" value={app.id} />
                <div>
                  <label htmlFor="m-assignee" className="mb-1 block text-xs font-bold">Assignee</label>
                  <select id="m-assignee" name="assigned_to" defaultValue={app.assigned_to ?? ""} className={input}>
                    <option value="">Unassigned</option>
                    {staff.map((s) => <option key={s.id} value={s.id}>{s.full_name?.trim() || s.email}{s.full_name ? ` · ${s.email}` : ""}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="m-follow" className="mb-1 block text-xs font-bold">Follow-up at</label>
                  <input id="m-follow" name="follow_up_at" type="datetime-local" defaultValue={app.follow_up_at ? app.follow_up_at.slice(0, 16) : ""} className={input} />
                </div>
                <div>
                  <label htmlFor="m-next" className="mb-1 block text-xs font-bold">Next action</label>
                  <input id="m-next" name="next_action" maxLength={500} defaultValue={app.next_action ?? ""} placeholder="e.g. Send proposal draft" className={input} />
                </div>
                <button className="min-h-10 w-full rounded-full bg-ink px-5 text-sm font-bold text-white">Save details</button>
              </form>
            </div>
          </section>

          {/* ── Application info ── */}
          <section className="space-y-4 lg:col-span-2">
            <div className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <h2 className="font-display text-lg font-bold">Application</h2>
              <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                {([
                  ["Contact", `${app.contact_name} · ${app.email}${app.phone ? ` · ${app.phone}` : ""}`],
                  ["Venue", app.venue_type],
                  ["Address", `${app.street}, ${app.city}, ${app.state}`],
                  ["Hours", app.hours],
                  ["Guest traffic", app.guest_traffic],
                  ["Install location", app.install_location],
                  ["Product interest", app.product_interest],
                  ["Timeline", app.timeline],
                ] as [string, string | null][]).map(([k, v]) => v ? (
                  <div key={k}><dt className="text-xs font-extrabold uppercase tracking-wider text-graphite">{k}</dt><dd className="mt-0.5 font-semibold">{v}</dd></div>
                ) : null)}
              </dl>
              {(app.space_notes || app.questions) && (
                <div className="mt-4 space-y-2 rounded-xl bg-mist/50 p-4 text-sm">
                  {app.space_notes && <p><b>Space:</b> {app.space_notes}</p>}
                  {app.questions && <p><b>Questions:</b> {app.questions}</p>}
                </div>
              )}
              <p className="mt-3 text-xs text-graphite">Assignee: {assignee ? (assignee.full_name?.trim() || assignee.email) : "unassigned"} · Follow-up: {app.follow_up_at ? when(app.follow_up_at) : "none"} · Next: {app.next_action ?? "—"}</p>
            </div>

            {/* ── Assessment ── */}
            <div className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <h2 className="font-display text-lg font-bold">Venue assessment <span className="ml-2 align-middle text-[10px] font-extrabold uppercase tracking-widest text-silver">informational · never auto-approves</span></h2>
              {assessment && (
                <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                  {ASSESSMENT_FIELDS.filter((f) => (assessment as VenueAssessment)[f]).map((f) => (
                    <div key={f} className={f === "notes" || f === "constraints" ? "sm:col-span-2" : ""}>
                      <dt className="text-xs font-extrabold uppercase tracking-wider text-graphite">{ASSESSMENT_LABELS[f]}</dt>
                      <dd className="mt-0.5 font-semibold">{f === "equipment_category" ? equipmentLabelOr((assessment as VenueAssessment)[f], "unclassified") : (assessment as VenueAssessment)[f]}</dd>
                    </div>
                  ))}
                  <p className="text-xs text-graphite sm:col-span-2">Assessed {when(assessment.assessed_at)}{assessment.venue_id ? ` · venue ${assessment.venue_id.slice(0, 8)}…` : ""}</p>
                </dl>
              )}
              <form method="post" action="/api/admin/placements" className="mt-4 grid gap-3 sm:grid-cols-2">
                <input type="hidden" name="action" value="save_assessment" />
                <input type="hidden" name="application_id" value={app.id} />
                <div className="sm:col-span-2">
                  <label htmlFor="a-venue" className="mb-1 block text-xs font-bold">Linked venue (optional)</label>
                  <select id="a-venue" name="venue_id" defaultValue={assessment?.venue_id ?? ""} className={input}>
                    <option value="">— none —</option>
                    {venues.map((v) => <option key={v.id} value={v.id}>{v.name} · {v.city}, {v.state}</option>)}
                  </select>
                </div>
                {ASSESSMENT_FIELDS.filter((f) => f !== "equipment_category").map((f) => (
                  <div key={f} className={f === "notes" || f === "constraints" ? "sm:col-span-2" : ""}>
                    <label htmlFor={`a-${f}`} className="mb-1 block text-xs font-bold">{ASSESSMENT_LABELS[f]}</label>
                    <input id={`a-${f}`} name={f} maxLength={1000} defaultValue={(assessment as VenueAssessment | null)?.[f] ?? ""} className={input} />
                  </div>
                ))}
                <div>
                  <label htmlFor="a-equipment_category" className="mb-1 block text-xs font-bold">{ASSESSMENT_LABELS.equipment_category}</label>
                  <select id="a-equipment_category" name="equipment_category" defaultValue={(assessment as VenueAssessment | null)?.equipment_category ?? ""} className={input}>
                    <option value="">— undecided —</option>
                    {ASSESSMENT_EQUIPMENT_CATEGORIES.map((c) => <option key={c} value={c}>{EQUIPMENT_LABELS[c as keyof typeof EQUIPMENT_LABELS] ?? c}</option>)}
                  </select>
                </div>
                <div className="flex items-end">
                  <button className="min-h-10 w-full rounded-full bg-ink px-5 text-sm font-bold text-white">{assessment ? "Update assessment" : "Save assessment"}</button>
                </div>
              </form>
            </div>

            {/* ── Activity timeline ── */}
            <div className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <h2 className="font-display text-lg font-bold">Activity</h2>
              <form method="post" action="/api/admin/placements" className="mt-4 flex flex-wrap items-center gap-2">
                <input type="hidden" name="action" value="add_note" />
                <input type="hidden" name="application_id" value={app.id} />
                <select name="kind" aria-label="Activity kind" className="min-h-10 rounded-lg border border-silver/70 bg-white px-3 text-sm">
                  {(Object.keys(ACTIVITY_KIND_LABELS) as ActivityKind[]).map((k) => <option key={k} value={k}>{ACTIVITY_KIND_LABELS[k]}</option>)}
                </select>
                <input name="body" required maxLength={4000} placeholder="Log a call, email, meeting or note…" className="min-h-10 min-w-56 flex-1 rounded-lg border border-silver/70 bg-white px-3 text-sm" />
                <button className="min-h-10 rounded-full bg-ink px-4 text-xs font-bold text-white">Add</button>
              </form>
              <ol className="mt-5 space-y-3">
                {activities.length === 0 && <li className="text-sm text-graphite">No activity yet.</li>}
                {activities.map((a) => (
                  <li key={a.id} className="border-l-2 border-mist pl-4">
                    <p className="text-xs font-extrabold uppercase tracking-wider text-graphite">{ACTIVITY_KIND_LABELS[a.kind] ?? a.kind} · {when(a.created_at)} · {(Array.isArray(a.profiles) ? a.profiles[0] : a.profiles)?.email ?? "staff"}</p>
                    <p className="mt-0.5 whitespace-pre-line text-sm">{a.body}</p>
                  </li>
                ))}
              </ol>
            </div>
          </section>
        </div>
      </div>
    </AdminGate>
  );
}
