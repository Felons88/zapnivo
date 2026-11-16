const STATION_ID = /^[A-Za-z0-9_-]{3,40}$/;

/** Accept a printed station ID or Zapnivo rental URL, never a foreign QR URL. */
export function stationIdFromInput(input: string): string | null {
  const raw = input.trim();
  if (STATION_ID.test(raw)) return raw.toUpperCase();
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !["zapnivo.com", "www.zapnivo.com"].includes(url.hostname)) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2 || parts[0] !== "r" || !STATION_ID.test(parts[1])) return null;
    return parts[1];
  } catch { return null; }
}
