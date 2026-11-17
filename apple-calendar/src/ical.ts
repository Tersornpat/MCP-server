/**
 * iCalendar (RFC 5545) building, editing and reading, on top of ical.js.
 *
 * Writing rule for date-times: when the user's zone has a fixed UTC offset
 * (Asia/Bangkok), events are written as local time with TZID plus a matching
 * VTIMEZONE. For zones with DST they are written in UTC, because a correct
 * VTIMEZONE needs the full tz database.
 */
import ICAL from 'ical.js';
import { randomUUID } from 'node:crypto';
import {
  formatDate,
  formatInZone,
  formatOffset,
  fromWallClock,
  hasFixedOffset,
  isValidTimeZone,
  toWallClock,
  tzOffsetMinutes,
  UserError,
  type ParsedInput,
} from './time';

export const PRODID = '-//tersornpat//apple-calendar-mcp 1.0//EN';
const MAX_OCCURRENCE_STEPS = 20000;
const DAY_MS = 86400000;

export interface Recurrence {
  frequency: 'daily' | 'weekly' | 'monthly';
  interval?: number;
  count?: number;
  until?: string;
}

export interface NewEvent {
  title: string;
  start: ParsedInput;
  end?: ParsedInput;
  allDay: boolean;
  location?: string;
  notes?: string;
  alertMinutesBefore?: number;
  recurrence?: Recurrence;
  untilParsed?: ParsedInput;
}

export interface EventPatch {
  title?: string;
  start?: ParsedInput;
  end?: ParsedInput;
  location?: string;
  notes?: string;
  /** number = replace alerts with one alert, null = remove all alerts. */
  alertMinutesBefore?: number | null;
}

export interface EventView {
  uid: string;
  title: string;
  /** ISO 8601 with offset, or YYYY-MM-DD for all-day events. */
  start: string;
  /** For all-day events this is the last day, inclusive. */
  end: string;
  all_day: boolean;
  location?: string;
  notes?: string;
  recurring: boolean;
  alert_minutes_before?: number[];
  /** Sort key, not returned to the client. */
  startMs: number;
}

// ---------- writing ----------

/** ical.js types demand a zone argument, but a floating time is created without one. */
function icalTime(data: Record<string, number | boolean>): ICAL.Time {
  return new (ICAL.Time as unknown as new (d: Record<string, number | boolean>) => ICAL.Time)(data);
}

function dateValue(year: number, month: number, day: number): ICAL.Time {
  return icalTime({ year, month, day, isDate: true });
}

function addDays(p: { year: number; month: number; day: number }, days: number) {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day) + days * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function ensureVTimezone(vcal: ICAL.Component, tz: string, at: Date): void {
  const existing = vcal
    .getAllSubcomponents('vtimezone')
    .some((c) => c.getFirstPropertyValue('tzid') === tz);
  if (existing) return;
  const offset = formatOffset(tzOffsetMinutes(tz, at));
  const vtz = new ICAL.Component('vtimezone');
  vtz.addPropertyWithValue('tzid', tz);
  const std = new ICAL.Component('standard');
  std.addPropertyWithValue(
    'dtstart',
    icalTime({ year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, isDate: false }),
  );
  std.addPropertyWithValue('tzoffsetfrom', ICAL.UtcOffset.fromString(offset));
  std.addPropertyWithValue('tzoffsetto', ICAL.UtcOffset.fromString(offset));
  std.addPropertyWithValue('tzname', offset.replace(':', ''));
  vtz.addSubcomponent(std);
  vcal.addSubcomponent(vtz);
}

function setDateTime(
  vcal: ICAL.Component,
  vevent: ICAL.Component,
  name: 'dtstart' | 'dtend',
  instant: Date,
  tz: string,
): void {
  vevent.removeAllProperties(name);
  const prop = new ICAL.Property(name);
  if (hasFixedOffset(tz, instant)) {
    const w = toWallClock(instant, tz);
    prop.setValue(icalTime({ ...w, isDate: false }));
    prop.setParameter('tzid', tz);
    ensureVTimezone(vcal, tz, instant);
  } else {
    prop.setValue(ICAL.Time.fromJSDate(instant, true));
  }
  vevent.addProperty(prop);
}

function setDate(
  vevent: ICAL.Component,
  name: 'dtstart' | 'dtend',
  p: { year: number; month: number; day: number },
): void {
  vevent.removeAllProperties(name);
  const prop = new ICAL.Property(name);
  prop.resetType('date');
  prop.setValue(dateValue(p.year, p.month, p.day));
  vevent.addProperty(prop);
}

function setText(vevent: ICAL.Component, name: string, value: string | undefined): void {
  if (value === undefined) return;
  if (value === '') vevent.removeAllProperties(name);
  else vevent.updatePropertyWithValue(name, value);
}

