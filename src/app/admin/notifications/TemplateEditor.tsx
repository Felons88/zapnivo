"use client";

import { useState } from "react";

/** Sample vars for the live preview — display only, never sent. */
const SAMPLE: Record<string, string> = {
  first_name: "James", hi: "James, ", name: "James", amount: "$5.00", currency: "USD",
  balance: "$12.40", last4: "4242", card_ref: " on your Visa •••• 4242",
  station_name: "Downtown Tavern", city: "Chicago", rental_duration: "2h 15m",
  ticket_id: "Z-1042", agent_name: "Maya", event_time: "Nov 18, 4:30 PM",
  rental_ref: "ZR-ABC123", deadline: "Nov 12, 3:00 PM UTC", fee: "$45.00",
  charges: "$14.97", reason: " (goodwill)", brand: "Visa", device: "mobile app",
  location: " near Chicago, US", app_version: "1.3.0", promo: "20% off weekends",
  units: "5", count: "3", url: "https://zapnivo.com/account", email: "j***@gmail.com", phone_tail: "1234",
};

const preview = (tpl: string) =>
  tpl.replace(/\{(\w+)\}/g, (m, k: string) => SAMPLE[k] ?? m);

/**
 * One editable notification template (title + body + channel badges) with a
 * live preview. Save writes a notification_templates override row; Reset
 * deletes it and the code registry's copy takes over again.
 */
export function NotificationTemplateEditor({ kind, title, body, category, channels, essential, enabled, overridden }: {
  kind: string; title: string; body: string; category: string;
  channels: string[]; essential: boolean; enabled: boolean; overridden: boolean;
}) {
  const [t, setT] = useState(title);
  const [b, setB] = useState(body);
  const shownTitle = preview(t);
  const shownBody = preview(b);
  return (
    <div className="rounded-xl border border-mist/80 bg-paper/60 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[11px] font-extrabold uppercase tracking-wider text-silver">{kind.replace(/_/g, " ")}</p>
        <span className="rounded-full bg-mist px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-graphite">{category}</span>
        {essential && <span className="rounded-full bg-forest/15 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-forest">essential</span>}
        {overridden && <span className="rounded-full bg-gold/40 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-ink">custom</span>}
        {!enabled && <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-red-700">disabled</span>}
        <span className="ml-auto text-[10px] font-bold uppercase tracking-wider text-graphite">{channels.join(" · ")}</span>
      </div>
      <form method="post" action="/api/admin/notifications" className="mt-3 space-y-2">
        <input type="hidden" name="action" value="save_template" />
        <input type="hidden" name="kind" value={kind} />
        <input name="title" value={t} onChange={(e) => setT(e.target.value)} maxLength={160} className="w-full rounded-lg border border-silver/70 px-3 py-2 text-xs font-bold" />
        <textarea name="body" rows={2} value={b} onChange={(e) => setB(e.target.value)} maxLength={1000} className="w-full rounded-lg border border-silver/70 px-3 py-2 text-xs" />
        <div className="rounded-lg bg-mist/50 px-2 py-1.5 text-[11px] text-graphite">
          <p><span className="font-extrabold uppercase tracking-wider">Push: </span><span className="font-semibold text-ink">{shownTitle} — {shownBody}</span></p>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <button className="min-h-8 rounded-full bg-mist px-3 text-xs font-bold hover:bg-lime">Save</button>
        </div>
      </form>
      <div className="mt-1 flex gap-2">
        {overridden && (
          <form method="post" action="/api/admin/notifications">
            <input type="hidden" name="action" value="reset_template" /><input type="hidden" name="kind" value={kind} />
            <button className="text-xs font-bold text-graphite underline underline-offset-2">Reset to default</button>
          </form>
        )}
        {!essential && (
          <form method="post" action="/api/admin/notifications">
            <input type="hidden" name="action" value="toggle_template" /><input type="hidden" name="kind" value={kind} />
            <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
            <button className={`text-xs font-bold underline underline-offset-2 ${enabled ? "text-red-700" : "text-forest"}`}>{enabled ? "Disable" : "Enable"}</button>
          </form>
        )}
      </div>
    </div>
  );
}
