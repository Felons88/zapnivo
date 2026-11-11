export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard } from "@/components/PortalShell";
import { serviceClient } from "@/lib/supabase";
import { listArticles, staleReport, type KnowledgeArticle, type StaleArticle } from "@/lib/knowledge/db";
import { KnowledgeManager } from "./KnowledgeManager";

export const metadata: Metadata = { title: "Knowledge base", robots: { index: false, follow: false } };

export default async function KnowledgePage() {
  const db = serviceClient();
  const [articles, stale] = db
    ? await Promise.all([listArticles(db), staleReport(db)])
    : [[] as KnowledgeArticle[], [] as StaleArticle[]];

  return (
    <AdminGate title="Knowledge base" nav="knowledge">
      {!db ? (
        <EmptyCard title="Knowledge data not connected">Connect Supabase to manage knowledge articles.</EmptyCard>
      ) : (
        <KnowledgeManager initialArticles={articles} initialStale={stale} />
      )}
    </AdminGate>
  );
}