function setAlarm(vevent: ICAL.Component, minutes: number, title: string): void {
  for (const alarm of vevent.getAllSubcomponents('valarm')) vevent.removeSubcomponent(alarm);
  const valarm = new ICAL.Component('valarm');
  valarm.addPropertyWithValue('uid', randomUUID().toUpperCase());
  valarm.addPropertyWithValue('action', 'DISPLAY');
  valarm.addPropertyWithValue('description', title || 'Reminder');
  valarm.addPropertyWithValue('trigger', ICAL.Duration.fromSeconds(-minutes * 60));
  vevent.addSubcomponent(valarm);
}

function stamp(vevent: ICAL.Component): void {
  const now = ICAL.Time.fromJSDate(new Date(), true);
  vevent.updatePropertyWithValue('dtstamp', now);
  vevent.updatePropertyWithValue('last-modified', now);
}

/** Start/end rules shared by create and update. Returns what to write. */
function resolveTimes(
  start: ParsedInput,
  end: ParsedInput | undefined,
  allDay: boolean,
): { start: ParsedInput; end: ParsedInput | undefined; endDateExclusive?: { year: number; month: number; day: number } } {
  if (allDay) {
    const last = end ?? start;
    const startDay = Date.UTC(start.year, start.month - 1, start.day);
    const lastDay = Date.UTC(last.year, last.month - 1, last.day);
    if (lastDay < startDay) throw new UserError('end must not be before start');
    return { start, end, endDateExclusive: addDays(last, 1) };
  }
  if (!end) throw new UserError('end is required for a timed event');
  if (end.dateOnly || start.dateOnly) {
    throw new UserError(
      'start and end need a time (e.g. 2026-11-20T16:00) unless all_day is true',
    );
  }
  if (end.instant.getTime() <= start.instant.getTime()) {
    throw new UserError('end must be after start');
  }
  return { start, end };
}

export function buildEvent(input: NewEvent, tz: string): { uid: string; ics: string } {
  const uid = randomUUID().toUpperCase();
  const vcal = new ICAL.Component('vcalendar');
  vcal.addPropertyWithValue('version', '2.0');
  vcal.addPropertyWithValue('prodid', PRODID);
  vcal.addPropertyWithValue('calscale', 'GREGORIAN');

  const vevent = new ICAL.Component('vevent');
  vevent.addPropertyWithValue('uid', uid);
  vevent.addPropertyWithValue('summary', input.title);
  vevent.addPropertyWithValue('created', ICAL.Time.fromJSDate(new Date(), true));
  vevent.addPropertyWithValue('sequence', 0);
  stamp(vevent);

  const times = resolveTimes(input.start, input.end, input.allDay);
  if (input.allDay) {
    setDate(vevent, 'dtstart', times.start);
    setDate(vevent, 'dtend', times.endDateExclusive!);
  } else {
    setDateTime(vcal, vevent, 'dtstart', times.start.instant, tz);
    setDateTime(vcal, vevent, 'dtend', times.end!.instant, tz);
  }

  setText(vevent, 'location', input.location || undefined);
  setText(vevent, 'description', input.notes || undefined);

  if (input.recurrence) {
    const data: Record<string, unknown> = {
      freq: input.recurrence.frequency.toUpperCase(),
    };
    if (input.recurrence.interval && input.recurrence.interval > 1) {
      data.interval = input.recurrence.interval;
    }
    if (input.recurrence.count && input.untilParsed) {
      throw new UserError('recurrence: give either count or until, not both');
    }
    if (input.recurrence.count) data.count = input.recurrence.count;
    if (input.untilParsed) {
      const u = input.untilParsed;
      if (input.allDay) {
        data.until = dateValue(u.year, u.month, u.day);
      } else {
        // A bare date means "through the end of that day" in the user's zone.
        const instant = u.dateOnly
          ? new Date(fromWallClock({ ...addDays(u, 1), hour: 0, minute: 0, second: 0 }, tz).getTime() - 1000)
          : u.instant;
        data.until = ICAL.Time.fromJSDate(instant, true);
      }
    }
    vevent.addPropertyWithValue('rrule', ICAL.Recur.fromData(data));
  }

  if (input.alertMinutesBefore !== undefined) {
    setAlarm(vevent, input.alertMinutesBefore, input.title);
  }

  vcal.addSubcomponent(vevent);
  return { uid, ics: vcal.toString() + '\r\n' };
}

function masterEvent(vcal: ICAL.Component): ICAL.Component {
  const events = vcal.getAllSubcomponents('vevent');
  const master = events.find((e) => !e.hasProperty('recurrence-id')) ?? events[0];
  if (!master) throw new UserError('That calendar item is not an event');
  return master;
}

