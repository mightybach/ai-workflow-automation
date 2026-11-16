const datePattern = /^\d{4}-\d{2}-\d{2}$/;
function checkedDate(date: string) {
  // Allow the next year internally so bounds for API date 2100-12-31 work.
  if (!datePattern.test(date) || date < '2000-01-01' || date > '2101-12-31') throw new Error('Invalid business date.');
  const parsed = new Date(date + 'T00:00:00Z');
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error('Invalid business date.');
  return parsed;
}
export function addCalendarDays(date: string, days: number) {
  const parsed = checkedDate(date);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}
export function businessDate(instant: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return part('year') + '-' + part('month') + '-' + part('day');
}

// Converts a specific local wall-clock time, not by assuming a fixed UTC offset.
// Nonexistent local times fail instead of silently shifting to another time.
// The seeded schedule uses daytime Brisbane hours; arbitrary ambiguous booking
// preferences require a separate disambiguation policy in the booking phase.
export function localBusinessInstant(date: string, timezone: string, hour = 0, minute = 0) {
  const parsed = checkedDate(date);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error('Invalid local time.');
  const desired = Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate(), hour, minute);
  const formatter = new Intl.DateTimeFormat('en', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  let guess = desired;
  for (let attempt = 0; attempt < 5; attempt++) {
    const parts = formatter.formatToParts(new Date(guess));
    const part = (type: string) => Number(parts.find((item) => item.type === type)!.value);
    const observed = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
    const difference = desired - observed;
    if (difference === 0) return new Date(guess);
    guess += difference;
  }
  throw new Error('Local time does not exist or requires clarification.');
}
export function businessDayBounds(date: string, timezone: string) {
  return { start: localBusinessInstant(date, timezone), end: localBusinessInstant(addCalendarDays(date, 1), timezone) };
}

