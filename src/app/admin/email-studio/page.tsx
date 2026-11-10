export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { mailerConfigured } from "@/lib/helpdesk/mailer";
import { serviceClient } from "@/lib/supabase";
import { EmailStudio } from "./EmailStudio";

export const metadata: Metadata = { title: "Email studio", robots: { index: false, follow: false } };

export default async function EmailStudioPage() {
  const db = serviceClient();
  const staffRes = db
    ? await db.from("profiles").select("email,full_name,role").in("role", ["admin", "staff"]).order("email").limit(200)
    : null;
  const staff = ((staffRes?.data ?? []) as { email: string; full_name: string | null; role: string }[])
    .filter((r) => r.email)
    .map((r) => ({ email: r.email, name: r.full_name ?? r.email, role: r.role }));

  return (
    <AdminGate title="Email studio" nav="emailStudio">
      {!mailerConfigured() && (
        <p className="mb-4 rounded-xl bg-gold/40 px-4 py-3 text-sm font-bold">
          Email delivery isn't configured — set RESEND_API_KEY or BREVO_API_KEY plus SUPPORT_FROM_EMAIL.
          Previews still work; test sends stay queued in the outbox until a provider is set.
        </p>
      )}
      <EmailStudio staffRecipients={staff} mailerConfigured={mailerConfigured()} />
    </AdminGate>
  );
}
