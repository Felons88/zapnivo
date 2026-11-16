import { describe, expect, it } from "vitest";
import { stationIdFromInput } from "@/lib/station-code";

describe("stationIdFromInput", () => {
  it("accepts printed IDs and Zapnivo QR URLs", () => {
    expect(stationIdFromInput("  zn-abc123  ")).toBe("ZN-ABC123");
    expect(stationIdFromInput("https://www.zapnivo.com/r/ZN-ABC123?source=qr")).toBe("ZN-ABC123");
  });
  it("rejects foreign URLs and malformed IDs", () => {
    expect(stationIdFromInput("https://zapnivo.com.evil.test/r/ZN-ABC123")).toBeNull();
    expect(stationIdFromInput("https://www.zapnivo.com/r/x")).toBeNull();
    expect(stationIdFromInput("http://www.zapnivo.com/r/ZN-ABC123")).toBeNull();
  });
});
