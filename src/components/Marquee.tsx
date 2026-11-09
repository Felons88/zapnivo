export function Marquee({ items, className = "" }: { items: string[]; className?: string }) {
  const row = (hidden: boolean) => (
    <ul aria-hidden={hidden || undefined} className="flex shrink-0 items-center">
      {items.map((t) => (
        <li key={t} className="flex items-center whitespace-nowrap px-6 font-display text-3xl font-bold uppercase tracking-tight md:text-5xl">
          {t}
          <svg className="ml-12 h-6 w-6 shrink-0 md:h-8 md:w-8" viewBox="0 0 24 24" aria-hidden><path d="M13 2 5 14h6l-2 8 10-12h-6l2-8Z" fill="currentColor" /></svg>
        </li>
      ))}
    </ul>
  );
  return (
    <div className={`marquee overflow-hidden py-5 ${className}`} role="presentation">
      <div className="marquee-track">{row(false)}{row(true)}</div>
    </div>
  );
}
