"use client";
import { useRef, useState } from "react";
import { inputCls } from "@/components/forms";
import { btnClass } from "@/components/ui";

type State = { status: "idle" | "sending" | "done" | "error"; message?: string };

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("read_failed"));
    r.readAsDataURL(file);
  });
}

/** Add-creative form: text (headline/body/https link) or image/video file upload. */
export function CreativeForm({ campaignId, locked }: { campaignId: string; locked: boolean }) {
  const [s, setS] = useState<State>({ status: "idle" });
  const [kind, setKind] = useState<"text" | "image" | "video">("text");
  const formRef = useRef<HTMLFormElement>(null);

  if (locked) return <p className="text-sm text-graphite">This campaign is no longer editable — creatives are locked once it's past review.</p>;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setS({ status: "sending" });
    let payload: Record<string, unknown>;
    try {
      if (kind === "text") {
        payload = { kind: "text", campaign_id: campaignId, headline: fd.get("headline") || undefined, body: fd.get("body") || undefined, destination_url: fd.get("destination_url") || undefined };
      } else {
        const file = fd.get("file");
        if (!(file instanceof File) || !file.size) { setS({ status: "error", message: "Choose a file." }); return; }
        const cap = kind === "image" ? 5 * 1024 * 1024 : 50 * 1024 * 1024;
        if (file.size > cap) { setS({ status: "error", message: `Files must be ${cap / 1024 / 1024} MB or smaller.` }); return; }
        payload = { kind, campaign_id: campaignId, file_name: file.name, data_base64: await fileToBase64(file) };
      }
    } catch {
      setS({ status: "error", message: "Couldn't read that file." });
      return;
    }
    try {
      const res = await fetch("/api/advertiser/creatives", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setS({ status: "done", message: "Creative added." });
        formRef.current?.reset();
        setTimeout(() => window.location.reload(), 600);
        return;
      }
      setS({ status: "error", message: data.error ?? "Couldn't save the creative." });
    } catch {
      setS({ status: "error", message: "Network error. Please try again." });
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} className="space-y-5">
      <div className="flex gap-2" role="radiogroup" aria-label="Creative kind">
        {(["text", "image", "video"] as const).map((k) => (
          <button key={k} type="button" onClick={() => setKind(k)} aria-pressed={kind === k}
            className={`rounded-full px-4 py-2 text-sm font-bold ${kind === k ? "bg-ink text-white" : "bg-mist text-graphite hover:bg-mist/70"}`}>
            {k === "text" ? "Text" : k === "image" ? "Image" : "Video"}
          </button>
        ))}
      </div>

      {kind === "text" ? (
        <div className="grid gap-5">
          <div>
            <label htmlFor="headline" className="mb-1.5 block text-sm font-bold">Headline <span className="font-medium text-graphite">(optional)</span></label>
            <input id="headline" name="headline" maxLength={140} className={inputCls} />
          </div>
          <div>
            <label htmlFor="body" className="mb-1.5 block text-sm font-bold">Body <span className="font-medium text-graphite">(optional)</span></label>
            <textarea id="body" name="body" rows={3} maxLength={1200} className={inputCls} />
          </div>
          <div>
            <label htmlFor="destination_url" className="mb-1.5 block text-sm font-bold">Destination URL <span className="font-medium text-graphite">(https, optional)</span></label>
            <input id="destination_url" name="destination_url" type="url" maxLength={500} placeholder="https://" className={inputCls} />
          </div>
        </div>
      ) : (
        <div>
          <label htmlFor="file" className="mb-1.5 block text-sm font-bold">{kind === "image" ? "Image file" : "Video file"}</label>
          <input id="file" name="file" type="file" required
            accept={kind === "image" ? "image/png,image/jpeg,image/webp" : "video/mp4"}
            className={`${inputCls} file:mr-4 file:rounded-full file:border-0 file:bg-mist file:px-4 file:py-2 file:font-bold`} />
          <p className="mt-1 text-xs text-graphite">{kind === "image" ? "PNG, JPEG or WebP, up to 5 MB." : "MP4, up to 50 MB."}</p>
        </div>
      )}

      {s.status === "error" && <p role="alert" className="rounded-md bg-red-50 p-4 text-sm font-semibold text-red-800">{s.message}</p>}
      {s.status === "done" && <p role="status" className="rounded-md bg-lime p-4 text-sm font-semibold text-ink">{s.message}</p>}
      <button type="submit" disabled={s.status === "sending"} className={btnClass("dark", "w-full disabled:opacity-60 sm:w-auto")}>
        {s.status === "sending" ? "Uploading…" : "Add creative"}
      </button>
    </form>
  );
}
