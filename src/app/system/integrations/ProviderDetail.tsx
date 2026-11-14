import type { IntegrationDetail } from "@/lib/system/integration-detail";

/**
 * Per-provider operational detail panel for /system/integrations?provider=<id>.
 * Server-rendered from getIntegrationDetail — names/booleans/timestamps only,
 * never secret values. 'verified' states come only from real check evidence.
 */

const TONE: Record<string, string> = {
  ok: "bg-lime/15 text-lime ring-lime/30",
  warn: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  muted: "bg-white/10 text-slate-300 ring-white/15",
  bad: "bg-red-500/15 text-red-300 ring-red-400/30",
};

function Badge({ tone, children }: { tone: keyof typeof TONE; children: React.ReactNode }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${TONE[tone]}`}>
      {children}
    </span>
  );
}

const READ_TONE: Record<string, { tone: keyof typeof TONE; label: string }> = {
  verified: { tone: "ok", label: "read: verified" },
  failed: { tone: "bad", label: "read: failed" },
  unverified: { tone: "warn", label: "read: unverified" },
  not_run: { tone: "muted", label: "read: not checked" },
};

const WRITE_TONE: Record<string, { tone: keyof typeof TONE; label: string }> = {
  proven: { tone: "ok", label: "write: proven" },
  unverified: { tone: "warn", label: "write: unverified" },
  none: { tone: "muted", label: "write: none" },
};

function fmt(ts: string | null): string {
  if (!ts) return "never";
  return `${new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" })}Z`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{title}</p>
      <div className="mt-1.5 text-[11px] leading-relaxed text-slate-300">{children}</div>
    </div>
  );
}

