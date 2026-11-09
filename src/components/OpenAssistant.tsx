"use client";

export function OpenAssistant({ className = "" }: { className?: string }) {
  return (
    <button type="button" onClick={() => window.dispatchEvent(new Event("zapnivo:open-assistant"))} className={`inline-flex min-h-12 items-center rounded-full border border-white/40 px-6 font-bold text-white hover:border-lime hover:text-lime ${className}`}>
      Ask the AI assistant
    </button>
  );
}
