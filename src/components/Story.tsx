"use client";
import { useEffect, useRef, useState } from "react";
import { IllustrativeTag, PhoneIllustration } from "./Illustrations";
import { KioskPhoto, PowerBankPhoto } from "./Photo";
import { Eyebrow } from "./ui";

const STEPS = [
  { n: "01", title: "Find your power.", body: "Spot a Zapnivo station at a participating venue and see the rental terms on the touchscreen before you start.", photo: true },
  { n: "02", title: "Take it with you.", body: "After a successful checkout, a power bank is released from the station. Stay at the table, keep the night going.", photo: true },
  { n: "03", title: "Stay connected.", body: "Plug in and carry on. Your phone charges while you move around.", photo: false },
  { n: "04", title: "Return and go.", body: "Bring the power bank back to any eligible participating station and your rental ends.", photo: true },
];

function Visual({ i }: { i: number }) {
  if (i === 0) return <KioskPhoto className="h-full max-h-[460px] w-auto object-contain" />;
  if (i === 1) return <div className="flex h-full items-center justify-center gap-6"><KioskPhoto className="h-[92%] w-auto object-contain opacity-60" /><PowerBankPhoto className="h-auto max-h-[300px] w-44 object-contain drop-shadow-xl" /></div>;
  if (i === 2) return <div className="relative flex h-full items-center gap-2"><PhoneIllustration className="h-[85%]" /><PowerBankPhoto className="h-auto w-40 object-contain drop-shadow-xl" /><div className="absolute bottom-2 left-2"><IllustrativeTag /></div></div>;
  return <div className="flex h-full items-end justify-center gap-8"><PowerBankPhoto className="h-auto max-h-[260px] w-40 -translate-y-6 object-contain drop-shadow-xl" /><KioskPhoto className="h-[92%] w-auto object-contain" /></div>;
}

/** Desktop: sticky visual swaps as each step scrolls past. Mobile / reduced motion: stacked steps. */
export function Story() {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLLIElement | null)[]>([]);
  useEffect(() => {
    const io = new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && setActive(Number((e.target as HTMLElement).dataset.i))), { rootMargin: "-45% 0px -45% 0px" });
    refs.current.forEach((r) => r && io.observe(r));
    return () => io.disconnect();
  }, []);
  return (
    <section className="bg-mist py-20 md:py-32" aria-labelledby="story-h">
      <div className="container-z">
        <Eyebrow className="text-forest">The experience</Eyebrow>
        <h2 id="story-h" className="display-lg mt-5 max-w-3xl">Four steps. Zero hunting for an outlet.</h2>
        <div className="mt-14 grid gap-12 lg:grid-cols-2 lg:gap-20">
          <div className="relative hidden lg:block">
            <div className="sticky top-28 flex h-[560px] items-center justify-center overflow-hidden rounded-xl bg-white p-10">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} aria-hidden={active !== i} className={`absolute inset-0 flex items-center justify-center p-10 transition-all duration-700 ease-[var(--ease-out-expo)] ${active === i ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"}`}><Visual i={i} /></div>
              ))}
              {STEPS[active].photo && <div className="absolute bottom-4 right-4"><span className="inline-block rounded-full bg-ink/80 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-widest text-lime">Actual hardware</span></div>}
            </div>
          </div>
          <ol className="space-y-8 lg:space-y-0">
            {STEPS.map((s, i) => (
              <li key={s.n} data-i={i} ref={(el) => { refs.current[i] = el; }} className="rounded-xl bg-white p-6 lg:flex lg:min-h-[70vh] lg:flex-col lg:justify-center lg:bg-transparent lg:p-0">
                <div className="mb-6 flex h-64 items-center justify-center overflow-hidden rounded-lg bg-mist p-5 lg:hidden"><Visual i={i} /></div>
                <span className="eyebrow text-forest">Step {s.n}</span>
                <h3 className={`display-md mt-3 transition-opacity duration-500 ${active === i ? "lg:opacity-100" : "lg:opacity-35"}`}>{s.title}</h3>
                <p className="lead mt-4 max-w-md text-graphite">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
