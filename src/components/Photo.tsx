import Image from "next/image";

const SCENES = {
  cafe: { src: "/images/charging-cafe.png", alt: "Illustrative café scene with a portable charger powering a phone beside a coffee" },
  evening: { src: "/images/charging-evening.png", alt: "Illustrative evening venue scene with a phone charging at a table" },
  hotel: { src: "/images/charging-hotel.png", alt: "Illustrative hotel lounge scene with a traveler using a portable charger" },
  event: { src: "/images/charging-event.png", alt: "Illustrative outdoor event scene with a person charging a phone on the move" },
} as const;

const KIOSK_SCENES = {
  bar: { src: "/images/kiosk-bar.png", alt: "Illustrative Zapnivo kiosk placement inside a neighborhood bar" },
  cafe: { src: "/images/kiosk-cafe.png", alt: "Illustrative Zapnivo kiosk placement inside a café" },
  hotel: { src: "/images/kiosk-hotel.png", alt: "Illustrative Zapnivo kiosk placement in a hotel lobby" },
  shopping: { src: "/images/kiosk-shopping.png", alt: "Illustrative Zapnivo kiosk placement in a shopping center" },
  campus: { src: "/images/kiosk-campus.png", alt: "Illustrative Zapnivo kiosk placement in a student center" },
  event: { src: "/images/kiosk-event.png", alt: "Illustrative Zapnivo kiosk placement in an event venue" },
} as const;

/** Generated placement concepts based on the actual Zapnivo kiosk photo. */
export function KioskScenePhoto({ scene, className = "", priority = false }: { scene: keyof typeof KIOSK_SCENES; className?: string; priority?: boolean }) {
  const photo = KIOSK_SCENES[scene];
  return <Image src={photo.src} alt={photo.alt} fill priority={priority} sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw" className={`object-cover ${className}`} />;
}

/** Concept photography. The scenes are illustrative, not actual Zapnivo venues or customers. */
export function ScenePhoto({ scene, className = "", priority = false }: { scene: keyof typeof SCENES; className?: string; priority?: boolean }) {
  const photo = SCENES[scene];
  return <Image src={photo.src} alt={photo.alt} fill priority={priority} sizes="(min-width: 1024px) 50vw, 100vw" className={`object-cover ${className}`} />;
}

const ALT = "White Zapnivo eight-slot portable charger rental kiosk with a touchscreen and card reader";

/** The real Zapnivo kiosk. Transparent-source photo; sits on any background. */
export function KioskPhoto({ className = "", priority = false }: { className?: string; priority?: boolean }) {
  return (
    <Image
      src="/images/kiosk.png"
      alt={ALT}
      width={819}
      height={1024}
      priority={priority}
      sizes="(min-width: 1024px) 38vw, 80vw"
      className={className}
    />
  );
}

/** Portable power bank photo (transparent cutout). Representative of the rental unit. */
export function PowerBankPhoto({ className = "" }: { className?: string }) {
  return (
    <Image
      src="/images/powerbank.png"
      alt="Black portable power bank with built-in USB-A, Lightning and USB-C cables and a digital charge display"
      width={386}
      height={470}
      sizes="(min-width: 1024px) 24vw, 50vw"
      className={className}
    />
  );
}

type Crop = "screen" | "slots";
const CROP: Record<Crop, { pos: string; ratio: string; alt: string }> = {
  screen: { pos: "50% 22%", ratio: "1 / 1.05", alt: "Close-up of the Zapnivo kiosk touchscreen showing the rental flow" },
  slots: { pos: "50% 82%", ratio: "1 / 0.72", alt: "Close-up of the eight power-bank slots with charge indicators" },
};

/** Real-photo detail crop of the kiosk, used inside fixed-ratio frames. */
export function KioskCrop({ view, className = "" }: { view: Crop; className?: string }) {
  const c = CROP[view];
  return (
    <div className={`relative overflow-hidden ${className}`} style={{ aspectRatio: c.ratio }}>
      <Image
        src="/images/kiosk.png"
        alt={c.alt}
        fill
        sizes="(min-width: 1024px) 40vw, 90vw"
        className="object-cover"
        style={{ objectPosition: c.pos, transform: "scale(1.9)" }}
      />
    </div>
  );
}