export function ProviderDetail({ detail }: { detail: IntegrationDetail }) {
  const p = detail.provider;
  const read = READ_TONE[detail.readAuth.status] ?? READ_TONE.not_run;
  const write = WRITE_TONE[detail.writeAuth.status] ?? WRITE_TONE.unverified;

  return (
    <section className="space-y-4 rounded-2xl border border-lime/20 bg-lime/[0.03] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-bold tracking-tight">
            {p.name} <span className="font-mono text-xs font-normal text-slate-500">{p.id}</span>
          </h2>
          <p className="mt-0.5 max-w-2xl text-xs text-slate-400">{p.purpose}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={p.configured ? "ok" : "muted"}>{p.configured ? "configured" : "unconfigured"}</Badge>
          <Badge tone={read.tone}>{read.label}</Badge>
          <Badge tone={write.tone}>{write.label}</Badge>
        </div>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        {/* Env presence */}
        <Section title="configuration — env vars (names + presence only)">
          <div className="flex flex-wrap gap-1">
            {p.envVars.length === 0 && <span className="text-slate-500">none required</span>}
            {p.envPresence.map((v) => (
              <span
                key={v.name}
                className={`rounded px-1.5 py-0.5 font-mono text-[10px] ring-1 ${
                  v.set
                    ? "bg-lime/10 text-lime ring-lime/25"
                    : "bg-red-500/10 text-red-300 ring-red-400/25"
                }`}
              >
                {v.name}
              </span>
            ))}
          </div>
          {detail.missingSettings.length > 0 && (
            <p className="mt-2 text-red-300">missing required: <span className="font-mono">{detail.missingSettings.join(", ")}</span></p>
          )}
          {detail.optionalMissing.length > 0 && (
            <p className="mt-1 text-slate-500">optional unset: <span className="font-mono">{detail.optionalMissing.join(", ")}</span></p>
          )}
          {detail.missingSettings.length === 0 && (
            <p className="mt-2 text-lime/80">all required env vars present</p>
          )}
        </Section>

        {/* Authorization evidence */}
        <Section title="authorization evidence">
          <p>
            read check:{" "}
            <span className="font-mono">{detail.readAuth.status}</span>
            {detail.readAuth.checkedAt && <> · {fmt(detail.readAuth.checkedAt)}</>}
            {detail.readAuth.latencyMs != null && <> · {detail.readAuth.latencyMs}ms</>}
          </p>
          {detail.readAuth.evidence && (
            <p className="mt-1 text-slate-400">{detail.readAuth.evidence}</p>
          )}
          <p className="mt-2">
            write: <span className="font-mono">{detail.writeAuth.status}</span>
            {detail.writeAuth.writeCapability && detail.writeAuth.writeCapability !== detail.writeAuth.status && (
              <> (last verification: <span className="font-mono">{detail.writeAuth.writeCapability}</span>)</>
            )}
          </p>
          <p className="mt-1 text-slate-400">{detail.writeAuth.note}</p>
        </Section>

        {/* Capabilities */}
        <Section title="available capabilities">
          {detail.capabilities.length === 0 ? (
            <p className="text-slate-500">none declared</p>
          ) : (
            <ul className="list-disc space-y-1 pl-4">
              {detail.capabilities.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
          {detail.adapter && (
            <div className="mt-2 space-y-1 border-t border-white/[0.06] pt-2">
              <p>
                kiosk adapter: <span className="font-mono">{detail.adapter.adapter}</span>{" "}
                {detail.adapter.certified
                  ? <span className="text-lime">certified</span>
                  : <span className="text-amber-300">not certified</span>}
              </p>
              {detail.adapter.capabilities.length > 0 && (
                <p className="font-mono text-slate-400">capabilities: {detail.adapter.capabilities.join(", ")}</p>
              )}
              <p className="text-slate-500">
                outbound control stays blocked until a vendor adapter passes the certification
                checklist (<span className="font-mono">{detail.adapter.checklist}</span>).
              </p>
            </div>
          )}
        </Section>

        {/* Webhook state */}
        <Section title="webhook / inbound events">
          {detail.webhook.applicable ? (
            <div className="space-y-1">
              <p>endpoint: <span className="font-mono text-slate-200">{detail.webhook.endpoint}</span></p>
              {detail.webhook.secretEnv && (
                <p>
                  secret: <span className="font-mono">{detail.webhook.secretEnv}</span>{" "}
                  {detail.webhook.secretSet
                    ? <span className="text-lime">set</span>
                    : <span className="text-red-300">MISSING</span>}
                </p>
              )}
              {!detail.webhook.secretEnv && detail.webhook.description && (
                <p className="text-slate-500">{detail.webhook.description}</p>
              )}
              <p>last event: <span className="font-mono">{fmt(detail.webhook.lastEventAt)}</span></p>
              <p>last success: <span className="font-mono">{fmt(detail.webhook.lastSuccessAt)}</span></p>
              {detail.webhook.failures24h != null && (
                <p>failures (24h): <span className="font-mono">{detail.webhook.failures24h}</span></p>
              )}
              {detail.webhook.note && <p className="text-slate-500">{detail.webhook.note}</p>}
            </div>
          ) : (
            <p className="text-slate-500">{detail.webhook.note ?? "no inbound webhook surface"}</p>
          )}
        </Section>

        {/* Last operation */}
        <Section title="last successful operation">
          {detail.lastOperation ? (
            <div className="space-y-1">
              <p>{detail.lastOperation.label}</p>
              <p className="font-mono text-slate-400">
                {fmt(detail.lastOperation.at)} · src: {detail.lastOperation.table}
              </p>
            </div>
          ) : (
            <p className="text-slate-500">no discrete operation signal — activity is continuous or audited elsewhere</p>
          )}
        </Section>
      </div>

      {/* Guidance */}
      <div className="grid gap-5 border-t border-white/[0.06] pt-4 md:grid-cols-2">
        <Section title="required permissions / scopes">
          <p>{detail.requiredPermissions}</p>
        </Section>
        <Section title="owner action required">
          <ul className="list-disc space-y-1 pl-4">
            {detail.requiredAction.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </Section>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4 border-t border-white/[0.06] pt-4">
        <div className="max-w-xl">
          <p className="font-mono text-[10px] uppercase tracking-wider text-slate-500">credentials (rotation metadata)</p>
          {detail.secrets.length === 0 ? (
            <p className="mt-1.5 text-[11px] text-slate-500">no registry entries for this provider</p>
          ) : (
            <ul className="mt-1.5 space-y-1.5">
              {detail.secrets.map((s) => (
                <li key={s.envVar} className="text-[11px] text-slate-400">
                  <span className="font-mono text-slate-200">{s.envVar}</span>
                  {" — "}{s.purpose}
                  <span className="block text-slate-500">rotate: {s.rotation}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {detail.docs.length > 0 && (
          <div>
            <p className="font-mono text-[10px] uppercase tracking-wider text-slate-500">documentation</p>
            <p className="mt-1.5 text-[11px]">
              {detail.docs.map((d, i) => (
                <span key={d.url}>
                  {i > 0 && " · "}
                  <a href={d.url} target="_blank" rel="noreferrer" className="text-lime underline">{d.label}</a>
                </span>
              ))}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
