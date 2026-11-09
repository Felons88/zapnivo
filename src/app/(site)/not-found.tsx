import { Button, PageHero } from "@/components/ui";

export default function NotFound() {
  return (
    <PageHero eyebrow="404" title={<>This page lost its charge.</>}>
      <p>The page you're looking for doesn't exist or has moved.</p>
      <div className="mt-8 flex gap-4">
        <Button href="/">Back to home</Button>
        <Button href="/support" variant="ghost" className="border-white/40 text-white">Get support</Button>
      </div>
    </PageHero>
  );
}
