"use client";

import { useEffect } from "react";
import "./globals.css";

/**
 * Root-layout error boundary — replaces the root layout when active, so it must
 * render its own <html>/<body>. globals.css is imported directly because the
 * layout that normally loads it is not rendered. Brand fonts fall back to the
 * system stack here; that is acceptable for a fatal-error screen.
 */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main className="grid min-h-screen place-items-center bg-paper px-6 text-ink">
          <div className="max-w-md text-center">
            <p className="eyebrow text-forest">Something went wrong</p>
            <h1 className="display-md mt-4">This page lost its charge.</h1>
            <p className="mt-4 text-graphite">An unexpected error occurred. Try again, or head back home.</p>
            <div className="mt-8 flex items-center justify-center gap-4">
              <button
                type="button"
                onClick={() => retry()}
                className="rounded-full bg-ink px-6 py-3 font-bold text-white transition-colors hover:bg-forest"
              >
                Try again
              </button>
              <a href="/" className="font-bold text-forest underline underline-offset-4">
                Back to home
              </a>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
