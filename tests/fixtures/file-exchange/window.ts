export interface TimedEvent {
  id: string;
  atMs: number;
}

export function selectEvents(
  events: readonly TimedEvent[],
  startMs: number,
  endMs: number,
): TimedEvent[] {
  return events.filter((event) => event.atMs > startMs && event.atMs <= endMs);
}
