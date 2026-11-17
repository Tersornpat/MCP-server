/**
 * Timezone helpers built on Intl, so no tz database dependency is needed.
 */

export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset of `tz` from UTC at the given instant, in minutes (Bangkok = 420). */
export function tzOffsetMinutes(tz: string, at: Date): number {
  let fmt = fmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    fmtCache.set(tz, fmt);
  }
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(at)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/** Wall-clock fields of an instant as seen in `tz`. */
export function toWallClock(at: Date, tz: string): WallClock {
  const shifted = new Date(at.getTime() + tzOffsetMinutes(tz, at) * 60000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

/** Instant for a wall-clock time in `tz`. */
export function fromWallClock(w: WallClock, tz: string): Date {
  const naive = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  // Two passes settle the offset around DST transitions.
  let guess = naive - tzOffsetMinutes(tz, new Date(naive)) * 60000;
  guess = naive - tzOffsetMinutes(tz, new Date(guess)) * 60000;
  return new Date(guess);
}

/** True when the zone keeps one UTC offset all year (no DST), e.g. Asia/Bangkok. */
export function hasFixedOffset(tz: string, around: Date = new Date()): boolean {
  const y = around.getUTCFullYear();
  const offsets = new Set<number>();
  for (const year of [y, y + 1]) {
    for (let month = 0; month < 12; month++) {
      offsets.add(tzOffsetMinutes(tz, new Date(Date.UTC(year, month, 1, 12))));
    }
  }
  return offsets.size === 1;
}

const pad = (n: number, len = 2) => String(Math.abs(n)).padStart(len, '0');

export function formatOffset(minutes: number, colon = true): string {
  const sign = minutes < 0 ? '-' : '+';
  const h = pad(Math.floor(Math.abs(minutes) / 60));
  const m = pad(Math.abs(minutes) % 60);
  return colon ? `${sign}${h}:${m}` : `${sign}${h}${m}`;
}

/** ISO 8601 with the zone's offset, e.g. 2026-11-20T16:00:00+07:00. */
export function formatInZone(at: Date, tz: string): string {
  const w = toWallClock(at, tz);
  return (
    `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}` +
    formatOffset(tzOffsetMinutes(tz, at))
  );
}

export function formatDate(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

export interface ParsedInput {
  /** True when the input was a bare date (YYYY-MM-DD). */
  dateOnly: boolean;
  /** The instant. For a bare date this is midnight in the user's zone. */
  instant: Date;
  year: number;
  month: number;
  day: number;
}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?)?(Z|z|[+-]\d{2}:?\d{2})?$/;

/**
 * Parse an ISO 8601 date or date-time. A value with no offset is read as
 * wall-clock time in `tz`.
 */
export function parseIsoInput(value: string, tz: string, field: string): ParsedInput {
  const m = ISO_RE.exec(value.trim());
  if (!m) {
    throw new UserError(
      `${field} must be ISO 8601, e.g. 2026-11-20T16:00:00+07:00, 2026-11-20T16:00 or 2026-11-20 (got "${value}")`,
    );
  }
  const [, ys, ms, ds, hs, mins, ss, off] = m;
  const year = Number(ys);
  const month = Number(ms);
  const day = Number(ds);
  const dateOnly = hs === undefined;
  const hour = Number(hs ?? 0);
  const minute = Number(mins ?? 0);
  const second = Number(ss ?? 0);
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new UserError(`${field} is not a real date/time: "${value}"`);
  }
  let instant: Date;
  if (off && !dateOnly) {
    let offsetMin = 0;
    if (off.toUpperCase() !== 'Z') {
      const sign = off[0] === '-' ? -1 : 1;
      const digits = off.slice(1).replace(':', '');
      offsetMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
    }
    instant = new Date(check.getTime() - offsetMin * 60000);
  } else {
    instant = fromWallClock({ year, month, day, hour, minute, second }, tz);
  }
  return { dateOnly, instant, year, month, day };
}

/** An error whose message is safe and useful to show to the model. */
export class UserError extends Error {}
