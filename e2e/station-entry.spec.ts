import { expect, test } from "@playwright/test";
import { goTo } from "./helpers";

test("manual station entry validates input and opens the rental page", async ({ page }) => {
  await goTo(page, "/locations");
  const form = page.getByRole("form", { name: "Find a station by ID" });
  await form.getByLabel("Station ID").fill("https://other.example/r/ZN-ABC123");
  await form.getByRole("button", { name: "Check station" }).click();
  await expect(form.getByRole("alert")).toContainText("station ID");
  await expect(page).toHaveURL(/\/locations$/);

  await form.getByLabel("Station ID").fill("zn-abc123");
  await form.getByRole("button", { name: "Check station" }).click();
  await expect(page).toHaveURL(/\/r\/ZN-ABC123$/);
  await expect(page.getByText("This station is unavailable right now.")).toBeVisible();
});
