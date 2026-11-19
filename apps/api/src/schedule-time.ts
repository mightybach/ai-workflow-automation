import { addCalendarDays } from '@flowpilot/db';
import { ApiError } from './errors.js';

// Resolve only a unique wall-clock boundary. Never guess through a DST gap/fold.
function wallInstant(date: string, minutes: number, timezone: string) {
  if (minutes === 1440) { date = addCalendarDays(date, 1); minutes = 0; }
  const naive = Date.parse(date + 'T00:00:00Z') + minutes * 60000;
  const formatter = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const serial = (instant: number) => {
    const parts = formatter.formatToParts(new Date(instant));
    const get = (type: string) => Number(parts.find((part) => part.type === type)!.value);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  };
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) { const sample = naive + hours * 3600000; offsets.add(serial(sample) - sample); }
  const matches = [...offsets].map((offset) => naive - offset).filter((candidate) => serial(candidate) === naive);
  if (matches.length !== 1) throw new ApiError(409, 'LOCAL_TIME_AMBIGUOUS', 'A boundary is missing or ambiguous in this business time zone. Choose a different time.');
  return new Date(matches[0]!);
}
export function scheduleRange(input: { date: string; startMinute: number; endMinute: number }, timezone: string) {
  const startAt = wallInstant(input.date, input.startMinute, timezone); const endAt = wallInstant(input.date, input.endMinute, timezone);
  if (+endAt <= +startAt || +endAt - +startAt > 172800000 || +startAt % 1800000 || +endAt % 1800000) {
    throw new ApiError(409, 'UNSUPPORTED_TIME_ALIGNMENT', 'This interval does not fit the supported UTC 30-minute inventory grid.');
  }
  return { startAt, endAt };
}
