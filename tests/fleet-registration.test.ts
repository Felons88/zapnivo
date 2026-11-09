import { beforeEach, describe, expect, it, vi } from "vitest";

const { session, service, insertedSlots, deletedKiosks, slotFailure } = vi.hoisted(() => ({
  session: vi.fn(), service: vi.fn(), insertedSlots: vi.fn(), deletedKiosks: vi.fn(), slotFailure: { value: false },
}));
vi.mock("@/lib/auth", () => ({ getSessionUser: session, isStaff: (user: { role?: string } | null) => user?.role === "admin" }));
vi.mock("@/lib/supabase", () => ({ serviceClient: service }));

import { POST } from "@/app/api/admin/fleet/route";

function db() {
  return {
    from(table: string) {
      if (table === "kiosks") return {
        insert: () => ({ select: () => ({ single: async () => ({ data: { id: "6f559b10-f77f-49c6-a4ad-bfe62bb27e58" }, error: null }) }) }),
        delete: () => ({ eq: async (_field: string, id: string) => { deletedKiosks(id); return { error: null }; } }),
      };
      if (table === "kiosk_slots") return { insert: async (rows: unknown[]) => { insertedSlots(rows); return { error: slotFailure.value ? { message: "failed" } : null }; } };
      throw new Error(`Unexpected table: ${table}`);
    },
  };
}

function request(slotCount = "8") {
  const body = new FormData();
  body.set("action", "create_kiosk");
  body.set("slot_count", slotCount);
  body.set("model", "ZP-8");
  return new Request("http://localhost:3000/api/admin/fleet", { method: "POST", body });
}

describe("fleet registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    slotFailure.value = false;
    session.mockResolvedValue({ id: "staff-1", role: "admin" });
    service.mockReturnValue(db());
  });

  it("registers numbered empty slots with a provisioning kiosk", async () => {
    const response = await POST(request());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toMatch(/\/admin\/fleet\?result=created&detail=ZN-/);
    expect(insertedSlots).toHaveBeenCalledWith(Array.from({ length: 8 }, (_, i) => ({
      kiosk_id: "6f559b10-f77f-49c6-a4ad-bfe62bb27e58", slot_number: i + 1, state: "empty",
    })));
    expect(deletedKiosks).not.toHaveBeenCalled();
  });

  it("removes a kiosk if slot creation fails", async () => {
    slotFailure.value = true;
    const response = await POST(request());
    expect(response.headers.get("location")).toContain("result=error");
    expect(deletedKiosks).toHaveBeenCalledWith("6f559b10-f77f-49c6-a4ad-bfe62bb27e58");
  });

  it("rejects an invalid slot count before writing", async () => {
    const response = await POST(request("0"));
    expect(response.headers.get("location")).toContain("result=error");
    expect(insertedSlots).not.toHaveBeenCalled();
  });
});
