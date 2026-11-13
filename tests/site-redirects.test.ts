import { afterEach, describe, expect, it, vi } from "vitest";
import { siteKeyForHost } from "@/lib/subdomains";
import {
  buildRedirectIndex,
  clearSiteRedirectCache,
  getRedirectFor,
  matchRedirect,
  normalizePath,
  validateRedirectTarget,
  type RedirectRule,
} from "@/lib/site-redirects";

const rule = (site_key: string, from_path: string, to_path: string): RedirectRule => ({ site_key, from_path, to_path });
const idx = (rules: RedirectRule[]) => buildRedirectIndex(rules);

afterEach(() => {
  clearSiteRedirectCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/* ── host → site_key ─────────────────────────────────────────────────────── */

describe("siteKeyForHost", () => {
  it("maps apex, www and bare domain to 'apex'", () => {
    expect(siteKeyForHost("zapnivo.com")).toBe("apex");
    expect(siteKeyForHost("www.zapnivo.com")).toBe("apex");
    expect(siteKeyForHost("WWW.ZapNivo.com:443")).toBe("apex");
  });
  it("maps each subdomain to its site_key", () => {
    for (const s of ["support", "internal", "partners", "customer", "system", "api"] as const) {
      expect(siteKeyForHost(`${s}.zapnivo.com`)).toBe(s);
      expect(siteKeyForHost(`${s}.localhost:3000`)).toBe(s);
    }
  });
  it("maps local dev hosts to 'apex' and unknown hosts to null", () => {
    expect(siteKeyForHost("localhost:3000")).toBe("apex");
    expect(siteKeyForHost("127.0.0.1:3000")).toBe("apex");
    expect(siteKeyForHost("foo.localhost:3000")).toBe("apex");
    expect(siteKeyForHost("preview-123.vercel.app")).toBeNull();
    expect(siteKeyForHost("evil-zapnivo.com")).toBeNull();
    expect(siteKeyForHost("zapnivo.com.evil.com")).toBeNull();
  });
});

/* ── target re-validation at read ────────────────────────────────────────── */

describe("validateRedirectTarget", () => {
  it("accepts relative paths and approved-host https URLs", () => {
    expect(validateRedirectTarget("/new-place")).toBe("/new-place");
    expect(validateRedirectTarget("/a/b?x=1#f")).toBe("/a/b?x=1#f");
    expect(validateRedirectTarget("https://zapnivo.com/pricing")).toBe("https://zapnivo.com/pricing");
    expect(validateRedirectTarget("https://partners.zapnivo.com/portal")).toBe("https://partners.zapnivo.com/portal");
    expect(validateRedirectTarget("http://localhost:3000/x")).toBe("http://localhost:3000/x");
  });
  it("rejects external hosts, http non-local, and junk", () => {
    for (const v of [
      "https://evil.com/x",
      "https://zapnivo.com.evil.com/x",
      "http://zapnivo.com/x",
      "javascript:alert(1)",
      "//evil.com/x",
      "/has space",
      "/a/../b",
      "",
      42,
      null,
    ]) {
      expect(validateRedirectTarget(v), JSON.stringify(v)).toBeNull();
    }
  });
});

/* ── matching ────────────────────────────────────────────────────────────── */

describe("matchRedirect", () => {
  const index = idx([
    rule("apex", "/old-page", "/new-page"),
    rule("apex", "/trail/", "/target"),
    rule("support", "/help-old", "/help-new"),
    rule("apex", "/chain-a", "/chain-b"),
    rule("apex", "/chain-b", "/final"),
    rule("apex", "/loop-a", "/loop-b"),
    rule("apex", "/loop-b", "/loop-a"),
    rule("apex", "/self", "/self"),
    rule("apex", "/abs", "https://partners.zapnivo.com/portal"),
    rule("apex", "/with-query", "/dest?from=old"),
    rule("apex", "/drop-me", "https://evil.com/x"),
  ]);

  it("matches exact path per site_key only", () => {
    expect(matchRedirect(index, "apex", "/old-page")).toBe("/new-page");
    expect(matchRedirect(index, "apex", "/help-old")).toBeNull();
    expect(matchRedirect(index, "support", "/help-old")).toBe("/help-new");
    expect(matchRedirect(index, "support", "/old-page")).toBeNull();
  });

  it("normalizes trailing slashes and ignores query on the request path", () => {
    expect(matchRedirect(index, "apex", "/trail")).toBe("/target");
    expect(matchRedirect(index, "apex", "/trail/")).toBe("/target");
    expect(matchRedirect(index, "apex", "/old-page?utm=x")).toBe("/new-page");
    expect(normalizePath("/a/b/?q=1")).toBe("/a/b");
  });

  it("never redirects protected paths", () => {
    const protectedIndex = idx([
      rule("apex", "/api/health", "/x"),
      rule("apex", "/api", "/x"),
      rule("apex", "/_next/data", "/x"),
      rule("apex", "/.well-known/security.txt", "/x"),
      rule("apex", "/login", "/x"),
      rule("apex", "/login/callback", "/x"),
      rule("apex", "/file.pdf", "/x"),
      rule("system", "/security", "/x"),
      rule("system", "/keys", "/x"),
    ]);
    for (const p of ["/api/health", "/api", "/_next/data", "/.well-known/security.txt", "/login", "/login/callback", "/file.pdf"]) {
      expect(matchRedirect(protectedIndex, "apex", p), p).toBeNull();
    }
    expect(matchRedirect(protectedIndex, "system", "/security")).toBeNull();
    expect(matchRedirect(protectedIndex, "system", "/keys")).toBeNull();
    // ...but the same public path is fine on a non-system site
    expect(matchRedirect(idx([rule("support", "/security", "/safe")]), "support", "/security")).toBe("/safe");
  });

  it("follows relative chains up to the hop limit", () => {
    expect(matchRedirect(index, "apex", "/chain-a")).toBe("/final"); // /chain-a→/chain-b→/final (2 hops)
  });

  it("skips chains longer than the hop limit and loops", () => {
    const long = idx([
      rule("apex", "/a", "/b"),
      rule("apex", "/b", "/c"),
      rule("apex", "/c", "/d"),
    ]);
    expect(matchRedirect(long, "apex", "/a")).toBeNull(); // would need 3 hops
    expect(matchRedirect(index, "apex", "/loop-a")).toBeNull();
    expect(matchRedirect(index, "apex", "/self")).toBeNull();
  });

  it("returns absolute approved-host targets verbatim and keeps their query", () => {
    expect(matchRedirect(index, "apex", "/abs")).toBe("https://partners.zapnivo.com/portal");
    expect(matchRedirect(index, "apex", "/with-query")).toBe("/dest?from=old");
  });

  it("drops rules whose to_path fails read-side validation", () => {
    expect(matchRedirect(index, "apex", "/drop-me")).toBeNull();
    const bad = idx([rule("apex", "/x", "https://evil.com"), rule("apex", "/y", "javascript:alert(1)")]);
    expect(matchRedirect(bad, "apex", "/x")).toBeNull();
    expect(matchRedirect(bad, "apex", "/y")).toBeNull();
  });
});

/* ── cached loader / getRedirectFor ──────────────────────────────────────── */

describe("getRedirectFor", () => {
  const ENV = {
    NEXT_PUBLIC_SUPABASE_URL: "https://db.example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  };

  function stubFetch(rows: unknown, ok = true) {
    const spy = vi.fn(async () =>
      ok
        ? new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } })
        : new Response("err", { status: 500 }),
    );
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  it("returns null without backend env or for unmappable hosts", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(await getRedirectFor("zapnivo.com", "/old-page")).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", ENV.NEXT_PUBLIC_SUPABASE_URL);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", ENV.SUPABASE_SERVICE_ROLE_KEY);
    stubFetch([rule("apex", "/old-page", "/new-page")]);
    expect(await getRedirectFor("preview.vercel.app", "/old-page")).toBeNull();
  });

  it("fetches enabled rules once, caches ~60s, matches per host", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", ENV.NEXT_PUBLIC_SUPABASE_URL);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", ENV.SUPABASE_SERVICE_ROLE_KEY);
    const spy = stubFetch([
      rule("apex", "/old-page", "/new-page"),
      rule("support", "/old-page", "/support-new"),
    ]);
    expect(await getRedirectFor("www.zapnivo.com", "/old-page")).toBe("/new-page");
    expect(await getRedirectFor("support.zapnivo.com", "/old-page")).toBe("/support-new");
    expect(await getRedirectFor("internal.zapnivo.com", "/old-page")).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1); // second call served from cache
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/rest/v1/site_redirects");
    expect(url).toContain("enabled=eq.true");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer service-key");
  });

  it("serves stale cache when the backend fails", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", ENV.NEXT_PUBLIC_SUPABASE_URL);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", ENV.SUPABASE_SERVICE_ROLE_KEY);
    stubFetch([rule("apex", "/old-page", "/new-page")]);
    expect(await getRedirectFor("zapnivo.com", "/old-page")).toBe("/new-page");
    stubFetch([], false); // backend now 500s
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 120_000); // past TTL → refetch attempted → fails → stale served
      expect(await getRedirectFor("zapnivo.com", "/old-page")).toBe("/new-page");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never redirects protected paths even when a rule exists", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", ENV.NEXT_PUBLIC_SUPABASE_URL);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", ENV.SUPABASE_SERVICE_ROLE_KEY);
    stubFetch([rule("apex", "/login", "/home"), rule("apex", "/api/x", "/home")]);
    expect(await getRedirectFor("zapnivo.com", "/login")).toBeNull();
    expect(await getRedirectFor("zapnivo.com", "/api/x")).toBeNull();
  });
});
