/**
 * A card's clock time, on the reader's clock.
 *
 * Cards are stamped in UTC, so slicing the ISO string showed everyone outside
 * UTC somebody else's time. The obvious fix — `hour12: false` — is wrong in a
 * way that only shows up for one hour a day: several locales resolve it to the
 * h24 cycle, which renders midnight as **24**, so a card created at 00:07 lists
 * as `24:07`. `hourCycle: "h23"` is the one that means what "24-hour clock"
 * means to a reader. Locale still comes from the reader, only the cycle is
 * pinned.
 */
export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}
