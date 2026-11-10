/** Heartbeat staleness — a kiosk with no heartbeat for this long is treated as offline/stale. */
export const HEARTBEAT_STALE_MIN = 15;

export const heartbeatStale = (lastSeenAt: string | null, now = new Date()) => {
  if (!lastSeenAt) return true;
  const seen = new Date(lastSeenAt).getTime();
  if (!Number.isFinite(seen)) return true; // unparseable heartbeat = treat as stale
  return now.getTime() - seen > HEARTBEAT_STALE_MIN * 60_000;
};
