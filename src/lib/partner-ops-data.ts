import type { SupabaseClient } from "@supabase/supabase-js";
import { derivePipeline } from "./partner-ops";

export type OrgOnboarding = {
  id: string; name: string;
  pipeline: ReturnType<typeof derivePipeline>;
  steps: Record<string, string>; // step -> completed_at
  docs: { id: string; kind: string; status: string; note: string | null; storage_path: string | null; requested_at: string; received_at: string | null }[];
};

/** Server-only loader (service client). Pass orgId to scope to one organization. */
export async function loadOnboarding(db: SupabaseClient, orgId?: string): Promise<OrgOnboarding[]> {
  const orgQ = db.from("organizations").select("id,name").order("name").limit(200);
  const { data: orgs } = orgId ? await orgQ.eq("id", orgId) : await orgQ;
  const list = (orgs ?? []) as { id: string; name: string }[];
  if (!list.length) return [];
  const ids = list.map((o) => o.id);
  const [apps, agreements, venues, steps, docs] = await Promise.all([
    db.from("partner_applications").select("business_name,status").in("status", ["approved", "installed"]).limit(1000),
    db.from("partner_agreements").select("organization_id").in("organization_id", ids).limit(2000),
    db.from("venues").select("id,organization_id,published,kiosks(installed_at)").in("organization_id", ids).limit(2000),
    db.from("partner_onboarding_steps").select("organization_id,step,completed_at").in("organization_id", ids),
    db.from("partner_document_requests").select("id,organization_id,kind,status,note,storage_path,requested_at,received_at").in("organization_id", ids).order("requested_at", { ascending: false }).limit(1000),
  ]);
  type V = { organization_id: string; published: boolean; kiosks: { installed_at: string | null }[] | null };
  return list.map((o) => {
    const vs = ((venues.data ?? []) as unknown as V[]).filter((v) => v.organization_id === o.id);
    return {
      id: o.id, name: o.name,
      pipeline: derivePipeline({
        orgName: o.name,
        applications: (apps.data ?? []) as { business_name: string; status: string }[],
        agreementCount: ((agreements.data ?? []) as { organization_id: string }[]).filter((a) => a.organization_id === o.id).length,
        venues: vs.map((v) => ({ published: v.published })),
        kiosks: vs.flatMap((v) => v.kiosks ?? []),
      }),
      steps: Object.fromEntries(((steps.data ?? []) as { organization_id: string; step: string; completed_at: string }[]).filter((s) => s.organization_id === o.id).map((s) => [s.step, s.completed_at])),
      docs: ((docs.data ?? []) as (OrgOnboarding["docs"][number] & { organization_id: string })[]).filter((d) => d.organization_id === o.id),
    };
  });
}
