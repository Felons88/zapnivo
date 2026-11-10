export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { Conversation } from "@/components/Conversation";
import { PartnerGate } from "@/components/PartnerShell";
import { EmptyCard } from "@/components/PortalShell";
import { RequesterReply } from "@/components/RequesterReply";
import { TicketLive } from "@/components/TicketLive";
import { SESSION_COOKIE, getSessionUser } from "@/lib/auth";
import { defaultCtx, getRequesterThread } from "@/lib/helpdesk/service";
import { HelpdeskError } from "@/lib/helpdesk/types";

export const metadata: Metadata = { title: "Partner request", robots: { index: false, follow: false } };

export default async function PartnerThread({ params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  const user = await getSessionUser();
  const ctx = await defaultCtx();
  let thread = null;
  let denied = false;
  if (ctx && user?.role === "partner" && user.organizationId) {
    try { thread = await getRequesterThread(ctx, { kind: "partner", id: user.id, name: user.email.split("@")[0], email: user.email, orgId: user.organizationId }, number); }
    catch (e) { if (e instanceof HelpdeskError) denied = true; else throw e; }
  }
  const accessToken = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  return (
    <PartnerGate title={thread ? `${thread.number} · ${thread.category}` : "Partner request"} nav="support">
      {() => (
        <>
          {thread && <TicketLive ticketId={thread.id} intervalMs={15000} accessToken={accessToken} />}
          <Link href="/partners/support" className="text-sm font-bold underline underline-offset-4">← All requests</Link>
          {!thread ? <div className="mt-4"><EmptyCard title={denied ? "Request not found" : "Partner view"}>{denied ? "This request doesn't exist or isn't part of your organization." : "Sign in with a venue partner account to view requests."}</EmptyCard></div> : (
            <div className="mx-auto mt-6 max-w-3xl space-y-6">
              <Conversation messages={thread.messages} mine="partner" />
              <RequesterReply number={thread.number} mode="partner" withPerson resolved={thread.state === "resolved" || thread.state === "closed"} />
            </div>
          )}
        </>
      )}
    </PartnerGate>
  );
}