/** Apply a patch to an existing calendar object, keeping everything else intact. */
export function patchEvent(ics: string, patch: EventPatch, tz: string): string {
  const vcal = new ICAL.Component(ICAL.parse(ics));
  const vevent = masterEvent(vcal);

  setText(vevent, 'summary', patch.title);
  setText(vevent, 'location', patch.location);
  setText(vevent, 'description', patch.notes);

  if (patch.start || patch.end) {
    const current = readTimes(vevent, tz);
    const wasAllDay = current.allDay;
    const allDay = patch.start ? patch.start.dateOnly : wasAllDay;
    if (patch.end && patch.end.dateOnly !== allDay) {
      throw new UserError(
        allDay
          ? 'This is an all-day event: give end as a date (YYYY-MM-DD), or send start and end together to change it'
          : 'This is a timed event: give end with a time, or send start and end together as dates to make it all-day',
      );
    }
    if (allDay) {
      const start = patch.start ?? ymdOf(current.startMs, tz, true);
      let last: { year: number; month: number; day: number };
      if (patch.end) {
        last = patch.end;
      } else if (wasAllDay) {
        // Keep the same number of days.
        const days = Math.max(0, Math.round((current.endMs - current.startMs) / DAY_MS) - 1);
        last = addDays(start, days);
      } else {
        last = start;
      }
      if (Date.UTC(last.year, last.month - 1, last.day) < Date.UTC(start.year, start.month - 1, start.day)) {
        throw new UserError('end must not be before start');
      }
      setDate(vevent, 'dtstart', start);
      setDate(vevent, 'dtend', addDays(last, 1));
    } else {
      const startInstant = patch.start ? patch.start.instant : new Date(current.startMs);
      let endInstant: Date;
      if (patch.end) {
        endInstant = patch.end.instant;
      } else {
        const duration = wasAllDay ? 3600000 : Math.max(0, current.endMs - current.startMs);
        endInstant = new Date(startInstant.getTime() + duration);
      }
      if (endInstant.getTime() <= startInstant.getTime()) {
        throw new UserError('end must be after start');
      }
      setDateTime(vcal, vevent, 'dtstart', startInstant, tz);
      setDateTime(vcal, vevent, 'dtend', endInstant, tz);
    }
    vevent.removeAllProperties('duration');
  }

  if (patch.alertMinutesBefore === null) {
    for (const alarm of vevent.getAllSubcomponents('valarm')) vevent.removeSubcomponent(alarm);
  } else if (patch.alertMinutesBefore !== undefined) {
    setAlarm(vevent, patch.alertMinutesBefore, String(vevent.getFirstPropertyValue('summary') ?? ''));
  }

  const seq = Number(vevent.getFirstPropertyValue('sequence') ?? 0);
  vevent.updatePropertyWithValue('sequence', Number.isFinite(seq) ? seq + 1 : 1);
  stamp(vevent);
  return vcal.toString() + '\r\n';
}

// ---------- reading ----------

function ymdOf(ms: number, tz: string, _allDay: boolean) {
  const w = toWallClock(new Date(ms), tz);
  return { year: w.year, month: w.month, day: w.day };
}

function tzidOf(vevent: ICAL.Component, name: string): string | null {
  const prop = vevent.getFirstProperty(name);
  const tzid = prop?.getParameter('tzid');
  return typeof tzid === 'string' ? tzid : null;
}

/** Convert an ical.js time to epoch ms. Bare dates become midnight in `userTz`. */
function toMs(time: ICAL.Time, tzid: string | null, userTz: string): number {
  const wall = {
    year: time.year,
    month: time.month,
    day: time.day,
    hour: time.isDate ? 0 : time.hour,
    minute: time.isDate ? 0 : time.minute,
    second: time.isDate ? 0 : time.second,
  };
  if (time.isDate) return fromWallClock(wall, userTz).getTime();
  const zoneId = time.zone?.tzid;
  if (zoneId === 'UTC') {
    return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  }
  if (tzid && isValidTimeZone(tzid)) return fromWallClock(wall, tzid).getTime();
  if (tzid && zoneId && zoneId !== 'floating') {
    // Non-IANA TZID (e.g. from Outlook) that the object's own VTIMEZONE defines.
    const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
    return naive - time.utcOffset() * 1000;
  }
  return fromWallClock(wall, userTz).getTime();
}

function readTimes(vevent: ICAL.Component, userTz: string) {
  const ev = new ICAL.Event(vevent);
  const start = ev.startDate;
  if (!start) throw new UserError('Event has no start time');
  const end = ev.endDate ?? start;
  const startTz = tzidOf(vevent, 'dtstart');
  const endTz = tzidOf(vevent, 'dtend') ?? startTz;
  return {
    allDay: start.isDate,
    startMs: toMs(start, startTz, userTz),
    endMs: toMs(end, endTz, userTz),
  };
}

