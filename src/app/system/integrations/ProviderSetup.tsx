import { DEPLOY_PROVIDERS, providerSetupView, writeCapabilityBadge } from "@/lib/system/deploy-verify";

/**
 * Deploy-provider setup & permission visibility for /system/integrations.
 * Server-rendered from module memory + env gates only — NO network calls on
 * page load. Live scope data appears after a verify run (Deployment Center
 * verify endpoint or the per-row "run check" button, which now returns the
 * verification object for github/vercel).
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

const PROVIDER_NAME: Record<string, string> = { github: "GitHub", vercel: "Vercel" };

export function ProviderSetup() {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="font-display text-xl font-bold tracking-tight">Deploy provider setup &amp; permissions</h2>
        <p className="mt-1 max-w-3xl text-xs text-slate-400">
          Configuration guidance and permission-scope visibility for the deployment providers.
          Scope names and token identities (user/team id + slug) are metadata, not secrets — token
          values are never read into this page. Read-only probes NEVER imply write access; write
          capability is reported honestly as proven / unverified / none.
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {DEPLOY_PROVIDERS.map((id) => {
          const v = providerSetupView(id);
          const ver = v.verification;
          const write = writeCapabilityBadge(ver?.writeCapability);
          const perms = ver?.permissions ?? null;
          return (
            <div key={id} className="rounded-2xl border border-white/[0.08] bg-white/[0.04] p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-bold">{PROVIDER_NAME[id] ?? id}</h3>
                <div className="flex flex-wrap gap-1.5">
                  {ver ? (
                    <Badge tone={ver.verified ? "ok" : ver.configured ? "warn" : "muted"}>
                      {ver.verified ? "read: verified" : ver.configured ? "read: failed" : "unconfigured"}
                    </Badge>
                  ) : (
                    <Badge tone="muted">no check this instance</Badge>
                  )}
                  <Badge tone={write.tone}>{write.label}</Badge>
                </div>
              </div>

              {/* Env vars — names + presence only */}
              <div className="mt-3">
                <p className="font-mono text-[10px] uppercase tracking-wider text-slate-500">env vars</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {v.guide.envVars.map((name) => {
                    const required = v.guide.requiredEnv.includes(name);
                    const present = Boolean(process.env[name]);
                    return (
                      <span
                        key={name}
                        className={`rounded px-1.5 py-0.5 font-mono text-[10px] ring-1 ${
                          present
                            ? "bg-lime/10 text-lime ring-lime/25"
                            : required
                              ? "bg-red-500/10 text-red-300 ring-red-400/25"
                              : "bg-white/5 text-slate-500 ring-white/10"
                        }`}
                        title={required ? "required" : "optional"}
                      >
                        {name}{required ? "*" : ""}
                      </span>
                    );
                  })}
                </div>
                {v.readiness.missing.length > 0 && (
                  <p className="mt-1 font-mono text-[10px] text-red-300">missing: {v.readiness.missing.join(", ")}</p>
                )}
              </div>

              {/* Verified state + last check */}
              {ver && (
                <div className="mt-3 space-y-1 text-[11px] text-slate-400">
                  <p>
                    last check: <span className="font-mono">{ver.checkedAt}</span>
                    {ver.latencyMs != null ? ` · ${ver.latencyMs}ms` : ""}
                    {ver.lastSuccessAt ? ` · last success ${ver.lastSuccessAt}` : ""}
                  </p>
                  {ver.capabilities.length > 0 && (
                    <p>
                      read proven: <span className="font-mono text-slate-300">{ver.capabilities.join(", ")}</span>
                    </p>
                  )}
                  {perms && perms.identity && (
                    <p>
                      token identity: <span className="font-mono text-slate-300">
                        {perms.identity.kind}{perms.identity.label ? ` · ${perms.identity.label}` : ""}
                        {perms.identity.id ? ` (${perms.identity.id})` : ""}
                        {perms.identity.count ? ` · ${perms.identity.count} teams` : ""}
                      </span>
                    </p>
                  )}
                  {perms && perms.grantedScopes.length > 0 && (
                    <div>
                      <p className="text-slate-500">granted scopes:</p>
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {perms.grantedScopes.map((s) => (
                          <span key={s} className="rounded bg-sky-400/10 px-1.5 py-0.5 font-mono text-[10px] text-sky-300 ring-1 ring-sky-400/25">{s}</span>
                        ))}
                      </div>
                      {perms.scopeLabels.length > 0 && (
                        <p className="mt-1 text-slate-500">{perms.scopeLabels.join(" · ")}</p>
                      )}
                    </div>
                  )}
                  {perms?.acceptedScopes && perms.acceptedScopes.length > 0 && (
                    <p className="text-slate-500">endpoint-required scopes: {perms.acceptedScopes.join(", ")}</p>
                  )}
                  {perms?.note && <p className="text-amber-200/80">{perms.note}</p>}
                  {ver.lastFailure && !ver.verified && (
                    <p className="text-red-300/80">last failure: {ver.lastFailure}</p>
                  )}
                </div>
              )}
              {!ver && (
                <p className="mt-3 text-[11px] text-slate-500">
                  No live verification recorded in this instance. Run a check via the table above
                  (deploy providers return scope detail) or the Deployment Center verify endpoint.
                </p>
              )}

              {/* Required action when not usable */}
              {ver?.requiredAction && (
                <p className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/[0.05] px-3 py-2 text-[11px] leading-relaxed text-amber-200">
                  <span className="font-bold">Required action: </span>{ver.requiredAction}
                </p>
              )}
              {!ver?.requiredAction && !v.readiness.configured && (
                <p className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/[0.05] px-3 py-2 text-[11px] leading-relaxed text-amber-200">
                  <span className="font-bold">Required action: </span>{v.readiness.requiredAction}
                </p>
              )}

              {/* Setup guidance */}
              <div className="mt-3 space-y-2 text-[11px] leading-relaxed text-slate-400">
                <p><span className="font-bold text-slate-300">Token setup: </span>{v.guide.tokenSetup}</p>
                <p><span className="font-bold text-slate-300">Recommended scopes: </span>{v.guide.recommendedScopes}</p>
                <p><span className="font-bold text-slate-300">Write path: </span>{v.guide.writePath}</p>
                <p>
                  Docs:{" "}
                  {v.guide.docs.map((d, i) => (
                    <span key={d.url}>
                      {i > 0 && " · "}
                      <a href={d.url} target="_blank" rel="noreferrer" className="text-lime underline">{d.label}</a>
                    </span>
                  ))}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
