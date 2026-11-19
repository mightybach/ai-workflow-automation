import { BusinessDateSchema } from '@flowpilot/contracts';

// Consume whole numeric date tokens, including unsupported/invalid formats, so
// a suffix of an ISO date or malformed year is never interpreted as day-month.
export const numericBookingDates = () => /(?<![\p{L}\p{N}_/-])\d+(?:-\d+)+(?![\p{L}\p{N}_/-])/gu;
export function resolveNumericBookingDate(text: string, today: string): string | null {
  const match = /^(\d{1,2})-(\d{1,2})(?:-(\d{4}))?$/.exec(text);
  if (!match) return null;
  const dayMonth = `${match[2]!.padStart(2, '0')}-${match[1]!.padStart(2, '0')}`;
  const year = match[3] ?? String(Number(today.slice(0, 4)) + (dayMonth < today.slice(5) ? 1 : 0));
  const date = `${year}-${dayMonth}`;
  return BusinessDateSchema.safeParse(date).success && date >= today ? date : null;
}
export const assumedYearNotice = (text: string, date: string) => /^\d{1,2}-\d{1,2}$/.test(text) ? `Using ${date.split('-').reverse().join('-')} for ${text}. ` : '';
