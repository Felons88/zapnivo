import type { Metadata } from "next";
import { PageHero, Section, Notice } from "@/components/ui";

export function LegalPage({ title, updated, review = true, children }: { title: string; updated: string; review?: boolean; children: React.ReactNode }) {
  return (
    <>
      <PageHero eyebrow="Legal" title={title}>
        <p className="text-base">Last updated: {updated}</p>
      </PageHero>
      <Section className="pt-12">
        <div className="mx-auto max-w-3xl">
          {review && <div className="mb-8"><Notice title="Pending legal review.">This document is a working draft and has not been reviewed or approved by an attorney. Sections marked "Pending legal review" still require legal sign-off before publication as binding terms.</Notice></div>}
          <div className="prose-z">{children}</div>
        </div>
      </Section>
    </>
  );
}

/** Inline marker for a specific passage that still needs attorney/business sign-off. */
export function PendingReview({ children }: { children: React.ReactNode }) {
  return (
    <p className="my-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-graphite">
      <strong>Pending legal review:</strong> {children}
    </p>
  );
}
