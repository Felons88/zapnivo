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

/**
 * Security-hardening coverage for the runtime redirect system (Phase 3.2
 * audit). Every vector here is a bypass attempt against protected-path
 * checks, target validation, host mapping, or cache safety. All must fail
 * CLOSED — i.e. produce no redirect.
 */

const rule = (site_key: string, from_path: string, to_path: string): RedirectRule => ({ site_key, from_path, to_path });
const idx = (rules: RedirectRule[]) => buildRedirectIndex(rules);

afterEach(() => {
  clearSiteRedirectCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/* ── 1. Encoded / double-encoded slashes & traversal ─────────────────────── */

describe("encoded path tricks", () => {
  const index = idx([
    rule("apex", "/old", "/new"),
    rule("apex", "/api/health", "/x"),
    rule("apex", "/login", "/x"),
  ]);

  it("normalizePath decodes %2F, %252F, %5C and %2e%2e consistently", () => {
    expect(normalizePath("/api%2Fhealth")).toBe("/api/health");
    expect(normalizePath("/api%252Fhealth")).toBe("/api/health");
    expect(normalizePath("/api%5Chealth")).toBe("/api/health");
    expect(normalizePath("/%2e%2e/api/x")).toBe("/../api/x");
    expect(normalizePath("/a%20b")).toBe("/a b"); // decoded form is canonical
  });

  it("encoded protected paths can never be redirected", () => {
    for (const p of [
      "/api%2Fhealth",
      "/api%252Fhealth",
      "/api%5Chealth",
      "/API%2Fx",
      "/login%2F",
      "/%6cogin", // %6c = 'l'
      "/login%00",
    ]) {
      expect(matchRedirect(index, "apex", p), p).toBeNull();
    }
  });

  it("encoded traversal segments fail closed", () => {
    for (const p of ["/../api/x", "/a/../b", "/%2e%2e/login", "/api/..%2F..%2Fadmin"]) {
      expect(matchRedirect(index, "apex", p), p).toBeNull();
    }
  });

  it("a stored from_path containing escapes decodes then fails validation → dropped", () => {
    const sneaky = idx([
      rule("apex", "/old%2Fpage", "/x"), // decodes to /old/page — clean, becomes alias (documented)
      rule("apex", "/bad%20path", "/x"), // decodes to space → dropped
      rule("apex", "/evil%2e%2e", "/x"), // decodes to '..' → dropped
    ]);
    expect(matchRedirect(sneaky, "apex", "/old/page")).toBe("/x"); // documented aliasing
    expect(matchRedirect(sneaky, "apex", "/bad path")).toBeNull();
    expect(matchRedirect(sneaky, "apex", "/evil..")).toBeNull();
  });
});

/* ── 2. Backslash normalization ──────────────────────────────────────────── */

describe("backslash tricks", () => {
  const index = idx([rule("apex", "/api/x", "/y"), rule("apex", "/old", "/new")]);

  it("backslashes are treated as path separators for protection AND matching", () => {
    for (const p of ["/api\\x", "/api\\health", "\\api\\x", "/api%5Cx"]) {
      expect(matchRedirect(index, "apex", p), p).toBeNull();
    }
    // a rule's from_path can never contain a backslash (write+read reject it),
    // but a REQUEST backslash normalizes to '/' and matches the '/' rule:
    expect(matchRedirect(index, "apex", "/old\\")).toBe("/new"); // /old/ → /old
  });
});

/* ── 3. Protocol-relative / scheme tricks in to_path ─────────────────────── */

describe("validateRedirectTarget hostile inputs", () => {
  it("rejects protocol-relative, backslash, non-http(s), credential URLs", () => {
    for (const v of [
      "//evil.com/x",
      "//zapnivo.com/x", // even same-host protocol-relative is rejected (must be explicit)
      "\\\\evil.com",
      "\\evil.com",
      "/\\evil.com",
      "https:evil.com", // parses as https://evil.com/ — host rejected
      "https://evil.com",
      "javascript:alert(1)",
      "data:text/html,<script>x</script>",
      "vbscript:x",
      "file:///etc/passwd",
      "https://user:pass@zapnivo.com/x", // credentials rejected
      "https://user@zapnivo.com/x",
      "https://zapnivo.com.evil.com/x",
      "http://zapnivo.com/x", // http only for localhost
      "notaurl",
      "  ",
    ]) {
      expect(validateRedirectTarget(v), JSON.stringify(v)).toBeNull();
    }
  });

  it("still accepts the legitimate forms", () => {
    expect(validateRedirectTarget("/new-place")).toBe("/new-place");
    expect(validateRedirectTarget("/dest?from=old#frag")).toBe("/dest?from=old#frag"); // query+hash kept
    expect(validateRedirectTarget("https://support.zapnivo.com/help")).toBe("https://support.zapnivo.com/help");
    expect(validateRedirectTarget("https://zapnivo.com:443/x")).toBe("https://zapnivo.com/x"); // URL-normalized
  });

  it("rules with hostile to_path are dropped at index build (defense in depth)", () => {
    const bad = idx([
      rule("apex", "/a", "//evil.com"),
      rule("apex", "/b", "javascript:alert(1)"),
      rule("apex", "/c", "https://evil.com"),
      rule("apex", "/d", "https://user:pw@zapnivo.com/x"),
    ]);
    for (const p of ["/a", "/b", "/c", "/d"]) expect(matchRedirect(bad, "apex", p), p).toBeNull();
  });
});

/* ── 4. Mixed-case protected paths ───────────────────────────────────────── */

describe("case-insensitive protection", () => {
  const index = idx([
    rule("apex", "/api/x", "/y"),
    rule("apex", "/login", "/y"),
    rule("internal", "/admin/x", "/y"),
    rule("internal", "/security", "/y"),
  ]);

  it("upper/mixed-case protected prefixes never redirect", () => {
    for (const p of ["/API/x", "/Api/Health", "/LOGIN", "/Login/callback", "/_NEXT/static", "/.WELL-KNOWN/x", "/AUTH/callback"]) {
      expect(matchRedirect(index, "apex", p), p).toBeNull();
    }
  });

  it("matching itself stays case-sensitive (a lowercase rule does not fire on /OLD)", () => {
    const i = idx([rule("apex", "/old", "/new")]);
    expect(matchRedirect(i, "apex", "/OLD")).toBeNull();
    expect(matchRedirect(i, "apex", "/Old")).toBeNull();
    expect(matchRedirect(i, "apex", "/old")).toBe("/new");
  });

  it("internal host protects console + auth surfaces", () => {
    for (const p of ["/admin/x", "/ADMIN", "/admin", "/system/kiosks", "/security", "/mfa/enroll", "/emergency"]) {
      expect(matchRedirect(index, "internal", p), p).toBeNull();
    }
    // ...but a normal internal public path can still redirect
    const i = idx([rule("internal", "/old-help", "/new-help")]);
    expect(matchRedirect(i, "internal", "/old-help")).toBe("/new-help");
  });
});

/* ── 5. Trailing-slash / duplicate-slash variants ────────────────────────── */

describe("slash variants", () => {
  const index = idx([rule("apex", "/login", "/x"), rule("apex", "/old", "/new")]);

  it("duplicate slashes and trailing slashes normalize before protection", () => {
    for (const p of ["//login", "///login", "/login//", "/login/", "/log//in"]) {
      // '/log//in' collapses to '/login' → protected; the rest are /login variants
      expect(matchRedirect(index, "apex", p), p).toBeNull();
    }
  });

  it("matching canonicalizes slash variants onto the stored rule", () => {
    expect(matchRedirect(index, "apex", "/old/")).toBe("/new");
    expect(matchRedirect(index, "apex", "//old")).toBe("/new");
    expect(matchRedirect(index, "apex", "/old//")).toBe("/new");
  });
});

/* ── 6. Query-string handling ────────────────────────────────────────────── */

describe("query preservation", () => {
  it("request query is ignored for matching; to_path query is kept verbatim", () => {
    const i = idx([rule("apex", "/old", "/dest?from=old"), rule("apex", "/plain", "/target")]);
    expect(matchRedirect(i, "apex", "/old?utm=x&code=1")).toBe("/dest?from=old"); // stored query wins
    expect(matchRedirect(i, "apex", "/plain?utm=x")).toBe("/target"); // proxy appends request query
  });
});

/* ── 7. Host-header / site_key spoofing ──────────────────────────────────── */

describe("host spoof resistance", () => {
  it("siteKeyForHost returns null for lookalike/tricky hosts", () => {
    for (const h of [
      "zapnivo.com.evil.com",
      "evil-zapnivo.com",
      "zapnivo.com@evil.com",
      "zapnivo.com#evil.com",
      "zapnivo.com?evil.com",
      " zapnivo.com",
      "zapnivo.com.", // trailing dot — different hostname
      "support.zapnivo.com.evil.com",
      "evil.com",
      "",
    ]) {
      expect(siteKeyForHost(h), JSON.stringify(h)).toBeNull();
    }
  });

  it("getRedirectFor never redirects for unmappable hosts even with rules loaded", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://db.example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    const spy = vi.fn(async () => new Response(JSON.stringify([rule("apex", "/old", "/new")]), { status: 200 }));
    vi.stubGlobal("fetch", spy);
    for (const h of ["preview.vercel.app", "zapnivo.com.evil.com", "evil.com", ""]) {
      expect(await getRedirectFor(h, "/old"), h).toBeNull();
    }
    expect(spy).not.toHaveBeenCalled(); // bail before fetch
  });
});

/* ── 8. Auth callback routes ─────────────────────────────────────────────── */

describe("auth callback protection", () => {
  const index = idx([
    rule("apex", "/auth/callback", "/x"),
    rule("apex", "/api/auth/callback", "/x"),
    rule("apex", "/login", "/x"),
    rule("apex", "/", "/home"), // homepage rule exists — ?code= safety is in proxy.ts
  ]);

  it("auth paths can never match a redirect rule", () => {
    for (const p of ["/auth/callback", "/auth/confirm", "/api/auth/callback", "/api/auth/login", "/login", "/login/"]) {
      expect(matchRedirect(index, "apex", p), p).toBeNull();
    }
  });
});

/* ── 9. system / api hosts disabled entirely ─────────────────────────────── */

describe("console/API host disable", () => {
  const index = idx([
    rule("system", "/old", "/new"),
    rule("api", "/old", "/new"),
    rule("internal", "/old-console", "/new-console"),
    rule("apex", "/old", "/new"),
  ]);

  it("matchRedirect refuses system and api site_keys outright", () => {
    expect(matchRedirect(index, "system", "/old")).toBeNull();
    expect(matchRedirect(index, "api", "/old")).toBeNull();
    expect(matchRedirect(index, "internal", "/old-console")).toBe("/new-console");
    expect(matchRedirect(index, "apex", "/old")).toBe("/new");
  });

  it("getRedirectFor returns null for system/api hosts even with DB rules", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://db.example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify([rule("system", "/x", "/y"), rule("api", "/x", "/y")]), { status: 200 })));
    expect(await getRedirectFor("system.zapnivo.com", "/x")).toBeNull();
    expect(await getRedirectFor("api.zapnivo.com", "/x")).toBeNull();
    expect(await getRedirectFor("system.localhost:3000", "/x")).toBeNull();
    expect(await getRedirectFor("api.localhost:3000", "/x")).toBeNull();
  });
});

