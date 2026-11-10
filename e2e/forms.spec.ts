import { test, expect, type Page } from "@playwright/test";
import { dismissConsent, goTo } from "./helpers";

const HONEST_503 = /not (yet )?(configured|available)|isn't (yet )?(available|set up)|unavailable|try again|temporarily|not set up|can't accept|cannot accept|backend|email us|went wrong/i;

/** Native constraint validation: returns names of invalid controls and their messages. */
async function invalidFields(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLInputElement>("form input, form select, form textarea")]
      .filter((el) => el.name && el.name !== "website" && !el.checkValidity())
      .map((el) => ({ name: el.name, msg: el.validationMessage })),
  );
}

async function expectNoFakeSuccess(page: Page) {
  await expect(page.getByRole("alert").filter({ hasText: /\S/ }).first()).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByText(/received|message sent|ticket .* created/i)).toHaveCount(0);
}

test.describe("contact form", () => {
  test("empty submit is blocked by client validation", async ({ page }) => {
    await goTo(page, "/contact");
    await dismissConsent(page);
    const requests: string[] = [];
    page.on("request", (r) => r.url().includes("/api/contact") && requests.push(r.url()));
    await page.getByRole("button", { name: "Send message" }).click();
    const bad = (await invalidFields(page)).map((f) => f.name);
    expect(bad).toEqual(expect.arrayContaining(["name", "email", "message"]));
    expect(requests).toHaveLength(0);
    await expect(page.locator("form :invalid").first()).toBeFocused();
  });

  test("invalid email is flagged", async ({ page }) => {
    await goTo(page, "/contact");
    await page.getByLabel("Name", { exact: true }).fill("Test User");
    await page.getByLabel("Email", { exact: true }).fill("not-an-email");
    await page.getByLabel("Message").fill("Hello there, this is a test message.");
    await page.getByRole("button", { name: "Send message" }).click();
    expect((await invalidFields(page)).map((f) => f.name)).toEqual(["email"]);
  });

  test("valid submit shows the honest 503 message, never success", async ({ page }) => {
    await goTo(page, "/contact");
    await dismissConsent(page);
    await page.getByLabel("Name", { exact: true }).fill("E2E Test");
    await page.getByLabel("Email", { exact: true }).fill("e2e@example.com");
    await page.getByLabel("Message").fill("Automated end to end test, backend intentionally unconfigured.");
    const submit = page.getByRole("button", { name: "Send message" });
    await submit.scrollIntoViewIfNeeded();
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/contact") && r.request().method() === "POST"),
      submit.click(),
    ]);
    expect(res.status()).toBe(503);
    await expectNoFakeSuccess(page);
    await expect(page.getByRole("alert").filter({ hasText: HONEST_503 })).toBeVisible();
  });
});

test.describe("partner application (/business/apply)", () => {
  test("empty step 1 blocks Continue", async ({ page }) => {
    await goTo(page, "/business/apply");
    await dismissConsent(page);
    await page.getByRole("button", { name: /Continue/ }).click();
    const bad = (await invalidFields(page)).map((f) => f.name);
    expect(bad).toEqual(expect.arrayContaining(["businessName", "contactName", "email", "phone"]));
    const vm = await page.locator("#businessName").evaluate((el: HTMLInputElement) => el.validationMessage);
    expect(vm.length).toBeGreaterThan(0);
    await expect(page.getByLabel("Progress").locator("li").nth(0)).toHaveAttribute("aria-current", "step");
  });

  test("invalid email blocks step 1", async ({ page }) => {
    await goTo(page, "/business/apply");
    await page.getByLabel("Business name").fill("Demo Tavern");
    await page.getByLabel("Contact name").fill("Test Owner");
    await page.getByLabel("Business email").fill("nope");
    await page.getByLabel("Phone number").fill("6125550100");
    await page.getByRole("button", { name: /Continue/ }).click();
    await expect(page.getByLabel("Progress").locator("li").nth(0)).toHaveAttribute("aria-current", "step");
    expect((await invalidFields(page)).map((f) => f.name)).toContain("email");
  });

  test("full valid flow ends in honest 503", async ({ page }) => {
    await goTo(page, "/business/apply");
    await dismissConsent(page);
    await page.getByLabel("Business name").fill("E2E Demo Tavern");
    await page.getByLabel("Contact name").fill("E2E Tester");
    await page.getByLabel("Business email").fill("e2e@example.com");
    await page.getByLabel("Phone number").fill("6125550100");
    const next = page.getByRole("button", { name: /Continue/ });
    // The click can land before hydration finishes — retry until step 2 mounts.
    const venue = page.getByLabel("Venue type");
    for (let i = 0; i < 10 && !(await venue.isVisible()); i++) await next.click();
    await expect(venue).toBeVisible();

    // step 2: required fields blocked when empty
    await next.click();
    expect((await invalidFields(page)).map((f) => f.name)).toEqual(expect.arrayContaining(["venueType", "street", "city"]));
    await page.getByLabel("Venue type").selectOption({ index: 1 });
    await page.getByLabel("Street address").fill("1 Test Street");
    await page.getByLabel("City").fill("Minneapolis");
    await next.click();
    await expect(page.getByLabel("Estimated operating hours")).toBeVisible();

    await page.getByLabel("Estimated operating hours").fill("Mon-Fri 9-5");
    await page.getByLabel("Preferred installation location").fill("Near the entrance");
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/partner-applications") && r.request().method() === "POST"),
      page.getByRole("button", { name: "Submit application" }).click(),
    ]);
    expect(res.status()).toBe(503);
    await expectNoFakeSuccess(page);
    await expect(page.getByRole("alert").filter({ hasText: HONEST_503 })).toBeVisible();
  });
});

test.describe("support ticket (/support/new)", () => {
  test("empty submit is blocked", async ({ page }) => {
    await goTo(page, "/support/new");
    await dismissConsent(page);
    const requests: string[] = [];
    page.on("request", (r) => r.url().includes("/api/support/tickets") && requests.push(r.url()));
    await page.getByRole("button", { name: "Create ticket" }).click();
    const bad = (await invalidFields(page)).map((f) => f.name);
    expect(bad).toEqual(expect.arrayContaining(["name", "email", "category", "description", "consent"]));
    expect(requests).toHaveLength(0);
  });

  test("too-short description and bad email are flagged", async ({ page }) => {
    await goTo(page, "/support/new");
    await page.getByLabel("Your name").fill("E2E");
    await page.getByLabel("Email used at checkout").fill("bad@");
    await page.getByLabel("What do you need help with?").selectOption({ index: 1 });
    await page.getByLabel("Describe the issue").fill("short");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Create ticket" }).click();
    const bad = (await invalidFields(page)).map((f) => f.name);
    expect(bad).toEqual(expect.arrayContaining(["email", "description"]));
  });

  test("valid submit shows the honest 503 message, never success", async ({ page }) => {
    await goTo(page, "/support/new");
    await dismissConsent(page);
    await page.getByLabel("Your name").fill("E2E Tester");
    await page.getByLabel("Email used at checkout").fill("e2e@example.com");
    await page.getByLabel("What do you need help with?").selectOption({ index: 1 });
    await page.getByLabel("Describe the issue").fill("Automated test, backend is intentionally unconfigured.");
    await page.getByRole("checkbox").check();
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/support/tickets") && r.request().method() === "POST"),
      page.getByRole("button", { name: "Create ticket" }).click(),
    ]);
    expect(res.status()).toBe(503);
    await expectNoFakeSuccess(page);
    await expect(page.getByRole("alert").filter({ hasText: HONEST_503 })).toBeVisible();
  });
});
