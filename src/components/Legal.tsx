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
          {review && <div className="mb-8"><Notice title="Draft — pending legal review.">This document is a working draft and has not been reviewed or approved by an attorney. Sections marked <strong>[REVIEW]</strong> require legal sign-off before publication as binding terms.</Notice></div>}
          <div className="prose-z">{children}</div>
        </div>
      </Section>
    </>
  );
}
