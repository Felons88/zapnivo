import type { Metadata } from "next";
import { PageHero, Section } from "@/components/ui";
import { ScamReportForm } from "./ReportForm";

export const metadata: Metadata = {
  title: "Report a scam or suspicious Zapnivo message",
  description: "Report a suspicious email, text, payment request, or tampered kiosk QR code claiming to be Zapnivo.",
  robots: { index: false, follow: false },
};

export default function ScamReportPage() {
  return (
    <>
      <PageHero eyebrow="Scam awareness" title={<>Report a scam.</>}>
        <p>
          If you received a suspicious email or text, saw a fake payment request, or found a tampered QR code on a
          Zapnivo station, tell us here. Our security team reviews every report.
        </p>
      </PageHero>
      <Section className="pt-14">
        <div className="mx-auto max-w-2xl rounded-xl bg-white p-6 md:p-10">
          <ScamReportForm />
        </div>
      </Section>
    </>
  );
}
