export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AdminGate } from "@/components/AdminShell";
import { Pill } from "@/components/SupportNav";
import { getSessionUser, isStaff } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Email detail", robots: { index: false, follow: false } };

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";

export default async function EmailDetail({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!isStaff(user)) redirect("/partners");
  const { id } = await params;
  const db = serviceClient();
  const { data: m } = db ? await db.from("email_outbox").select("id,to_email,subject,body,status,error,created_at,ticket_id").eq("id", id).maybeSingle() : { data: null };
  const mail = m as { id: string; to_email: string; subject: string; body: string; status: string; error: string | null; created_at: string; ticket_id: string | null } | null;
  if (!mail) notFound();

  const { data: t } = mail.ticket_id ? await db!.from("support_tickets").select("ticket_number").eq("id", mail.ticket_id).maybeSingle() : { data: null };
  const ticket = t as { ticket_number: string } | null;

  const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
    <div className="flex items-baseline justify-between gap-4 border-b border-[#e3e8ee]/70 py-2 last:border-0"><dt className="text-sm text-graphite">{k}</dt><dd className="text-right text-sm font-bold">{v}</dd></div>
  );

  return (
    <AdminGate title={`Email · ${mail.subject}`} nav="customers">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link href={`/admin/customers/${encodeURIComponent(mail.to_email)}`} className="text-sm font-bold text-graphite hover:text-ink">← Customer 360</Link>
          <span className="text-xs font-bold uppercase tracking-widest text-graphite">Staff only · outbox record</span>
        </div>

        <section className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-xl font-bold">{mail.subject}</h2>
            <Pill tone={mail.status === "sent" ? "lime" : mail.status === "failed" ? "red" : "gold"}>{mail.status}</Pill>
          </div>
          <dl className="mt-4">
            <Row k="To" v={mail.to_email} />
            <Row k="Queued" v={when(mail.created_at)} />
            {ticket && <Row k="Ticket" v={<Link className="text-forest underline" href={`/admin/support/${ticket.ticket_number}`}>{ticket.ticket_number}</Link>} />}
          </dl>
          {mail.error && (
            <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4">
              <p className="text-xs font-extrabold uppercase tracking-wider text-red-800">Delivery failure</p>
              <p className="mt-1 whitespace-pre-wrap text-sm font-semibold text-red-900">{mail.error}</p>
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
          <h3 className="font-display text-lg font-bold">Message body</h3>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-7">{mail.body}</p>
        </section>
      </div>
    </AdminGate>
  );
}
