/** Public rental URL accepted by the iOS/Android station scanner. */
export function stationRentalUrl(stationId: string): string {
  return `https://www.zapnivo.com/r/${encodeURIComponent(stationId)}`;
}
