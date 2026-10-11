export function scheduleDate(timestamp: number, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Resolve local wall time through the IANA zone rules, including DST changes. */
export function scheduleInstant(date: string, time: string, timeZone: string): number {
  const target = Date.parse(`${date}T${time.slice(0, 5)}:00Z`);
  let value = target;
  let previousValue = Number.NaN;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map(part => [part.type, part.value]));
    const rendered = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
    const correction = target - rendered;
    if (!correction) break;
    const next = value + correction;
    if (next === previousValue) return Math.max(value, next);
    previousValue = value;
    value = next;
  }
  return value;
}

export function doseReminderAllowed(status: string | null): boolean {
  return status === null || status === "PENDING";
}

export function missedNotificationEligible(status: string | null): boolean {
  return status !== "TAKEN";
}
