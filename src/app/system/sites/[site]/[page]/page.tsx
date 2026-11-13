export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { catalogFields, catalogPageExists, getSiteEntry, listPageRevisions, listSiteContent } from "@/lib/system/site-cms";
import { SitePageEditor, type EditorField, type EditorRevision } from "./SitePageEditor";

export const metadata: Metadata = { title: "Website — Page editor" };

/** /system/sites/[site]/[page] — field editor + revision history for one page. */
export default async function SitePageEditorPage({ params }: { params: Promise<{ site: string; page: string }> }) {
  const { site, page } = await params;
  const entry = getSiteEntry(site);
  if (!entry || !catalogPageExists(site, page)) notFound();

  const db = serviceClient();
  const defs = catalogFields(site, page);
  const rows = db ? await listSiteContent(db, site) : [];
  const revisions = db ? await listPageRevisions(db, site, page) : [];

  const fields: EditorField[] = defs.map((d) => {
    const row = rows.find((r) => r.page_key === page && r.field_key === d.key) ?? null;
    return {
      key: d.key,
      label: d.label,
      type: d.type,
      maxLength: d.maxLength ?? null,
      format: d.format ?? null,
      help: d.help ?? null,
      row: row
        ? {
            draft_value: row.draft_value,
            published_value: row.published_value,
            status: row.status,
            scheduled_at: row.scheduled_at,
            version: row.version,
          }
        : null,
    };
  });

  const revs: EditorRevision[] = revisions.map((r) => ({
    id: r.id,
    field_key: r.field_key,
    version: r.version,
    value: r.value,
    action: r.action,
    actor: r.actor,
    created_at: r.created_at,
  }));

  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canDraft = roleCan(role, "system.flags.manage");
  const canPublish = roleCan(role, "system.deployments.manage");

  return (
    <SystemGate perm="system.dashboard.view">
      <div className="space-y-4">
        <div>
          <p className="eyebrow text-lime">
            <Link href="/system/sites" className="hover:text-white">Website</Link>
            {" / "}
            <Link href={`/system/sites/${site}`} className="hover:text-white">{entry.label}</Link>
            {" / "}{page}
          </p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">/{page}</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-400">
            Edits save as drafts first. Publishing writes the live value served by{" "}
            <code className="font-mono text-xs">getPublishedContent()</code> (60s cache) and requires
            step-up verification. Values are plain text — HTML is stripped on save.
          </p>
        </div>
        <SitePageEditor site={site} page={page} fields={fields} revisions={revs} canDraft={canDraft} canPublish={canPublish} />
      </div>
    </SystemGate>
  );
}
