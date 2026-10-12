export interface ZonedParts {
  date: string;
  time: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const canonicalZones = new Map<string, string | null>();
const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

export function canonicalTimeZone(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const requested = value.trim();
  if (canonicalZones.has(requested)) return canonicalZones.get(requested)!;
  try {
    const canonical = new Intl.DateTimeFormat("en-US", { timeZone: requested }).resolvedOptions().timeZone;
    canonicalZones.set(requested, canonical);
    canonicalZones.set(canonical, canonical);
    return canonical;
  } catch {
    canonicalZones.set(requested, null);
    return null;
  }
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  let result = zonedFormatters.get(timeZone);
  if (!result) {
    result = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    });
    zonedFormatters.set(timeZone, result);
  }
  return result;
}

export function zonedParts(instant: Date | number, timeZone: string): ZonedParts {
  const canonical = canonicalTimeZone(timeZone);
  if (!canonical) throw new RangeError("Invalid IANA time zone");
  const parts = formatter(canonical).formatToParts(instant instanceof Date ? instant : new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value);
  const year = get("year"), month = get("month"), day = get("day");
  const hour = get("hour"), minute = get("minute"), second = get("second");
  return {
    date: `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`,
    time: `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`,
    year, month, day, hour, minute, second
  };
}

function compareLocal(a: Pick<ZonedParts, "date" | "time">, date: string, time: string): number {
  const left = `${a.date}T${a.time}`;
  const right = `${date}T${time}`;
  return left < right ? -1 : left > right ? 1 : 0;
}

function offsetAt(instant: number, timeZone: string): number {
  const local = zonedParts(instant, timeZone);
  const representedAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  return representedAsUtc - Math.floor(instant / 60_000) * 60_000;
}

function transitionMinute(start: number, end: number, timeZone: string): number | null {
  const startOffset = offsetAt(start, timeZone);
  if (startOffset === offsetAt(end, timeZone)) return null;
  let low = Math.floor(start / 60_000), high = Math.floor(end / 60_000);
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsetAt(middle * 60_000, timeZone) === startOffset) low = middle;
    else high = middle;
  }
  return high * 60_000;
}

/** Repeated times choose the earlier instant; gap times shift to the first valid local minute after the gap. */
export function resolveLocalOccurrence(date: string, time: string, timeZone: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new RangeError("Invalid local date or time");
  const canonical = canonicalTimeZone(timeZone);
  if (!canonical) throw new RangeError("Invalid IANA time zone");
  const nominal = Date.parse(`${date}T${time}:00Z`);
  const samples = [nominal - 36 * 60 * 60 * 1000, nominal, nominal + 36 * 60 * 60 * 1000];
  const offsets = new Set(samples.map(sample => offsetAt(sample, canonical)));
  const matches: number[] = [];
  for (const offset of offsets) {
    const candidate = nominal - offset;
    if (compareLocal(zonedParts(candidate, canonical), date, time) === 0) matches.push(candidate);
  }
  if (matches.length) return new Date(Math.min(...matches));

  for (let i = 0; i < samples.length - 1; i++) {
    const transition = transitionMinute(samples[i], samples[i + 1], canonical);
    if (transition === null) continue;
    const before = zonedParts(transition - 60_000, canonical);
    const after = zonedParts(transition, canonical);
    if (compareLocal(before, date, time) < 0 && compareLocal(after, date, time) > 0) return new Date(transition);
  }
  throw new RangeError("Local occurrence cannot be resolved");
}

export function isDateInMedicationRange(localDate: string, startDate: string, endDate: string | null | undefined): boolean {
  return localDate >= startDate && (!endDate || localDate <= endDate);
}

export function occurrenceForInstant(
  instant: Date,
  timeZone: string,
  scheduledTime: string,
  startDate: string,
  endDate?: string | null
) {
  const local = zonedParts(instant, timeZone);
  const time = scheduledTime.slice(0, 5);
  if (!isDateInMedicationRange(local.date, startDate, endDate)) return null;
  return { localDate: local.date, localTime: time, scheduledAtUtc: resolveLocalOccurrence(local.date, time, timeZone) };
}

export interface ScheduledDoseRow {
  time_zone: string;
  time_str: string;
  start_date: string;
  end_date?: string | null;
}

/** Selects by the resolved UTC occurrence, including DST-gap shifts and the earlier overlap instant. */
export function dueOccurrencesAtInstant<T extends ScheduledDoseRow>(rows: T[], instant: Date): Array<T & {
  localDate: string;
  localTime: string;
  scheduledAtUtc: Date;
}> {
  const targetMinute = Math.floor(instant.getTime() / 60_000);
  const due: Array<T & { localDate: string; localTime: string; scheduledAtUtc: Date }> = [];
  const zoneMinutes = new Map<string, { local: ZonedParts; previous: ZonedParts }>();
  for (const row of rows) {
    const zone = canonicalTimeZone(row.time_zone);
    if (!zone) continue;
    let minutes = zoneMinutes.get(zone);
    if (!minutes) {
      minutes = {
        local: zonedParts(targetMinute * 60_000, zone),
        previous: zonedParts((targetMinute - 1) * 60_000, zone)
      };
      zoneMinutes.set(zone, minutes);
    }
    const { local, previous } = minutes;
    const localTime = row.time_str.slice(0, 5);
    if (!isDateInMedicationRange(local.date, row.start_date, row.end_date)) continue;

    const scheduled = `${local.date}T${localTime}`;
    const crossedGap = previous.date === local.date && scheduled > `${previous.date}T${previous.time}` && scheduled < `${local.date}T${local.time}`;
    if (localTime !== local.time && !crossedGap) continue;

    const scheduledAtUtc = resolveLocalOccurrence(local.date, localTime, zone);
    if (Math.floor(scheduledAtUtc.getTime() / 60_000) === targetMinute) {
      due.push({ ...row, localDate: local.date, localTime, scheduledAtUtc });
    }
  }
  return due;
}

export function addLocalDays(date: string, days: number): string {
  const instant = new Date(`${date}T12:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}
