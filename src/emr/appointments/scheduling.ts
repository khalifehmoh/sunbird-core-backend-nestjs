import { SCHEDULING } from '../emr.constants';

const MINUTE_MS = 60_000;

export type SlotStatus = 'free' | 'booked' | 'blocked';

export type Slot = {
  start: string;
  end: string;
  status: SlotStatus;
};

export type DaySlots = {
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  /** False on weekend days, when every slot is blocked. */
  working: boolean;
  slots: Slot[];
};

export type Interval = { start: number; end: number };

export type Clinic = {
  slotMinutes: number;
  dayStartHour: number;
  dayEndHour: number;
  utcOffsetMinutes: number;
  /** JS weekday numbers that are working days (0 = Sunday). */
  workingDays: readonly number[];
};

const CLINIC: Clinic = SCHEDULING;

/** Local wall-clock parts of an instant at the clinic's fixed UTC offset. */
export function localParts(ms: number, clinic: Clinic = CLINIC) {
  const local = new Date(ms + clinic.utcOffsetMinutes * MINUTE_MS);
  return {
    date: local.toISOString().slice(0, 10),
    weekday: local.getUTCDay(),
    minutesIntoDay: local.getUTCHours() * 60 + local.getUTCMinutes(),
    seconds: local.getUTCSeconds() + local.getUTCMilliseconds(),
  };
}

/** UTC instant (ms) of local midnight for `YYYY-MM-DD`. */
export function localMidnight(date: string, clinic: Clinic = CLINIC): number {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day) - clinic.utcOffsetMinutes * MINUTE_MS;
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

/**
 * Why a start time and duration cannot be booked, or `undefined` when they
 * can: it must sit on the slot grid, inside clinic hours on a working day.
 */
export function bookingProblem(
  startMs: number,
  durationMinutes: number,
  clinic: Clinic = CLINIC,
): string | undefined {
  if (durationMinutes <= 0 || durationMinutes % clinic.slotMinutes !== 0) {
    return `Duration must be a multiple of ${clinic.slotMinutes} minutes`;
  }
  const start = localParts(startMs, clinic);
  if (!clinic.workingDays.includes(start.weekday)) {
    return 'The clinic is closed on that day';
  }
  const opens = clinic.dayStartHour * 60;
  const closes = clinic.dayEndHour * 60;
  if (
    start.seconds !== 0 ||
    start.minutesIntoDay < opens ||
    (start.minutesIntoDay - opens) % clinic.slotMinutes !== 0
  ) {
    return `Appointments start on a ${clinic.slotMinutes}-minute boundary from ${String(clinic.dayStartHour).padStart(2, '0')}:00`;
  }
  if (start.minutesIntoDay + durationMinutes > closes) {
    return `The appointment would run past closing time (${String(clinic.dayEndHour).padStart(2, '0')}:00)`;
  }
  return undefined;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && a.end > b.start;
}

/**
 * The slot grid for one local day. A slot is `booked` when a busy interval
 * overlaps it, `blocked` when it has already started or the clinic is closed,
 * and `free` otherwise.
 */
export function buildDaySlots(
  date: string,
  busy: readonly Interval[],
  now: number,
  clinic: Clinic = CLINIC,
): DaySlots {
  const midnight = localMidnight(date, clinic);
  const weekday = localParts(midnight, clinic).weekday;
  const working = clinic.workingDays.includes(weekday);
  const slots: Slot[] = [];

  const first = clinic.dayStartHour * 60;
  const last = clinic.dayEndHour * 60;
  for (let minute = first; minute < last; minute += clinic.slotMinutes) {
    const interval = {
      start: midnight + minute * MINUTE_MS,
      end: midnight + (minute + clinic.slotMinutes) * MINUTE_MS,
    };
    let status: SlotStatus = 'free';
    if (!working || interval.start <= now) status = 'blocked';
    if (busy.some((other) => overlaps(interval, other))) status = 'booked';
    slots.push({
      start: new Date(interval.start).toISOString(),
      end: new Date(interval.end).toISOString(),
      status,
    });
  }
  return { date, working, slots };
}