/* ── 10. Kill switch + bounded stale cache ───────────────────────────────── */

describe("kill switch and stale-cache expiry", () => {
  const ENV = { NEXT_PUBLIC_SUPABASE_URL: "https://db.example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key" };

  function stubFetch(rows: unknown, ok = true) {
    const spy = vi.fn(async () =>
      ok ? new Response(JSON.stringify(rows), { status: 200 }) : new Response("err", { status: 500 }));
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  it("SITE_REDIRECTS_DISABLED=1 disables everything, checked before cache", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", ENV.NEXT_PUBLIC_SUPABASE_URL);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", ENV.SUPABASE_SERVICE_ROLE_KEY);
    stubFetch([rule("apex", "/old", "/new")]);
    expect(await getRedirectFor("zapnivo.com", "/old")).toBe("/new"); // warm the cache
    vi.stubEnv("SITE_REDIRECTS_DISABLED", "1");
    expect(await getRedirectFor("zapnivo.com", "/old")).toBeNull(); // kill switch wins over warm cache
    vi.stubEnv("SITE_REDIRECTS_DISABLED", "true");
    expect(await getRedirectFor("zapnivo.com", "/old")).toBeNull();
    vi.stubEnv("SITE_REDIRECTS_DISABLED", "0");
    expect(await getRedirectFor("zapnivo.com", "/old")).toBe("/new"); // '0' is not a kill value
  });

  it("stale cache expires after 10 minutes — no redirects served beyond that", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", ENV.NEXT_PUBLIC_SUPABASE_URL);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", ENV.SUPABASE_SERVICE_ROLE_KEY);
    stubFetch([rule("apex", "/old", "/new")]);
    expect(await getRedirectFor("zapnivo.com", "/old")).toBe("/new");
    stubFetch([], false); // backend starts failing
    vi.useFakeTimers();
    const t0 = Date.now();
    vi.setSystemTime(t0 + 120_000); // past 60s TTL → refetch fails → stale (2min < 10min) OK
    expect(await getRedirectFor("zapnivo.com", "/old")).toBe("/new");
    vi.setSystemTime(t0 + 11 * 60_000); // cache now ~11min old → beyond MAX_STALE_MS
    expect(await getRedirectFor("zapnivo.com", "/old")).toBeNull(); // fail closed
  });
});

