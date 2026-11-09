export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 font-display text-[1.45rem] font-bold uppercase tracking-[-0.04em] ${className}`}>
      <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="9" fill="#D9FF73" />
        <path d="M18.5 5 9 18h6.2L13.5 27 23 14h-6.2L18.5 5Z" fill="#11122B" />
      </svg>
      Zapnivo
    </span>
  );
}
