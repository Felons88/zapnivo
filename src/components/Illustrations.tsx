/**
 * ILLUSTRATIVE vector renders. These are original artwork, NOT photographs of the real unit and
 * do not specify real hardware features. Replace with approved product photography
 * (see src/lib/media.ts) once available.
 */
type K = { className?: string; label?: boolean; glow?: boolean };

export function KioskIllustration({ className = "", glow = true }: K) {
  const slots = Array.from({ length: 8 }, (_, i) => ({ x: 62 + (i % 2) * 106, y: 238 + Math.floor(i / 2) * 62, i }));
  return (
    <svg viewBox="0 0 280 560" role="img" aria-label="Illustrative render of a white eight-slot Zapnivo charging kiosk with a touchscreen" className={className}>
      <defs>
        <linearGradient id="body" x1="0" x2="1"><stop offset="0" stopColor="#fff" /><stop offset=".6" stopColor="#f2f4ef" /><stop offset="1" stopColor="#dfe3dc" /></linearGradient>
        <linearGradient id="scr" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#1d2420" /><stop offset="1" stopColor="#0f1311" /></linearGradient>
      </defs>
      <ellipse cx="140" cy="540" rx="108" ry="12" fill="#11122B" opacity=".12" />
      <rect x="28" y="20" width="224" height="512" rx="30" fill="url(#body)" stroke="#d3d8d0" />
      <rect x="46" y="40" width="188" height="160" rx="16" fill="url(#scr)" />
      <g transform="translate(62 58)">
        <rect width="18" height="18" rx="5" fill="#D9FF73" />
        <path d="M10.5 3 5 10.5h3.6L7.600 15 13 7.500H9.400L10.500 3Z" fill="#11122B" />
        <text x="26" y="14" fill="#fff" fontFamily="sans-serif" fontWeight="800" fontSize="12" letterSpacing="1">ZAPNIVO</text>
      </g>
      <text x="62" y="118" fill="#fff" fontFamily="sans-serif" fontWeight="800" fontSize="22">Power</text>
      <text x="62" y="144" fill="#D9FF73" fontFamily="sans-serif" fontWeight="800" fontSize="22">to go.</text>
      <rect x="62" y="162" width="92" height="22" rx="11" fill="#D9FF73" />
      <text x="108" y="177" fill="#11122B" fontFamily="sans-serif" fontWeight="800" fontSize="10" textAnchor="middle">START</text>
      <rect x="46" y="214" width="188" height="290" rx="18" fill="#eef0eb" stroke="#d3d8d0" />
      {slots.map((s) => (
        <g key={s.i}>
          <rect x={s.x - 16} y={s.y} width="92" height="50" rx="9" fill="#fff" stroke="#cfd5cb" />
          <rect x={s.x - 6} y={s.y + 10} width="72" height="30" rx="7" fill="#494967" />
          {glow && <rect className="charge-led" style={{ ["--d" as string]: `${s.i * 260}ms` }} x={s.x + 2} y={s.y + 22} width="56" height="5" rx="2.500" fill="#D9FF73" />}
        </g>
      ))}
    </svg>
  );
}

export function PowerBankIllustration({ className = "" }: K) {
  return (
    <svg viewBox="0 0 220 360" role="img" aria-label="Illustrative portable power bank with charging cable" className={className}>
      <ellipse cx="110" cy="346" rx="80" ry="8" fill="#11122B" opacity=".12" />
      <rect x="40" y="20" width="140" height="318" rx="26" fill="#494967" />
      <rect x="40" y="20" width="140" height="318" rx="26" fill="none" stroke="#4a524c" />
      <rect x="62" y="48" width="96" height="10" rx="5" fill="#11122B" />
      <g fill="#D9FF73">{[0, 1, 2, 3].map((i) => <rect key={i} className="charge-led" style={{ ["--d" as string]: `${i * 300}ms` }} x={66 + i * 24} y="80" width="18" height="6" rx="3" />)}</g>
      <path d="M118 150 92 205h20l-8 46 38-62h-22l8-39Z" fill="#D9FF73" />
      <text x="110" y="300" fill="#AAA8C4" fontFamily="sans-serif" fontWeight="800" fontSize="11" letterSpacing="3" textAnchor="middle">ZAPNIVO</text>
      <path d="M180 300c40 0 36-60 20-90" stroke="#11122B" strokeWidth="5" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export function PhoneIllustration({ className = "", charging = true }: K & { charging?: boolean }) {
  return (
    <svg viewBox="0 0 200 380" role="img" aria-label="Illustrative smartphone connected to a portable charger" className={className}>
      <rect x="30" y="10" width="140" height="350" rx="30" fill="#11122B" />
      <rect x="38" y="20" width="124" height="330" rx="24" fill="#1D1B46" />
      <rect x="82" y="30" width="36" height="10" rx="5" fill="#0f1311" />
      <text x="100" y="170" fill="#fff" fontFamily="sans-serif" fontWeight="800" fontSize="34" textAnchor="middle">{charging ? "78%" : "100%"}</text>
      <rect x="62" y="190" width="76" height="12" rx="6" fill="#11122B" />
      <rect className="slot-bar" x="62" y="190" width="60" height="12" rx="6" fill="#D9FF73" style={{ transformOrigin: "left", animation: "none" }} />
      <path d="M104 100 88 128h12l-5 20 20-30h-12l1-18Z" fill="#D9FF73" />
    </svg>
  );
}

export function IllustrativeTag({ light = false }: { light?: boolean }) {
  return <span className={`pointer-events-none inline-block rounded-full px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-widest ${light ? "bg-white/15 text-white" : "bg-ink/10 text-ink"}`}>Illustrative render</span>;
}