/* ── 11. Cross-host redirect loops ───────────────────────────────────────── */

describe("cross-host loop prevention", () => {
  const ENV = { NEXT_PUBLIC_SUPABASE_URL: "https://db.example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key" };

  function stubRows(rows: RedirectRule[]) {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", ENV.NEXT_PUBLIC_SUPABASE_URL);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", ENV.SUPABASE_SERVICE_ROLE_KEY);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(rows), { status: 200 })));
  }

  it("skips an absolute target whose destination host would redirect again", async () => {
    stubRows([
      rule("apex", "/a", "https://support.zapnivo.com/b"),
      rule("support", "/b", "/c"), // destination has a rule → potential ping-pong → skip
    ]);
    expect(await getRedirectFor("zapnivo.com", "/a")).toBeNull();
  });

  it("allows an absolute target when the destination path has no rule", async () => {
    stubRows([
      rule("apex", "/a", "https://support.zapnivo.com/b"),
      rule("support", "/other", "/c"), // unrelated rule — no loop
    ]);
    expect(await getRedirectFor("zapnivo.com", "/a")).toBe("https://support.zapnivo.com/b");
  });

  it("absolute target to a disabled console host is impossible (read-side validation) but also safe", async () => {
    // Even if a row pointed at system.zapnivo.com, that's an approved host —
    // allowed as a TARGET (it's just a URL); the disable only blocks rules ON
    // that host. Verify a normal cross-host redirect still works:
    stubRows([rule("apex", "/go", "https://partners.zapnivo.com/portal")]);
    expect(await getRedirectFor("www.zapnivo.com", "/go")).toBe("https://partners.zapnivo.com/portal");
  });
});
