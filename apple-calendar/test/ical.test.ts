import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEvent, patchEvent, readEvents } from '../src/ical.js';
import { formatInZone, hasFixedOffset, parseIsoInput, UserError } from '../src/time.js';

const tz = 'Asia/Bangkok';
const p = (v: string, zone = tz) => parseIsoInput(v, zone, 'value');

test('parseIsoInput reads offset-less values in the user zone', () => {
  assert.equal(p('2026-11-20T16:00').instant.toISOString(), '2026-11-20T09:00:00.000Z');
  assert.equal(p('2026-11-20T16:00:00Z').instant.toISOString(), '2026-11-20T16:00:00.000Z');
  assert.equal(p('2026-11-20T16:00:00-05:00').instant.toISOString(), '2026-11-20T21:00:00.000Z');
  assert.equal(p('2026-11-20').dateOnly, true);
  assert.throws(() => p('20 Nov 2026'), UserError);
  assert.throws(() => p('2026-02-30T10:00'), UserError);
});

test('DST zones convert correctly on both sides of a transition', () => {
  assert.equal(p('2026-07-01T09:00', 'America/New_York').instant.toISOString(), '2026-07-01T13:00:00.000Z');
  assert.equal(p('2026-12-01T09:00', 'America/New_York').instant.toISOString(), '2026-12-01T14:00:00.000Z');
  assert.equal(hasFixedOffset('Asia/Bangkok'), true);
  assert.equal(hasFixedOffset('America/New_York'), false);
  assert.equal(formatInZone(new Date('2026-11-20T09:00:00Z'), tz), '2026-11-20T16:00:00+07:00');
});

test('timed event is written with TZID, VTIMEZONE and VALARM', () => {
  const { ics } = buildEvent(
    { title: 'หมอฟัน', start: p('2026-11-20T16:00'), end: p('2026-11-20T17:00'), allDay: false, alertMinutesBefore: 30 },
    tz,
  );
  assert.match(ics, /DTSTART;TZID=Asia\/Bangkok:20261120T160000\r\n/);
  assert.match(ics, /DTEND;TZID=Asia\/Bangkok:20261120T170000\r\n/);
  assert.match(ics, /BEGIN:VTIMEZONE\r\nTZID:Asia\/Bangkok/);
  assert.match(ics, /BEGIN:VALARM[\s\S]*ACTION:DISPLAY[\s\S]*TRIGGER:-PT30M[\s\S]*END:VALARM/);
  const [ev] = readEvents(ics, tz);
  assert.equal(ev.start, '2026-11-20T16:00:00+07:00');
  assert.deepEqual(ev.alert_minutes_before, [30]);
});

test('a DST zone falls back to UTC', () => {
  const zone = 'America/New_York';
  const { ics } = buildEvent({ title: 'x', start: p('2026-11-20T16:00', zone), end: p('2026-11-20T17:00', zone), allDay: false }, zone);
  assert.match(ics, /DTSTART:20261120T210000Z/);
  assert.equal(readEvents(ics, zone)[0].start, '2026-11-20T16:00:00-05:00');
});

test('all-day event uses an exclusive DTEND and reads back inclusive', () => {
  const { ics } = buildEvent({ title: 'Trail', start: p('2026-12-05'), end: p('2026-12-07'), allDay: true }, tz);
  assert.match(ics, /DTSTART;VALUE=DATE:20261205/);
  assert.match(ics, /DTEND;VALUE=DATE:20261208/);
  const [ev] = readEvents(ics, tz);
  assert.deepEqual([ev.start, ev.end, ev.all_day], ['2026-12-05', '2026-12-07', true]);
});

test('validation errors are user-facing', () => {
  assert.throws(() => buildEvent({ title: 'x', start: p('2026-11-20T16:00'), end: p('2026-11-20T15:00'), allDay: false }, tz), /end must be after start/);
  assert.throws(() => buildEvent({ title: 'x', start: p('2026-11-20T16:00'), allDay: false }, tz), /end is required/);
});

test('weekly recurrence expands only inside the range', () => {
  const { ics } = buildEvent(
    { title: 'Run', start: p('2026-11-02T06:00'), end: p('2026-11-02T07:00'), allDay: false, recurrence: { frequency: 'weekly', count: 10 } },
    tz,
  );
  assert.match(ics, /RRULE:FREQ=WEEKLY;COUNT=10/);
  const got = readEvents(ics, tz, { start: p('2026-11-16').instant, end: p('2026-11-30').instant });
  assert.deepEqual(got.map((e) => e.start), ['2026-11-16T06:00:00+07:00', '2026-11-23T06:00:00+07:00']);
  assert.equal(got[0].recurring, true);
});

test('patch keeps duration, bumps SEQUENCE and preserves foreign properties', () => {
  const original = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//iOS 18//EN',
    'BEGIN:VEVENT', 'UID:ABC', 'SUMMARY:Lunch', 'DTSTART;TZID=Asia/Bangkok:20261120T120000',
    'DTEND;TZID=Asia/Bangkok:20261120T133000', 'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC', 'SEQUENCE:2',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
  const out = patchEvent(original, { start: p('2026-11-21T18:00'), title: 'Dinner' }, tz);
  assert.match(out, /SUMMARY:Dinner/);
  assert.match(out, /DTSTART;TZID=Asia\/Bangkok:20261121T180000/);
  assert.match(out, /DTEND;TZID=Asia\/Bangkok:20261121T193000/);
  assert.match(out, /SEQUENCE:3/);
  assert.match(out, /X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC/);
  assert.match(out, /TRIGGER:-PT15M/);
  const noAlarm = patchEvent(out, { alertMinutesBefore: null }, tz);
  assert.doesNotMatch(noAlarm, /VALARM/);
  assert.throws(() => patchEvent(original, { end: p('2026-11-21') }, tz), /timed event/);
});

test('UTC and foreign-zone events are shown in the user zone', () => {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:U1', 'SUMMARY:Call',
    'DTSTART;TZID=America/New_York:20261120T090000', 'DTEND:20261120T150000Z', 'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
  const [ev] = readEvents(ics, tz);
  assert.equal(ev.start, '2026-11-20T21:00:00+07:00');
  assert.equal(ev.end, '2026-11-20T22:00:00+07:00');
});
