import { BusinessDateSchema, CustomerChatResponseSchema, type CustomerChatResponse } from '@flowpilot/contracts';
import { addCalendarDays, businessDate } from '@flowpilot/db';
import type { ExtractionInput, IntentExtractor } from './intent.js';
import { bookingClarification, bookingNextStep, isAvailabilityQuestion, normalizeBookingInput } from './booking-text.js';
export type { ExtractionInput, IntentExtractor } from './intent.js';

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Pure interpretation only: no database client, network, tools or booking effects.
export class MockIntentExtractor implements IntentExtractor {
  extract(source: ExtractionInput): CustomerChatResponse {
    const { input, notice } = normalizeBookingInput(source);
    const selection = { ...input.context };
    const needs = new Set<'service' | 'staff' | 'date' | 'duration' | 'time' | 'request'>();
    const finish = (intent: CustomerChatResponse['intent'], message: string) => CustomerChatResponseSchema.parse({
      provider: 'mock-v1', intent, selection, needsClarification: [...needs], message: notice + message,
      referenceTime: input.referenceTime.toISOString(), timezone: input.timezone,
    });
    if (!input.services.some((item) => item.id === selection.serviceId)) selection.serviceId = null;
    if (selection.staffId && !input.staff.some((item) => item.id === selection.staffId)) { selection.staffId = null; needs.add('staff'); }
    if (selection.durationMinutes && selection.durationMinutes > input.maximum) { selection.durationMinutes = null; needs.add('duration'); }
    const today = businessDate(input.referenceTime, input.timezone);
    if (selection.date && selection.date < today) selection.date = null;
    if (isAvailabilityQuestion(input.message)) {
      if (!selection.serviceId) needs.add('service');
      if (!selection.date) needs.add('date');
      if (!selection.durationMinutes) needs.add('duration');
      return finish(needs.size ? 'UNKNOWN' : 'VIEW_AVAILABILITY', needs.size ? bookingClarification(needs, input) : bookingNextStep);
    }
    let remaining = input.message.toLowerCase();
    if (/\b(cancel|reschedule)\b/.test(remaining)) {
      needs.add('request');
      return finish('CANCEL_REQUEST', 'Cancellation and rescheduling are not available here yet. Please use the manual fallback and contact the demo operator.');
    }
    if (/\b(confirm|confirmed|yes|sql|ignore|system|execute|http)\b/.test(remaining)) {
      needs.add('request');
      return finish('UNKNOWN', 'Chat cannot confirm or run commands. Review a real appointment and use the separate Confirm appointment button.');
    }
    for (const [items, field, need] of [[input.services, 'serviceId', 'service'], [input.staff, 'staffId', 'staff']] as const) {
      const matches = items.filter((item) => new RegExp('\\b' + escape(item.name.toLowerCase()) + '\\b').test(remaining));
      if (matches.length > 1) { selection[field] = null; needs.add(need); }
      else if (matches.length === 1) { selection[field] = matches[0]!.id; needs.delete(need); }
      for (const item of matches) remaining = remaining.replace(new RegExp('\\b' + escape(item.name.toLowerCase()) + '\\b', 'g'), ' ');
    }
    if (/\bany staff\b/.test(remaining)) { selection.staffId = null; needs.delete('staff'); remaining = remaining.replace(/\bany staff\b/g, ' '); }
    const dates: string[] = [];
    remaining = remaining.replace(/\b(today|tomorrow)\b/g, (value) => { dates.push(value === 'today' ? today : addCalendarDays(today, 1)); return ' '; });
    remaining = remaining.replace(/\b(\d{2})-(\d{2})-(\d{4})\b/g, (_match, day: string, month: string, year: string) => { dates.push(`${year}-${month}-${day}`); return ' '; });
    if (dates.length) {
      const parsed = BusinessDateSchema.safeParse(dates[0]);
      if (dates.length !== 1 || !parsed.success || parsed.data < today) { selection.date = null; needs.add('date'); }
      else selection.date = parsed.data;
    }
    const durations: number[] = [];
    remaining = remaining.replace(/\b(\d+)\s*(minutes?|mins?|hours?)\b/g, (_match, amount: string, unit: string) => {
      durations.push(Number(amount) * (unit.startsWith('hour') ? 60 : 1)); return ' ';
    });
    if (durations.length) {
      const duration = durations[0]!;
      if (durations.length !== 1 || duration < 30 || duration % 30 !== 0 || duration > input.maximum) { selection.durationMinutes = null; needs.add('duration'); }
      else { selection.durationMinutes = duration; needs.delete('duration'); }
    }
    if (/\b(morning|afternoon|evening|am|pm)\b|\d:\d/.test(remaining)) needs.add('time');
    // Deliberately small English grammar. Unknown/negated instructions never
    // silently modify a prior selection or invent a service/date/time.
    remaining = remaining.replace(/\b(book|booking|appointment|availability|available|show|me|i|would|like|a|an|for|on|with|please|and)\b/g, ' ').replace(/[\s.,!?]+/g, '');
    if (remaining) needs.add('request');
    if (!selection.serviceId) needs.add('service');
    if (!selection.date) needs.add('date');
    if (!selection.durationMinutes) needs.add('duration');
    if (needs.size) return finish('UNKNOWN', bookingClarification(needs, input));
    return finish(/\bbook|appointment/i.test(input.message) ? 'BOOK_APPOINTMENT' : 'VIEW_AVAILABILITY', bookingNextStep);
  }
}
