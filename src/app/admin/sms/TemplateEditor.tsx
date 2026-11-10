"use client";

import { useState } from "react";
import { fmt, PRICING_V1 } from "@/lib/pricing";

/**
 * One editable SMS template with a live preview rendered from sample data.
 * Kept dependency-light on purpose: lib/notifications is server-only (node:crypto via
 * helpdesk/access), so the preview re-implements the same {var} interpolation here.
 * Nothing is sent — this is display-only.
 */
const SAMPLE: Record<string, string> = {
  ref: "ZR-ABC123",
  rate: fmt(PRICING_V1.firstHourCents),
  fee: fmt(PRICING_V1.nonReturnMaxCents),
  deadline: "Nov 12, 3:00 PM UTC",
  charges: fmt(PRICING_V1.firstHourCents * 3),
  url: "https://zapnivo.com/account",
  ticket: "Z-1042",
  name: "there",
};

const preview = (tpl: string) =>
  tpl.replace(/\{(\w+)\}/g, (m, k: string) => SAMPLE[k] ?? m);

export function TemplateEditor({ kind, defaultValue }: { kind: string; defaultValue: string }) {
  const [body, setBody] = useState(defaultValue);
  const shown = preview(body || "(empty — the built-in default is used)");
  return (
    <form method="post" action="/api/admin/sms" className="flex items-start gap-2">
      <input type="hidden" name="action" value="save_template" /><input type="hidden" name="kind" value={kind} />
      <div className="flex-1">
        <label htmlFor={`tpl-${kind}`} className="mb-1 block text-[11px] font-extrabold uppercase tracking-wider text-silver">{kind.replace(/_/g, " ")}</label>
        <textarea
          id={`tpl-${kind}`} name="body" rows={2} value={body}
          onChange={(e) => setBody(e.target.value)}
          className="w-full rounded-lg border border-silver/70 px-3 py-2 text-xs"
        />
        <p className="mt-1 rounded-lg bg-mist/50 px-2 py-1.5 text-[11px] text-graphite">
          <span className="font-extrabold uppercase tracking-wider">Preview: </span>
          <span className="font-semibold text-ink">{shown}</span>
        </p>
      </div>
      <button className="mt-5 min-h-8 rounded-full bg-mist px-3 text-xs font-bold hover:bg-lime">Save</button>
    </form>
  );
}
