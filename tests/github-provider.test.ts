import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCheckRuns,
  getRepository,
  githubOverview,
  githubStatus,
  listBranches,
  listCommits,
  listOpenPullRequests,
  listReleaseTags,
} from "@/lib/system/github-provider";

/* ── Env + fetch fixtures ──────────────────────────────────────────────── */

const ENV_KEYS = ["GITHUB_TOKEN", "GITHUB_REPO"];
const TOKEN = "ghp_secret-token-DO-NOT-LEAK-123";
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  vi.unstubAllGlobals();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
});

const setGithubEnv = () => {
  process.env.GITHUB_TOKEN = TOKEN;
  process.env.GITHUB_REPO = "zapnivo/zapnivo-website";
};

const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init));
  vi.stubGlobal("fetch", fn);
  return fn;
}

const REPO = {
  id: 42,
  name: "zapnivo-website",
  full_name: "zapnivo/zapnivo-website",
  default_branch: "main",
  private: true,
  visibility: "private",
  html_url: "https://github.com/zapnivo/zapnivo-website",
  description: "Zapnivo site",
};

/* ── configured:false ──────────────────────────────────────────────────── */

describe("unconfigured", () => {
  it("returns configured:false and performs ZERO fetch calls", async () => {
    const fetchMock = mockFetch(() => jsonRes({}));
    expect(githubStatus()).toEqual({ configured: false, missing: ["GITHUB_TOKEN", "GITHUB_REPO"] });
    for (const r of [
      await getRepository(),
      await listBranches(),
      await listCommits(),
      await listOpenPullRequests(),
      await getCheckRuns("abc123"),
      await listReleaseTags(),
      await githubOverview(),
    ]) {
      expect(r.configured).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("githubOverview reports missing env vars when unconfigured", async () => {
    process.env.GITHUB_TOKEN = TOKEN; // repo missing
    const ov = await githubOverview();
    expect(ov.configured).toBe(false);
    expect(ov.missing).toEqual(["GITHUB_REPO"]);
  });
});

/* ── Happy-path parsing ────────────────────────────────────────────────── */

describe("repository", () => {
  it("parses repo identity incl. visibility + html_url", async () => {
    setGithubEnv();
    mockFetch((url) => {
      expect(url).toContain("https://api.github.com/repos/zapnivo/zapnivo-website");
      expect(url).not.toContain("/branches");
      return jsonRes(REPO);
    });
    const r = await getRepository();
    expect(r.configured && r.ok).toBe(true);
    if (r.configured && r.ok) {
      expect(r.data.fullName).toBe("zapnivo/zapnivo-website");
      expect(r.data.defaultBranch).toBe("main");
      expect(r.data.visibility).toBe("private");
      expect(r.data.htmlUrl).toBe("https://github.com/zapnivo/zapnivo-website");
    }
  });
});

describe("branches", () => {
  it("parses name/protected/sha and synthesizes html_url", async () => {
    setGithubEnv();
    mockFetch(() => jsonRes([
      { name: "main", protected: true, commit: { sha: "abc123def456" } },
      { name: "feature/x", protected: false, commit: { sha: "fff999" } },
    ]));
    const r = await listBranches();
    expect(r.configured && r.ok).toBe(true);
    if (r.configured && r.ok) {
      expect(r.data).toHaveLength(2);
      expect(r.data[0]).toMatchObject({
        name: "main", protected: true, commitSha: "abc123def456",
        htmlUrl: "https://github.com/zapnivo/zapnivo-website/tree/main",
      });
      expect(r.data[1].protected).toBe(false);
    }
  });
});

describe("commits", () => {
  it("parses sha/message/author/date/html_url on a branch", async () => {
    setGithubEnv();
    const fetchMock = mockFetch((url) => {
      expect(url).toContain("/commits?sha=main");
      return jsonRes([
        {
          sha: "deadbeef123",
          html_url: "https://github.com/zapnivo/zapnivo-website/commit/deadbeef123",
          commit: {
            message: "feat: thing\n\nlong body",
            author: { name: "James", date: "2025-01-01T00:00:00Z" },
          },
        },
      ]);
    });
    const r = await listCommits("main");
    expect(r.configured && r.ok).toBe(true);
    if (r.configured && r.ok) {
      expect(r.data[0]).toMatchObject({
        sha: "deadbeef123",
        message: "feat: thing",
        author: "James",
        date: "2025-01-01T00:00:00Z",
        htmlUrl: "https://github.com/zapnivo/zapnivo-website/commit/deadbeef123",
      });
    }
    // Authorization header sent, never exposed in results
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("rejects invalid refs before any fetch", async () => {
    setGithubEnv();
    const fetchMock = mockFetch(() => jsonRes([]));
    const r = await listCommits("main..evil");
    expect(r.configured && !r.ok && r.reason === "invalid_ref").toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("pull requests", () => {
  it("parses open PRs and enriches mergeable via /pulls/{n}", async () => {
    setGithubEnv();
    mockFetch((url) => {
      if (url.includes("/pulls/7")) {
        return jsonRes({ number: 7, mergeable: true, mergeable_state: "clean" });
      }
      if (url.includes("/pulls")) {
        return jsonRes([
          {
            number: 7,
            title: "Add thing",
            draft: false,
            updated_at: "2025-01-02T00:00:00Z",
            html_url: "https://github.com/zapnivo/zapnivo-website/pull/7",
            user: { login: "james" },
            head: { ref: "feature/x" },
            base: { ref: "main" },
          },
        ]);
      }
      return jsonRes({}, 404);
    });
    const r = await listOpenPullRequests();
    expect(r.configured && r.ok).toBe(true);
    if (r.configured && r.ok) {
      expect(r.data[0]).toMatchObject({
        number: 7, title: "Add thing", author: "james",
        headRef: "feature/x", baseRef: "main", draft: false,
        mergeable: true, mergeableState: "clean",
        htmlUrl: "https://github.com/zapnivo/zapnivo-website/pull/7",
      });
    }
  });
});

describe("check runs + release tags", () => {
  it("parses check runs for a sha", async () => {
    setGithubEnv();
    mockFetch((url) => {
      expect(url).toContain("/commits/deadbeef/check-runs");
      return jsonRes({
        check_runs: [
          { name: "build", status: "completed", conclusion: "success", html_url: "https://github.com/x/checks/1" },
          { name: "test", status: "in_progress", conclusion: null, html_url: null },
        ],
      });
    });
    const r = await getCheckRuns("deadbeef");
    expect(r.configured && r.ok).toBe(true);
    if (r.configured && r.ok) {
      expect(r.data[0]).toMatchObject({ name: "build", conclusion: "success" });
      expect(r.data[1]).toMatchObject({ name: "test", status: "in_progress", conclusion: null });
    }
  });

  it("parses release tags", async () => {
    setGithubEnv();
    mockFetch(() => jsonRes([
      {
        tag_name: "v1.2.0",
        target_commitish: "abc123",
        draft: false,
        prerelease: false,
        published_at: "2025-01-03T00:00:00Z",
        html_url: "https://github.com/zapnivo/zapnivo-website/releases/tag/v1.2.0",
      },
    ]));
    const r = await listReleaseTags();
    expect(r.configured && r.ok).toBe(true);
    if (r.configured && r.ok) {
      expect(r.data[0]).toMatchObject({
        name: "v1.2.0", sha: "abc123", draft: false, prerelease: false,
        htmlUrl: "https://github.com/zapnivo/zapnivo-website/releases/tag/v1.2.0",
      });
    }
  });
});

/* ── Error handling ────────────────────────────────────────────────────── */

describe("error handling", () => {
  it("maps 403 + x-ratelimit-remaining:0 to rate_limited", async () => {
    setGithubEnv();
    mockFetch(() => jsonRes({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0" }));
    const r = await getRepository();
    expect(r.configured && !r.ok).toBe(true);
    if (r.configured && !r.ok) {
      expect(r.reason).toBe("rate_limited");
      expect(r.status).toBe(403);
    }
  });

  it("maps 403 + Retry-After to rate_limited", async () => {
    setGithubEnv();
    mockFetch(() => jsonRes({ message: "secondary rate limit" }, 403, { "retry-after": "60" }));
    const r = await getRepository();
    expect(r.configured && !r.ok && r.reason === "rate_limited").toBe(true);
  });

  it("maps 429 to rate_limited", async () => {
    setGithubEnv();
    mockFetch(() => jsonRes({ message: "slow down" }, 429));
    const r = await listBranches();
    expect(r.configured && !r.ok && r.reason === "rate_limited").toBe(true);
  });

  it("maps 401 to unauthorized and NEVER leaks the token", async () => {
    setGithubEnv();
    // Even a hostile provider body echoing the token must be scrubbed.
    mockFetch(() => jsonRes({ message: `Bad credentials for token ${TOKEN}` }, 401));
    const r = await getRepository();
    expect(r.configured && !r.ok).toBe(true);
    if (r.configured && !r.ok) {
      expect(r.reason).toBe("unauthorized");
      expect(r.status).toBe(401);
      expect(JSON.stringify(r)).not.toContain(TOKEN);
      expect(r.detail ?? "").not.toContain(TOKEN);
      expect(r.detail ?? "").toContain("[redacted]");
    }
  });

  it("maps 404 to not_found", async () => {
    setGithubEnv();
    mockFetch(() => jsonRes({ message: "Not Found" }, 404));
    const r = await getRepository();
    expect(r.configured && !r.ok && r.reason === "not_found").toBe(true);
  });

  it("maps fetch timeout to reason timeout", async () => {
    setGithubEnv();
    mockFetch(async () => {
      const e = new Error("The operation timed out");
      e.name = "TimeoutError";
      throw e;
    });
    const r = await getRepository();
    expect(r.configured && !r.ok && r.reason === "timeout").toBe(true);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("maps network failure to network_error with sanitized detail", async () => {
    setGithubEnv();
    mockFetch(async () => {
      throw new Error(`connect ECONNREFUSED while using ${TOKEN}`);
    });
    const r = await getRepository();
    expect(r.configured && !r.ok && r.reason === "network_error").toBe(true);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect((r as { detail?: string }).detail ?? "").toContain("[redacted]");
  });
});

/* ── Overview fan-out ──────────────────────────────────────────────────── */

describe("githubOverview", () => {
  it("fans out all reads and wires commits/check-runs to the default branch", async () => {
    setGithubEnv();
    mockFetch((url) => {
      if (url.endsWith("/repos/zapnivo/zapnivo-website")) return jsonRes(REPO);
      if (url.includes("/branches")) {
        return jsonRes([{ name: "main", protected: true, commit: { sha: "headsha1" } }]);
      }
      if (url.includes("/commits?sha=main")) {
        return jsonRes([{ sha: "c1", commit: { message: "m", author: { name: "a", date: "d" } }, html_url: "u" }]);
      }
      if (url.includes("/pulls")) return jsonRes([]);
      if (url.includes("/releases")) return jsonRes([]);
      if (url.includes("/check-runs")) {
        expect(url).toContain("/commits/headsha1/check-runs");
        return jsonRes({ check_runs: [] });
      }
      return jsonRes({}, 404);
    });
    const ov = await githubOverview();
    expect(ov.configured).toBe(true);
    expect(ov.repository.configured && ov.repository.ok).toBe(true);
    expect(ov.branches.configured && ov.branches.ok && ov.branches.data.length).toBe(1);
    expect(ov.commits.configured && ov.commits.ok && ov.commits.data.length).toBe(1);
    expect(ov.checkRuns.configured && ov.checkRuns.ok).toBe(true);
  });
});
