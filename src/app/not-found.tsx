import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: { absolute: "Page not found | Zapnivo" },
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center bg-paper px-6 text-ink">
      <div className="max-w-md text-center">
        <p className="eyebrow text-forest">404</p>
        <h1 className="display-md mt-4">This page lost its charge.</h1>
        <p className="mt-4 text-graphite">The page you&apos;re looking for doesn&apos;t exist or has moved.</p>
        <Link
          href="/"
          className="mt-8 inline-block rounded-full bg-ink px-6 py-3 font-bold text-white transition-colors hover:bg-forest"
        >
          Back to home
        </Link>
      </div>
    </main>
  );
}
