/**
 * CalDAV access (iCloud by default) through tsdav.
 * The app-specific password only ever lives in memory inside the DAV client.
 */
import { DAVClient, type DAVCalendar, type DAVCalendarObject } from 'tsdav';
import type { Config } from './config.js';
import { buildEvent, patchEvent, readEvents, type EventPatch, type EventView, type NewEvent } from './ical.js';
import { UserError } from './time.js';

export interface CalendarInfo {
  id: string;
  name: string;
  color?: string;
  is_default: boolean;
}

export interface EventResult extends Omit<EventView, 'startMs' | 'uid'> {
  event_id: string;
  calendar: string;
}

const CLIENT_TTL_MS = 10 * 60 * 1000;
const CALENDARS_TTL_MS = 60 * 1000;
const MAX_RANGE_DAYS = 400;
export const MAX_EVENTS = 100;

interface Session {
  key: string;
  client: DAVClient;
  createdAt: number;
  calendars?: { at: number; list: DAVCalendar[] };
}
let session: Session | undefined;

export function resetCalDavSession(): void {
  session = undefined;
}

function lastSegment(url: string): string {
  const path = new URL(url).pathname.replace(/\/+$/, '');
  return path.slice(path.lastIndexOf('/') + 1);
}

const SAFE_SEGMENT = /^[^/?#\\\s]+$/;

export function encodeEventId(calendarId: string, filename: string): string {
  return Buffer.from(JSON.stringify([calendarId, filename]), 'utf8').toString('base64url');
}

export function decodeEventId(eventId: string): { calendarId: string; filename: string } {
  try {
    const parsed = JSON.parse(Buffer.from(eventId, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed.every((p) => typeof p === 'string' && SAFE_SEGMENT.test(p) && p !== '.' && p !== '..')
    ) {
      return { calendarId: parsed[0], filename: parsed[1] };
    }
  } catch {
    /* fall through */
  }
  throw new UserError(
    'event_id is not valid. Use the event_id returned by get_events or create_event, unchanged.',
  );
}

function describeFailure(action: string, status?: number): UserError {
  if (status === 401 || status === 403) {
    return new UserError(
      `iCloud refused the sign-in while trying to ${action} (HTTP ${status}). The Apple ID or app-specific password on the server is wrong or was revoked.`,
    );
  }
  if (status === 404) return new UserError(`Could not ${action}: not found (it may have been deleted).`);
  if (status === 412) {
    return new UserError(
      `Could not ${action}: the event was changed somewhere else at the same time. Read it again with get_events and retry.`,
    );
  }
  if (status === 429 || (status !== undefined && status >= 500)) {
    return new UserError(`iCloud is busy or unavailable (HTTP ${status}) while trying to ${action}. Try again in a moment.`);
  }
  return new UserError(`Could not ${action}${status ? ` (HTTP ${status})` : ''}.`);
}

export class CalendarStore {
  constructor(private readonly cfg: Config) {}

  private async client(): Promise<Session> {
    if (!this.cfg.appleId || !this.cfg.appleAppPassword) {
      throw new UserError(
        'The server has no Apple credentials yet. Set APPLE_ID and APPLE_APP_PASSWORD in the hosting environment and redeploy.',
      );
    }
    const key = `${this.cfg.caldavUrl}|${this.cfg.appleId}`;
    if (session && session.key === key && Date.now() - session.createdAt < CLIENT_TTL_MS) {
      return session;
    }
    const client = new DAVClient({
      serverUrl: this.cfg.caldavUrl,
      credentials: { username: this.cfg.appleId, password: this.cfg.appleAppPassword },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    });
    try {
      await client.login();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (/invalid credentials|401|unauthor/i.test(msg)) throw describeFailure('sign in to iCloud', 401);
      throw new UserError('Could not reach the CalDAV server to sign in. Try again in a moment.');
    }
    session = { key, client, createdAt: Date.now() };
    return session;
  }

  private async rawCalendars(): Promise<DAVCalendar[]> {
    const s = await this.client();
    if (s.calendars && Date.now() - s.calendars.at < CALENDARS_TTL_MS) return s.calendars.list;
    let list: DAVCalendar[];
    try {
      list = await s.client.fetchCalendars();
    } catch {
      resetCalDavSession();
      throw new UserError('Could not load the calendar list from the CalDAV server. Try again in a moment.');
    }
    list = list.filter((c) => !c.components || c.components.length === 0 || c.components.includes('VEVENT'));
    s.calendars = { at: Date.now(), list };
    return list;
  }

  private nameOf(c: DAVCalendar): string {
    return typeof c.displayName === 'string' && c.displayName ? c.displayName : lastSegment(c.url);
  }

  private defaultOf(list: DAVCalendar[]): DAVCalendar | undefined {
    const wanted = this.cfg.defaultCalendarName.toLowerCase();
    return list.find((c) => this.nameOf(c).toLowerCase() === wanted);
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const list = await this.rawCalendars();
    const def = this.defaultOf(list);
    return list.map((c) => ({
      id: lastSegment(c.url),
      name: this.nameOf(c),
      color: typeof (c as { calendarColor?: unknown }).calendarColor === 'string'
        ? ((c as { calendarColor?: string }).calendarColor as string)
        : undefined,
      is_default: c === def,
    }));
  }

  private async resolveCalendar(calendarId?: string): Promise<DAVCalendar> {
    const list = await this.rawCalendars();
    if (calendarId) {
      const wanted = calendarId.toLowerCase();
      const found =
        list.find((c) => lastSegment(c.url) === calendarId) ??
        list.find((c) => this.nameOf(c).toLowerCase() === wanted);
      if (!found) {
        throw new UserError(
          `No calendar with id or name "${calendarId}". Available: ${list.map((c) => this.nameOf(c)).join(', ')}`,
        );
      }
      return found;
    }
    const def = this.defaultOf(list);
    if (!def) {
      throw new UserError(
        `The default calendar "${this.cfg.defaultCalendarName}" does not exist in iCloud. Create it in the Calendar app, or pass calendar_id. Available: ${list.map((c) => this.nameOf(c)).join(', ')}`,
      );
    }
    return def;
  }

  private toResult(view: EventView, calendar: DAVCalendar, objectUrl: string): EventResult {
    const { startMs: _s, uid: _u, ...rest } = view;
    return {
      event_id: encodeEventId(lastSegment(calendar.url), lastSegment(objectUrl)),
      calendar: this.nameOf(calendar),
      ...rest,
    };
  }

  async getEvents(
    start: Date,
    end: Date,
    calendarId?: string,
  ): Promise<{ events: EventResult[]; truncated: boolean }> {
    if (end.getTime() <= start.getTime()) throw new UserError('end must be after start');
    if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * 86400000) {
      throw new UserError(`The range is too long. Ask for at most ${MAX_RANGE_DAYS} days at a time.`);
    }
    const s = await this.client();
    const calendars = calendarId ? [await this.resolveCalendar(calendarId)] : await this.rawCalendars();
    const perCalendar = await Promise.all(
      calendars.map(async (calendar) => {
        let objects: DAVCalendarObject[];
        try {
          objects = await s.client.fetchCalendarObjects({
            calendar,
            timeRange: { start: start.toISOString(), end: end.toISOString() },
          });
        } catch {
          throw new UserError(`Could not read events from "${this.nameOf(calendar)}". Try again in a moment.`);
        }
        const rows: { view: EventView; result: EventResult }[] = [];
        for (const obj of objects) {
          if (typeof obj.data !== 'string') continue;
          for (const v of readEvents(obj.data, this.cfg.timezone, { start, end })) {
            rows.push({ view: v, result: this.toResult(v, calendar, new URL(obj.url, calendar.url).href) });
          }
        }
        return rows;
      }),
    );
    const all = perCalendar.flat().sort((a, b) => a.view.startMs - b.view.startMs);
    return { events: all.slice(0, MAX_EVENTS).map((r) => r.result), truncated: all.length > MAX_EVENTS };
  }

  async createEvent(input: NewEvent, calendarId?: string): Promise<EventResult> {
    const s = await this.client();
    const calendar = await this.resolveCalendar(calendarId);
    const { uid, ics } = buildEvent(input, this.cfg.timezone);
    const filename = `${uid}.ics`;
    let res: Response;
    try {
      res = await s.client.createCalendarObject({ calendar, filename, iCalString: ics });
    } catch {
      throw describeFailure('create the event');
    }
    if (!res.ok) throw describeFailure('create the event', res.status);
    const view = readEvents(ics, this.cfg.timezone)[0];
    return this.toResult(view, calendar, new URL(filename, withSlash(calendar.url)).href);
  }

  private async loadObject(eventId: string): Promise<{ calendar: DAVCalendar; object: DAVCalendarObject; url: string }> {
    const { calendarId, filename } = decodeEventId(eventId);
    const s = await this.client();
    const list = await this.rawCalendars();
    const calendar = list.find((c) => lastSegment(c.url) === calendarId);
    if (!calendar) throw new UserError('The calendar for that event_id no longer exists.');
    const url = new URL(filename, withSlash(calendar.url)).href;
    let objects: DAVCalendarObject[];
    try {
      objects = await s.client.fetchCalendarObjects({ calendar, objectUrls: [url], urlFilter: () => true });
    } catch {
      throw describeFailure('load the event');
    }
    const object = objects.find((o) => typeof o.data === 'string' && o.data.includes('BEGIN:VEVENT'));
    if (!object) throw describeFailure('load the event', 404);
    return { calendar, object, url };
  }

  async updateEvent(eventId: string, patch: EventPatch): Promise<EventResult> {
    const s = await this.client();
    const { calendar, object, url } = await this.loadObject(eventId);
    const ics = patchEvent(object.data as string, patch, this.cfg.timezone);
    let res: Response;
    try {
      res = await s.client.updateCalendarObject({ calendarObject: { url, data: ics, etag: object.etag } });
    } catch {
      throw describeFailure('update the event');
    }
    if (!res.ok) throw describeFailure('update the event', res.status);
    const view = readEvents(ics, this.cfg.timezone)[0];
    return this.toResult(view, calendar, url);
  }

  async deleteEvent(eventId: string): Promise<{ deleted: EventResult }> {
    const s = await this.client();
    const { calendar, object, url } = await this.loadObject(eventId);
    const view = readEvents(object.data as string, this.cfg.timezone)[0];
    let res: Response;
    try {
      res = await s.client.deleteCalendarObject({ calendarObject: { url, etag: object.etag } });
    } catch {
      throw describeFailure('delete the event');
    }
    if (!res.ok) throw describeFailure('delete the event', res.status);
    return { deleted: this.toResult(view, calendar, url) };
  }
}

function withSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}
