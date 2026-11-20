export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { Pill } from "@/components/SupportNav";
import { getSessionUser } from "@/lib/auth";
import { NOTIFY_TEMPLATES, NOTIFY_VARS, type NotifyTemplate } from "@/lib/notify";
import { serviceClient } from "@/lib/supabase";
import { NotificationTemplateEditor } from "./TemplateEditor";

export const metadata: Metadata = { title: "Notifications", robots: { index: false, follow: false } };

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const TONE: Record<string, "mist" | "lime" | "gold" | "red" | "ink" | "cyan"> = { sent: "lime", failed: "red", skipped: "mist", deferred: "gold", queued: "cyan", done: "lime", dead: "red", in_app: "mist", push: "cyan", email: "gold", sms: "lime" };

export default async function NotificationsAdmin({ searchParams }: { searchParams: Promise<{ result?: string; detail?: string; email?: string }> }) {
  const sp = await searchParams;
  const user = await getSessionUser();
  const isAdmin = user?.role === "admin";
  const db = serviceClient();
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();

  const [tplRes, delivRes, evRes] = db ? await Promise.all([
    db.from("notification_templates").select("kind,category,title,body,channels,essential,enabled"),
    db.from("notification_deliveries").select("id,notification_id,channel,status,detail,created_at").order("created_at", { ascending: false }).limit(60),
    db.from("notification_events").select("id,status,kind,profile_id,actor,attempts,last_error,due_at,created_at").in("status", ["queued", "failed", "dead"]).order("id", { ascending: false }).limit(60),
  ]) : [{ data: null }, { data: null }, { data: null }];
  let history: { id: string; category: string; kind: string; title: string; body: string; read_at: string | null; created_at: string }[] = [];
  let historyOwner: string | null = null;
  if (db && sp.email) {
    const { data: prof } = await db.from("profiles").select("id,email").ilike("email", sp.email.trim()).maybeSingle();
    const pid = (prof as { id: string; email: string } | null)?.id;
    if (pid) {
      historyOwner = (prof as { email: string }).email;
      const { data } = await db.from("notifications").select("id,category,kind,title,body,read_at,created_at").eq("profile_id", pid).order("created_at", { ascending: false }).limit(50);
      history = (data ?? []) as typeof history;
    }
  }

  const overrides = new Map(((tplRes?.data ?? []) as (NotifyTemplate & { kind: string; enabled: boolean })[]).map((t) => [t.kind, t]));
  const catalog = Object.entries(NOTIFY_TEMPLATES).map(([kind, base]) => {
    const o = overrides.get(kind);
    return { kind, title: o?.title ?? base.title, body: o?.body ?? base.body, category: base.category, channels: base.channels, essential: base.essential, enabled: o ? o.enabled : true, overridden: Boolean(o) };
  });

  const deliveries = (delivRes?.data ?? []) as { id: number; notification_id: string; channel: string; status: string; detail: string | null; created_at: string }[];
  const events = (evRes?.data ?? []) as { id: number; status: string; kind: string; actor: string | null; attempts: number; last_error: string | null; due_at: string; created_at: string }[];
  const stats = {
    sent7d: deliveries.filter((d) => d.status === "sent" && d.created_at >= weekAgo).length,
    failed7d: deliveries.filter((d) => d.status === "failed" && d.created_at >= weekAgo).length,
    queued: events.filter((e) => e.status === "queued").length,
    failed: events.filter((e) => e.status !== "queued").length,
  };

  return (
    <AdminGate title="Notifications" nav="notifications">
      {sp.result && <p className={`mb-4 rounded-xl px-4 py-2.5 text-sm font-bold ${sp.result === "ok" ? "bg-[#635bff] text-white" : "bg-red-100 text-red-800"}`}>{sp.detail ?? sp.result}</p>}

      {/* ── Analytics strip ── */}
      <div className="mb-6 grid gap-4 sm:grid-cols-4">
        {([
          ["Delivered (shown)", stats.sent7d, "channels that reported sent in the recent log"],
          ["Failed deliveries", stats.failed7d, "push/email/sms attempts that errored"],
          ["Events queued", stats.queued, "outbox rows waiting on the sweep"],
          ["Failed / dead events", stats.failed, "exhausted retries — requeue below"],
        ] as const).map(([label, n, help]) => (
          <div key={label} className="rounded-2xl border border-[#e3e8ee] bg-white p-5 shadow-sm">
            <p className="text-[11px] font-extrabold uppercase tracking-wider text-graphite">{label}</p>
            <p className="mt-1 font-display text-2xl font-extrabold">{n}</p>
            <p className="mt-1 text-[11px] text-graphite">{help}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── Event catalog + template editor ── */}
        <section className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
          <h2 className="font-display text-lg font-bold">Event catalog &amp; templates</h2>
          <p className="mt-1 text-xs text-graphite">
            Allowed variables: <code className="text-[10px]">{[...NOTIFY_VARS].join(" ")}</code>.
            Essential kinds can't be disabled and are never gated by customer preferences.
            In-app rows always record — channels listed decide push/email fan-out.
          </p>
          <div className="mt-4 max-h-[46rem] space-y-3 overflow-y-auto pr-1">
            {catalog.map((t) => (
              isAdmin
                ? <NotificationTemplateEditor key={t.kind} kind={t.kind} title={t.title} body={t.body} category={t.category} channels={t.channels} essential={t.essential} enabled={t.enabled} overridden={t.overridden} />
                : (
                  <div key={t.kind} className="rounded-xl border border-[#e3e8ee]/80 bg-paper/60 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[11px] font-extrabold uppercase tracking-wider text-silver">{t.kind.replace(/_/g, " ")}</p>
                      <span className="rounded-full bg-[#eef1f5] px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-graphite">{t.category}</span>
                      {t.essential && <span className="rounded-full bg-forest/15 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-forest">essential</span>}
                      <span className="ml-auto text-[10px] font-bold uppercase tracking-wider text-graphite">{t.channels.join(" · ")}</span>
                    </div>
                    <p className="mt-2 text-xs font-bold">{t.title}</p>
                    <p className="mt-0.5 text-xs text-graphite">{t.body}</p>
                  </div>
                )
            ))}
          </div>
        </section>

        <div className="space-y-4">
          {/* ── Test + campaign (admin only) ── */}
          {isAdmin && (
            <section className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
              <h2 className="font-display text-lg font-bold">Test send</h2>
              <form method="post" action="/api/admin/notifications" className="mt-3 space-y-2">
                <input type="hidden" name="action" value="test_send" />
                <div className="grid gap-2 sm:grid-cols-2">
                  <select name="kind" className="min-h-10 rounded-lg border border-silver/70 px-3 text-sm">
                    {catalog.map((t) => <option key={t.kind} value={t.kind}>{t.kind}</option>)}
                  </select>
                  <input name="email" required placeholder="customer@email.com" className="min-h-10 rounded-lg border border-silver/70 px-3 text-sm" />
                </div>
                <input name="vars" placeholder='Template vars as JSON — {"amount":"$5.00","rental_ref":"ZR-ABC123"}' className="min-h-10 w-full rounded-lg border border-silver/70 px-3 font-mono text-xs" />
                <button className="min-h-10 rounded-full bg-[#0a2540] px-5 text-sm font-bold text-white">Send test</button>
              </form>

              <h2 className="mt-4 font-display text-lg font-bold">Campaign</h2>
              <p className="mt-1 text-xs text-graphite">Broadcasts an optional notification to every customer who hasn't opted out of that category. Deliveries respect each person's preferences and quiet hours.</p>
              <form method="post" action="/api/admin/notifications" className="mt-3 space-y-2">
                <input type="hidden" name="action" value="campaign" />
                <div className="grid gap-2 sm:grid-cols-2">
                  <select name="kind" className="min-h-10 rounded-lg border border-silver/70 px-3 text-sm">
                    <option value="promo_offer">Promotional offer</option>
                    <option value="product_update">Product update</option>
                  </select>
                  <input name="title" required placeholder="Title (e.g. 20% off weekends)" className="min-h-10 rounded-lg border border-silver/70 px-3 text-sm" />
                </div>
                <textarea name="body" required rows={2} placeholder="Message body — personalized with the customer's first name automatically." className="w-full rounded-lg border border-silver/70 px-3 py-2 text-sm" />
                <button className="min-h-10 rounded-full bg-forest px-5 text-sm font-bold text-white">Queue campaign</button>
              </form>
            </section>
          )}

          {/* ── Failed queue ── */}
          <section className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
            <h2 className="font-display text-lg font-bold">Event outbox</h2>
            <p className="mt-1 text-xs text-graphite">Durable notification events — queued, failed and dead (5 attempts). Requeue puts them back on the 5-minute sweep.</p>
            <div className="mt-3 max-h-72 space-y-2 overflow-y-auto">
              {events.length === 0 && <p className="py-4 text-sm text-graphite">No pending or failed events — the outbox is clear.</p>}
              {events.map((e) => (
                <div key={e.id} className="flex items-center gap-3 rounded-xl border border-[#e3e8ee]/70 px-3 py-2.5">
                  <Pill tone={TONE[e.status] ?? "mist"}>{e.status}</Pill>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-bold">{e.kind} <span className="font-normal text-graphite">· {e.actor ?? "system"} · {e.attempts} attempt(s)</span></p>
                    <p className="truncate text-[11px] text-graphite">{e.last_error ?? `due ${when(e.due_at)}`} · {when(e.created_at)}</p>
                  </div>
                  {isAdmin && e.status !== "queued" && (
                    <form method="post" action="/api/admin/notifications">
                      <input type="hidden" name="action" value="requeue_event" /><input type="hidden" name="id" value={e.id} />
                      <button className="min-h-8 rounded-full bg-[#eef1f5] px-3 text-xs font-bold hover:bg-[#edeeff]">Requeue</button>
                    </form>
                  )}
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      {/* ── Delivery log ── */}
      <section className="mt-4 overflow-x-auto rounded-2xl border border-[#e3e8ee] bg-white shadow-sm">
        <div className="border-b border-[#e3e8ee] px-4 py-4"><h2 className="font-display text-lg font-bold">Recent deliveries</h2></div>
        {deliveries.length === 0 ? <p className="px-4 py-8 text-sm text-graphite">No channel deliveries recorded yet.</p> : (
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-[#e3e8ee] bg-[#eef1f5]/40 text-xs uppercase tracking-wider text-graphite"><tr>{["When", "Channel", "Status", "Detail"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr></thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id} className="border-b border-[#e3e8ee]/70 last:border-0">
                  <td className="whitespace-nowrap px-4 py-2.5 text-xs text-graphite">{when(d.created_at)}</td>
                  <td className="px-4 py-2.5"><Pill tone={TONE[d.channel] ?? "mist"}>{d.channel}</Pill></td>
                  <td className={`px-4 py-2.5 text-xs font-bold ${d.status === "failed" ? "text-red-700" : ""}`}>{d.status}</td>
                  <td className="px-4 py-2.5 text-xs text-graphite">{d.detail ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Customer notification history ── */}
      <section className="mt-4 rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
        <h2 className="font-display text-lg font-bold">Customer history</h2>
        <form method="get" className="mt-3 flex gap-2">
          <input name="email" defaultValue={sp.email ?? ""} placeholder="customer@email.com" className="min-h-10 flex-1 rounded-lg border border-silver/70 px-3 text-sm" />
          <button className="min-h-10 rounded-full bg-[#0a2540] px-5 text-sm font-bold text-white">Look up</button>
        </form>
        {sp.email && !historyOwner && <p className="mt-3 text-sm text-graphite">No account on <span className="font-bold">{sp.email}</span> — guests receive email/SMS only.</p>}
        {historyOwner && (
          <div className="mt-4 space-y-2">
            {history.length === 0 && <p className="text-sm text-graphite">No notifications yet for {historyOwner}.</p>}
            {history.map((n) => (
              <div key={n.id} className="flex items-start gap-3 rounded-xl border border-[#e3e8ee]/70 px-3 py-2.5">
                <Pill tone={n.category === "security" ? "gold" : n.category === "payment" ? "lime" : "mist"}>{n.category}</Pill>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold">{n.title} {!n.read_at && <span className="ml-1 rounded-full bg-[#635bff] px-1.5 py-0.5 text-[9px] font-extrabold uppercase text-white">unread</span>}</p>
                  <p className="truncate text-[11px] text-graphite">{n.body}</p>
                </div>
                <span className="whitespace-nowrap text-[11px] text-graphite">{when(n.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </AdminGate>
  );
}