function alarmsOf(vevent: ICAL.Component): number[] {
  const out: number[] = [];
  for (const alarm of vevent.getAllSubcomponents('valarm')) {
    const trigger = alarm.getFirstPropertyValue('trigger');
    if (trigger instanceof ICAL.Duration) {
      const minutes = Math.round(-trigger.toSeconds() / 60);
      if (minutes >= 0) out.push(minutes);
    }
  }
  return out.sort((a, b) => a - b);
}

const clip = (s: unknown, max: number): string | undefined => {
  if (typeof s !== 'string' || s.length === 0) return undefined;
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

function view(
  item: ICAL.Component,
  uid: string,
  startMs: number,
  endMs: number,
  allDay: boolean,
  recurring: boolean,
  userTz: string,
): EventView {
  let start: string;
  let end: string;
  if (allDay) {
    const s = ymdOf(startMs, userTz, true);
    const lastMs = Math.max(startMs, endMs - DAY_MS);
    const e = ymdOf(lastMs, userTz, true);
    start = formatDate(s.year, s.month, s.day);
    end = formatDate(e.year, e.month, e.day);
  } else {
    start = formatInZone(new Date(startMs), userTz);
    end = formatInZone(new Date(endMs), userTz);
  }
  const alerts = alarmsOf(item);
  return {
    uid,
    title: clip(item.getFirstPropertyValue('summary'), 200) ?? '(no title)',
    start,
    end,
    all_day: allDay,
    location: clip(item.getFirstPropertyValue('location'), 200),
    notes: clip(item.getFirstPropertyValue('description'), 300),
    recurring,
    alert_minutes_before: alerts.length ? alerts : undefined,
    startMs,
  };
}

/**
 * Read one calendar object. With a range, recurring events are expanded and
 * only occurrences that overlap [rangeStart, rangeEnd) are returned. Without a
 * range, the master event is returned once.
 */
export function readEvents(
  ics: string,
  userTz: string,
  range?: { start: Date; end: Date },
): EventView[] {
  let vcal: ICAL.Component;
  try {
    vcal = new ICAL.Component(ICAL.parse(ics));
  } catch {
    return [];
  }
  const vevents = vcal.getAllSubcomponents('vevent');
  if (vevents.length === 0) return [];
  const master = vevents.find((e) => !e.hasProperty('recurrence-id'));
  const out: EventView[] = [];

  const push = (item: ICAL.Component, startMs: number, endMs: number, allDay: boolean, recurring: boolean) => {
    if (range) {
      const effEnd = Math.max(endMs, startMs + 1);
      if (startMs >= range.end.getTime() || effEnd <= range.start.getTime()) return;
    }
    const uid = String(item.getFirstPropertyValue('uid') ?? '');
    out.push(view(item, uid, startMs, endMs, allDay, recurring, userTz));
  };

  if (!master) {
    // Only detached overrides are stored here (e.g. an invitation to one occurrence).
    for (const v of vevents) {
      try {
        const t = readTimes(v, userTz);
        push(v, t.startMs, t.endMs, t.allDay, true);
      } catch {
        /* skip unreadable component */
      }
    }
    return out;
  }

  const exceptions = vevents.filter((e) => e !== master);
  let ev: ICAL.Event;
  try {
    ev = new ICAL.Event(master, { exceptions: exceptions.map((e) => new ICAL.Event(e)) as never });
  } catch {
    return out;
  }

  if (!ev.isRecurring() || !range) {
    try {
      const t = readTimes(master, userTz);
      push(master, t.startMs, t.endMs, t.allDay, ev.isRecurring());
    } catch {
      /* skip */
    }
    return out;
  }

  const masterTz = tzidOf(master, 'dtstart');
  let it;
  try {
    it = ev.iterator();
  } catch {
    return out;
  }
  for (let i = 0; i < MAX_OCCURRENCE_STEPS; i++) {
    let next: ICAL.Time | null;
    try {
      next = it.next();
    } catch {
      break;
    }
    if (!next) break;
    const nominalMs = toMs(next, masterTz, userTz);
    // Overrides can move an occurrence, so allow a week of slack before stopping.
    if (nominalMs > range.end.getTime() + 7 * DAY_MS) break;
    let details;
    try {
      details = ev.getOccurrenceDetails(next);
    } catch {
      continue;
    }
    const item = details.item.component;
    const startTz = tzidOf(item, 'dtstart') ?? masterTz;
    const endTz = tzidOf(item, 'dtend') ?? startTz;
    const startMs = toMs(details.startDate, startTz, userTz);
    const endMs = toMs(details.endDate, endTz, userTz);
    if (item.getFirstPropertyValue('status') === 'CANCELLED') continue;
    push(item, startMs, endMs, details.startDate.isDate, true);
  }
  return out;
}
