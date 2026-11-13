import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const { recordLog, reportError } = vi.hoisted(() => ({ recordLog: vi.fn(), reportError: vi.fn() }));
vi.mock("@/lib/observability", () => ({ recordLog, reportError }));

import { agentAllowed, agentDenied, authorizeAgent } from "@/lib/ai/authorization";

type Row = Record<string, unknown>;

/** Minimal fake for the single query authorizeAgent issues. */
function dbReturning(result: { data: Row | null; error: { message: string } | null }): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => result }),
      }),
    }),
  } as unknown as SupabaseClient;
}

const AGENT_ROW = { id: "support.public", enabled: true };

describe("authorizeAgent — fail closed", () => {
  it("allows when the row exists and enabled === true", async () => {
    const g = await authorizeAgent("support.public", dbReturning({ data: AGENT_ROW, error: null }));
    expect(g).toEqual(agentAllowed("support.public"));
    expect(recordLog).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("denies quietly (info log, no error event) when disabled by admin", async () => {
    const g = await authorizeAgent("support.public", dbReturning({ data: { id: "support.public", enabled: false }, error: null }));
    expect(g).toEqual(agentDenied("support.public", "disabled"));
    expect(reportError).not.toHaveBeenCalled();
    expect(recordLog).toHaveBeenCalledWith("info", "ai.agent_denied", expect.objectContaining({ attrs: expect.objectContaining({ agent: "support.public", reason: "disabled" }) }));
  });

  it("denies + warning event on query error", async () => {
    const g = await authorizeAgent("support.public", dbReturning({ data: null, error: { message: "connection reset" } }));
    expect(g).toEqual(agentDenied("support.public", "unavailable"));
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ severity: "warning" }));
  });

  it("denies + warning event on missing row", async () => {
    const g = await authorizeAgent("ghost.agent", dbReturning({ data: null, error: null }));
    expect(g).toEqual(agentDenied("ghost.agent", "missing"));
    expect(reportError).toHaveBeenCalled();
  });

  it("denies + warning event on malformed row (enabled not boolean / id mismatch)", async () => {
    expect(await authorizeAgent("support.public", dbReturning({ data: { id: "support.public", enabled: "yes" }, error: null })))
      .toEqual(agentDenied("support.public", "invalid_row"));
    expect(await authorizeAgent("support.public", dbReturning({ data: { id: "other.agent", enabled: true }, error: null })))
      .toEqual(agentDenied("support.public", "invalid_row"));
    expect(reportError).toHaveBeenCalled();
  });

  it("denies when no db client is available (explicit null)", async () => {
    const g = await authorizeAgent("support.public", null);
    expect(g).toEqual(agentDenied("support.public", "unavailable"));
    expect(reportError).toHaveBeenCalled();
  });

  it("never leaks customer data into events — agent id + reason class only", async () => {
    await authorizeAgent("support.customer", dbReturning({ data: null, error: { message: "pat@example.com sk-live-secret" } }));
    const attrs = (reportError.mock.calls[0]?.[1] as { attrs: Record<string, unknown> }).attrs;
    expect(Object.keys(attrs).sort()).toEqual(["agent", "reason", "surface"]);
    expect(JSON.stringify(attrs)).not.toMatch(/pat@example|sk-live/);
  });
});
