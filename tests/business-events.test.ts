import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbHolder } = vi.hoisted(() => ({ dbHolder: { db: null as unknown, inserts: [] as Record<string, unknown>[] } }));

vi.mock("@/lib/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table !== "business_events") return {};
      return {
        insert: async (row: Record<string, unknown>) => {
          if (dbHolder.inserts.some((r) => r.event_id && r.event_id === row.event_id)) {
            return { data: null, error: { code: "23505" } };
          }
          dbHolder.inserts.push(row);
          return { data: null, error: null };
        },
      };
    },
  }),
}));

import { POST } from "@/app/api/events/route";
import { sanitizeProps, isPublicEvent } from "@/lib/analytics";

const post = (body: unknown, ip = "10.0.0.1") =>
  POST(new Request("https://z.test/api/events", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  }) as never);

beforeEach(() => { dbHolder.inserts = []; });

describe("POST /api/events", () => {
  it("records an allowlisted public event", async () => {
    const res = await post({ name: "page_view", props: { path: "/locations" }, session_ref: "s1", consent_state: "granted" });
    expect(res.status).toBe(200);
    expect(dbHolder.inserts).toHaveLength(1);
    expect(dbHolder.inserts[0]).toMatchObject({ name: "page_view", source: "client", consent_state: "granted" });
  });

  it("rejects server-authoritative lifecycle events from the public endpoint", async () => {
    for (const name of ["rental_started", "rental_completed", "partner_application_approved", "support_human_escalated"]) {
      const res = await post({ name }, `10.0.0.${Math.floor(Math.random() * 250)}`);
      expect(res.status).toBe(422);
    }
    expect(dbHolder.inserts).toHaveLength(0);
  });

  it("is idempotent on duplicate event_id", async () => {
    const id = crypto.randomUUID();
    await post({ name: "click_contact", event_id: id });
    const res = await post({ name: "click_contact", event_id: id });
    expect(res.status).toBe(200);
    expect(dbHolder.inserts).toHaveLength(1);
  });

  it("strips PII-shaped props and non-scalar values", async () => {
    await post({ name: "view_pricing", props: { email: "a@b.c", phone: "555", ok_prop: "yes", nested: { x: 1 }, num: 3 } });
    const props = dbHolder.inserts[0].props as Record<string, unknown>;
    expect(props).not.toHaveProperty("email");
    expect(props).not.toHaveProperty("phone");
    expect(props).not.toHaveProperty("nested");
    expect(props).toMatchObject({ ok_prop: "yes", num: 3 });
  });

  it("rejects malformed payloads", async () => {
    expect((await post({ name: "page_view", extra: "nope" })).status).toBe(422);
    expect((await post({ name: "not_a_real_event" })).status).toBe(422);
    expect((await post(null)).status).toBe(422);
  });
});

describe("sanitizeProps / isPublicEvent", () => {
  it("drops forbidden keys even when values look safe", () => {
    expect(sanitizeProps({ user_email: "x", card_last4: "4242", venue: "cafe" })).toEqual({ venue: "cafe" });
  });
  it("knows the allowlist boundary", () => {
    expect(isPublicEvent("page_view")).toBe(true);
    expect(isPublicEvent("rental_started")).toBe(false);
  });
});
