import {
  addDays,
  bookingProblem,
  buildDaySlots,
  localMidnight,
  localParts,
  overlaps,
} from './scheduling';

// Riyadh is UTC+3. 2026-10-04 is a Sunday; 2026-10-09 is a Friday.
const SUNDAY = '2026-10-04';
const FRIDAY = '2026-10-09';
const at = (date: string, hhmm: string) =>
  localMidnight(date) +
  (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))) * 60_000;
const LONG_AGO = Date.parse('2026-01-01T00:00:00Z');

describe('scheduling', () => {
  it('reads local wall-clock time at UTC+3', () => {
    expect(localParts(Date.parse('2026-10-04T05:30:00Z'))).toMatchObject({
      date: '2026-10-04',
      weekday: 0,
      minutesIntoDay: 8 * 60 + 30,
    });
    // 22:00 UTC is already the next local day.
    expect(localParts(Date.parse('2026-10-03T22:00:00Z')).date).toBe(
      '2026-10-04',
    );
  });

  it('adds days across month ends', () => {
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  describe('bookingProblem', () => {
    it('accepts a slot-aligned start inside clinic hours', () => {
      expect(bookingProblem(at(SUNDAY, '08:00'), 30)).toBeUndefined();
      expect(bookingProblem(at(SUNDAY, '15:30'), 30)).toBeUndefined();
      expect(bookingProblem(at(SUNDAY, '14:00'), 120)).toBeUndefined();
    });

    it('rejects a start that is off the 30-minute grid', () => {
      expect(bookingProblem(at(SUNDAY, '08:15'), 30)).toMatch(/boundary/);
    });

    it('rejects a start before opening or at/after closing', () => {
      expect(bookingProblem(at(SUNDAY, '07:30'), 30)).toMatch(/boundary/);
      expect(bookingProblem(at(SUNDAY, '16:00'), 30)).toMatch(
        /closing|boundary/,
      );
    });

    it('rejects an appointment that runs past closing', () => {
      expect(bookingProblem(at(SUNDAY, '15:30'), 60)).toMatch(/closing/);
    });

    it('rejects a closed day', () => {
      expect(bookingProblem(at(FRIDAY, '09:00'), 30)).toMatch(/closed/);
    });

    it('rejects durations that are not whole slots', () => {
      expect(bookingProblem(at(SUNDAY, '09:00'), 45)).toMatch(/multiple/);
      expect(bookingProblem(at(SUNDAY, '09:00'), 0)).toMatch(/multiple/);
    });

    it('rejects a start with stray seconds', () => {
      expect(bookingProblem(at(SUNDAY, '09:00') + 5_000, 30)).toMatch(
        /boundary/,
      );
    });
  });

  describe('buildDaySlots', () => {
    it('lays out sixteen 30-minute slots from 08:00 to 16:00', () => {
      const day = buildDaySlots(SUNDAY, [], LONG_AGO);
      expect(day.working).toBe(true);
      expect(day.slots).toHaveLength(16);
      expect(day.slots[0]).toEqual({
        start: '2026-10-04T05:00:00.000Z',
        end: '2026-10-04T05:30:00.000Z',
        status: 'free',
      });
      expect(day.slots[15].end).toBe('2026-10-04T13:00:00.000Z');
      expect(day.slots.every((slot) => slot.status === 'free')).toBe(true);
    });

    it('marks slots overlapped by a busy interval as booked', () => {
      const day = buildDaySlots(
        SUNDAY,
        [{ start: at(SUNDAY, '09:00'), end: at(SUNDAY, '10:00') }],
        LONG_AGO,
      );
      const booked = day.slots
        .filter((slot) => slot.status === 'booked')
        .map((slot) => localParts(Date.parse(slot.start)).minutesIntoDay);
      expect(booked).toEqual([9 * 60, 9 * 60 + 30]);
    });

    it('does not book a slot that merely touches a busy interval', () => {
      const day = buildDaySlots(
        SUNDAY,
        [{ start: at(SUNDAY, '09:00'), end: at(SUNDAY, '09:30') }],
        LONG_AGO,
      );
      expect(day.slots.filter((s) => s.status === 'booked')).toHaveLength(1);
    });

    it('blocks slots that have already started', () => {
      const day = buildDaySlots(SUNDAY, [], at(SUNDAY, '10:00'));
      const statuses = day.slots.map((slot) => slot.status);
      // 08:00 .. 10:00 are past (5 slots); 10:00 has started, so it is blocked.
      expect(statuses.slice(0, 5)).toEqual(Array(5).fill('blocked'));
      expect(statuses.slice(5).every((s) => s === 'free')).toBe(true);
    });

    it('blocks every slot on a closed day', () => {
      const day = buildDaySlots(FRIDAY, [], LONG_AGO);
      expect(day.working).toBe(false);
      expect(day.slots.every((slot) => slot.status === 'blocked')).toBe(true);
    });

    it('keeps a booked slot booked even once it is in the past', () => {
      const day = buildDaySlots(
        SUNDAY,
        [{ start: at(SUNDAY, '08:00'), end: at(SUNDAY, '08:30') }],
        at(SUNDAY, '12:00'),
      );
      expect(day.slots[0].status).toBe('booked');
    });
  });

  it('detects interval overlap', () => {
    expect(overlaps({ start: 0, end: 10 }, { start: 5, end: 15 })).toBe(true);
    expect(overlaps({ start: 0, end: 10 }, { start: 10, end: 20 })).toBe(false);
  });
});
