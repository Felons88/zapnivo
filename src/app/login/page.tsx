import type { Metadata } from "next";
import { PageHero, Section } from "@/components/ui";
import { authConfigured } from "@/lib/auth";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Sign in", robots: { index: false, follow: false } };

export default function Login() {
  return (
    <>
      <PageHero eyebrow="Staff & partners" title={<>Sign in.</>}>
        <p>Access for Zapnivo staff and authorized venue partners. Customers don't need an account to rent.</p>
      </PageHero>
      <Section className="pt-14">
        <div className="mx-auto max-w-md rounded-xl bg-white p-6 md:p-10"><LoginForm configured={authConfigured()} /></div>
      </Section>
    </>
  );
}
