"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EMAIL_TEMPLATES, templatesByAudience, type EmailTemplateSpec } from "@/lib/email-studio";
import { InboundPanel, SendersPanel, TriggersPanel, LogPanel } from "./CenterPanels";

type StaffRecipient = { email: string; name: string; role: string };
type SenderOption = { id: string; name: string; email: string };
type StudioView = "templates" | "senders" | "triggers" | "log" | "inbound";

const VIEWS: { id: StudioView; label: string }[] = [
  { id: "templates", label: "Templates" },
  { id: "senders", label: "Senders" },
  { id: "triggers", label: "Triggers" },
  { id: "log", label: "Log" },
  { id: "inbound", label: "Inbound" },
];
type Preview = {
  available: boolean;
  subject?: string;
  html?: string;
  text?: string;
  vars?: string[];
  error?: string;
};

const WIDTHS = { desktop: 600, mobile: 375 } as const;

export function EmailStudio({ staffRecipients, mailerConfigured }: { staffRecipients: StaffRecipient[]; mailerConfigured: boolean }) {
  const [spec, setSpec] = useState<EmailTemplateSpec>(EMAIL_TEMPLATES[0]);
  const [vars, setVars] = useState<Record<string, string>>(EMAIL_TEMPLATES[0].sampleVars);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [width, setWidth] = useState<keyof typeof WIDTHS>("desktop");
  const [dark, setDark] = useState(false);
  const [tab, setTab] = useState<"preview" | "text">("preview");
  const [sendTo, setSendTo] = useState(staffRecipients[0]?.email ?? "");
  const [sendSender, setSendSender] = useState("auto");
  const [senderOptions, setSenderOptions] = useState<SenderOption[]>([]);
  const [view, setView] = useState<StudioView>("templates");
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadPreview = useCallback(async (template: string, v: Record<string, string>) => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/email-studio/preview", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ template, vars: v }),
      });
      const data = (await res.json()) as Preview & { error?: string };
      setPreview(res.ok ? data : { available: false, error: data.error ?? `HTTP ${res.status}` });
    } catch {
      setPreview({ available: false, error: "Preview request failed." });
    } finally {
      setLoading(false);
    }
  }, []);

  const selectTemplate = (s: EmailTemplateSpec) => {
    setSpec(s);
    setVars({ ...s.sampleVars });
    setSendResult(null);
    void loadPreview(s.name, s.sampleVars);
  };

  // Sender identities for the test-send "From" picker (registry may be unavailable).
  useEffect(() => {
    fetch("/api/admin/email-studio/senders", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { senders?: SenderOption[] } | null) => { if (d?.senders) setSenderOptions(d.senders); })
      .catch(() => { /* picker just stays on "Automatic" */ });
  }, []);

  // initial render + debounced re-render on var edits
  useEffect(() => { void loadPreview(spec.name, vars); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void loadPreview(spec.name, vars), 450);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vars]);

  const sendTest = async () => {
    if (!sendTo) return;
    setSending(true);
    setSendResult(null);
    try {
      const res = await fetch("/api/admin/email-studio/test", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ template: spec.name, to: sendTo, vars, ...(sendSender !== "auto" ? { sender: sendSender } : {}) }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setSendResult({
          ok: true,
          msg: data.sent
            ? `Test sent to ${sendTo}.`
            : data.mailerConfigured === false
              ? `Queued to ${sendTo} — email delivery isn't configured, so it will send once a provider is set.`
              : `Queued to ${sendTo}.`,
        });
      } else {
        setSendResult({ ok: false, msg: data.error ?? `Send failed (HTTP ${res.status}).` });
      }
    } catch {
      setSendResult({ ok: false, msg: "Send request failed." });
    } finally {
      setSending(false);
    }
  };

  const groups = templatesByAudience();
  const varKeys = Array.from(new Set([...(preview?.vars ?? []), ...Object.keys(spec.sampleVars)])).sort();

  return (
    <div className="space-y-6">
      {/* ── Studio section nav ── */}
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Email studio sections">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={view === v.id}
            onClick={() => setView(v.id)}
            className={`rounded-full px-4 py-2 text-sm font-extrabold transition-colors ${
              view === v.id ? "bg-ink text-white" : "border border-mist bg-white text-graphite hover:bg-mist hover:text-ink"
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      {view === "senders" && <SendersPanel />}
      {view === "triggers" && <TriggersPanel />}
      {view === "log" && <LogPanel />}
      {view === "inbound" && <InboundPanel />}

      {view === "templates" && (
    <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
      {/* ── Template library ── */}
      <aside className="space-y-5">
        {groups.map((g) => (
          <section key={g.audience}>
            <h2 className="eyebrow mb-2">{g.audience}</h2>
            <ul className="space-y-1">
              {g.templates.map((t) => (
                <li key={t.name}>
                  <button
                    type="button"
                    onClick={() => selectTemplate(t)}
                    aria-current={t.name === spec.name}
                    className={`w-full rounded-xl px-3 py-2 text-left text-sm font-bold transition-colors ${
                      t.name === spec.name ? "bg-ink text-white" : "bg-white text-graphite hover:bg-mist hover:text-ink border border-mist"
                    }`}
                  >
                    {t.displayName}
                    <span className={`block text-[11px] font-semibold ${t.name === spec.name ? "text-white/70" : "text-silver"}`}>{t.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <p className="rounded-xl bg-mist/60 px-3 py-2 text-xs text-graphite">
          Templates marked “planned” aren't wired to a trigger yet — previews still render once the template exists in email-templates.ts.
        </p>
      </aside>

      {/* ── Main pane ── */}
      <div className="min-w-0 space-y-5">
        <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="font-display text-xl font-bold">{spec.displayName}</h2>
              <p className="mt-1 text-sm text-graphite">{spec.description}</p>
              <p className="mt-1 text-xs font-semibold text-silver">Trigger: {spec.triggerNote}</p>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex rounded-full border border-mist p-0.5 text-xs font-extrabold">
                {(Object.keys(WIDTHS) as (keyof typeof WIDTHS)[]).map((w) => (
                  <button key={w} type="button" onClick={() => setWidth(w)}
                    className={`rounded-full px-3 py-1 ${width === w ? "bg-ink text-white" : "text-graphite"}`}>
                    {w === "desktop" ? "Desktop" : "Mobile"}
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => setDark((d) => !d)}
                className={`rounded-full border px-3 py-1 text-xs font-extrabold ${dark ? "border-ink bg-ink text-white" : "border-mist bg-white text-graphite"}`}>
                {dark ? "Dark preview" : "Light preview"}
              </button>
            </div>
          </div>

          {preview && !preview.available ? (
            <div className="mt-5 rounded-xl border border-dashed border-silver/60 bg-mist/30 p-8 text-center">
              <p className="font-display text-lg font-bold">Template not yet available</p>
              <p className="mx-auto mt-2 max-w-md text-sm text-graphite">
                <code className="rounded bg-mist px-1.5 py-0.5 text-xs">{spec.name}</code> isn't in the email renderer yet
                {preview.error ? <> — <code className="text-xs">{preview.error}</code></> : null}. This card fills in automatically once the template lands.
              </p>
            </div>
          ) : (
            <div className="mt-5">
              <div className="mb-3 flex items-center gap-2 text-xs font-bold">
                <button type="button" onClick={() => setTab("preview")} className={`rounded-full px-3 py-1 ${tab === "preview" ? "bg-ink text-white" : "bg-mist text-graphite"}`}>Preview</button>
                <button type="button" onClick={() => setTab("text")} className={`rounded-full px-3 py-1 ${tab === "text" ? "bg-ink text-white" : "bg-mist text-graphite"}`}>Plain text</button>
                {preview?.subject && <span className="ml-auto truncate text-graphite">Subject: <span className="font-extrabold text-ink">{preview.subject}</span></span>}
              </div>
              {tab === "preview" ? (
                <div className={`overflow-x-auto rounded-xl p-4 transition-colors ${dark ? "bg-[#0d130e]" : "bg-mist/50"}`}>
                  {dark && (
                    <p className="mb-3 text-xs font-semibold text-white/60">
                      Dark appearance is only a preview aid — email clients render dark mode differently and templates aren't forced.
                    </p>
                  )}
                  {loading && !preview?.html ? (
                    <p className="py-16 text-center text-sm text-graphite">Rendering…</p>
                  ) : preview?.html ? (
                    <iframe
                      title={`Preview of ${spec.displayName}`}
                      sandbox=""
                      srcDoc={preview.html}
                      style={{ width: WIDTHS[width], maxWidth: "100%", height: 640, border: "none", background: "#fff", borderRadius: 12 }}
                    />
                  ) : null}
                </div>
              ) : (
                <pre className="max-h-[560px] overflow-auto whitespace-pre-wrap rounded-xl bg-mist/50 p-4 text-xs leading-relaxed text-ink">
                  {preview?.text ?? "No text fallback yet."}
                </pre>
              )}
              {tab === "text" && (
                <p className="mt-2 text-xs text-graphite">
                  Derived from the HTML — there's no dedicated plain-text template yet. Vars shown in italics below are documented for the text version.
                </p>
              )}
            </div>
          )}
        </section>

        {/* ── Variables + test send ── */}
        <div className="grid gap-5 lg:grid-cols-2">
          <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
            <h3 className="font-display text-lg font-bold">Variables</h3>
            <p className="mt-1 text-xs text-graphite">Edit sample values — the preview re-renders automatically.</p>
            <div className="mt-4 max-h-[26rem] space-y-3 overflow-y-auto pr-1">
              {varKeys.map((k) => (
                <label key={k} className="block">
                  <span className="mb-1 flex items-center justify-between text-xs font-bold">
                    <code className="rounded bg-mist px-1.5 py-0.5">{`{{${k}}}`}</code>
                    {spec.textVars.includes(k) && <span className="text-[10px] font-semibold uppercase tracking-wide text-silver">text</span>}
                  </span>
                  <input
                    value={vars[k] ?? ""}
                    onChange={(e) => setVars((v) => ({ ...v, [k]: e.target.value }))}
                    className="min-h-9 w-full rounded-lg border border-silver/60 px-3 text-sm"
                    spellCheck={false}
                  />
                </label>
              ))}
              {varKeys.length === 0 && <p className="text-sm text-graphite">This template takes no variables.</p>}
            </div>
          </section>

          <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
            <h3 className="font-display text-lg font-bold">Test send</h3>
            <p className="mt-1 text-xs text-graphite">
              Sends “[TEST] {preview?.subject ?? spec.subject}” to a staff address only — customer emails are rejected.
              {!mailerConfigured && <span className="mt-1 block font-bold text-gold-700">Email delivery isn't configured — the test queues in the outbox.</span>}
            </p>
            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs font-bold">Recipient (staff only)</span>
                <select value={sendTo} onChange={(e) => setSendTo(e.target.value)} className="min-h-10 w-full rounded-lg border border-silver/70 px-3 text-sm">
                  {staffRecipients.length === 0 && <option value="">No staff profiles found</option>}
                  {staffRecipients.map((r) => (
                    <option key={r.email} value={r.email}>{r.name} — {r.email} ({r.role})</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-bold">Sender identity</span>
                <select value={sendSender} onChange={(e) => setSendSender(e.target.value)} className="min-h-10 w-full rounded-lg border border-silver/70 px-3 text-sm">
                  <option value="auto">Automatic — template&apos;s natural sender</option>
                  {senderOptions.map((s) => (
                    <option key={s.id} value={s.id}>{s.name} — {s.email}</option>
                  ))}
                </select>
                <span className="mt-1 block text-[11px] text-silver">Overrides the From/Reply-To on this test send only.</span>
              </label>
              <button
                type="button"
                onClick={sendTest}
                disabled={sending || !sendTo || !preview?.available}
                className="min-h-10 rounded-full bg-ink px-5 text-sm font-bold text-white disabled:opacity-40"
              >
                {sending ? "Sending…" : "Send test email"}
              </button>
              {sendResult && (
                <p className={`rounded-xl px-3 py-2 text-sm font-bold ${sendResult.ok ? "bg-lime/60 text-ink" : "bg-red-50 text-red-700"}`}>
                  {sendResult.msg}
                </p>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
      )}
    </div>
  );
}
