import { expect, test } from "@playwright/test";

test("mobile account routes require a verified session", async ({ request }) => {
  for (const path of ["/api/mobile/me", "/api/mobile/rentals"]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(401);
  }
});

test("manual station lookup validates IDs and is honest when the backend is off", async ({ request }) => {
  const invalid = await request.get("/api/mobile/stations/%21%21%21");
  expect(invalid.status()).toBe(400);
  const unavailable = await request.get("/api/mobile/stations/ZN-ABC123");
  expect(unavailable.status()).toBe(503);
});

test("mobile configuration does not claim sign-in is ready without Supabase", async ({ request }) => {
  const res = await request.get("/api/mobile/config");
  expect(res.status()).toBe(503);
});
