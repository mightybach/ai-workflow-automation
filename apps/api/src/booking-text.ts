import type { ExtractionInput } from './intent.js';

// Only canonical domain vocabulary is stored, never a list of misspellings.
const dateWords = ['today', 'tomorrow'] as const;
const unitGroups = [['minute', 'minutes'], ['hour', 'hours']] as const;
const exactWords = new Set<string>([...dateWords, ...unitGroups.flat(), 'min', 'mins', 'hr', 'hrs']);
const durationPrefix = /(?:^|\s)(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirty|sixty|ninety)\s+$/i;

// Optimal string alignment distance: insertion/deletion/substitution plus an
// adjacent letter swap. Callers bound tokens to 12 characters before comparison.
export function spellingDistance(left: string, right: string) {
  const matrix = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
  for (let i = 0; i <= left.length; i++) matrix[i]![0] = i;
  for (let j = 0; j <= right.length; j++) matrix[0]![j] = j;
  for (let i = 1; i <= left.length; i++) for (let j = 1; j <= right.length; j++) {
    matrix[i]![j] = Math.min(matrix[i - 1]![j]! + 1, matrix[i]![j - 1]! + 1,
      matrix[i - 1]![j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
      matrix[i]![j] = Math.min(matrix[i]![j]!, matrix[i - 2]![j - 2]! + 1);
    }
  }
  return matrix[left.length]![right.length]!;
}

function closestGroup(word: string, groups: readonly (readonly string[])[], limit: number) {
  const ranked = groups.map((words, index) => ({ index, distance: Math.min(...words.map((candidate) => spellingDistance(word, candidate))) }))
    .sort((a, b) => a.distance - b.distance);
  const best = ranked[0];
  return best && best.distance <= limit && best.distance < (ranked[1]?.distance ?? Infinity) ? best.index : null;
}

function correctedWord(word: string, prefix: string) {
  if (!/^[a-z]{4,12}$/.test(word) || exactWords.has(word)) return null;
  if (/\b(?:with|named|called)\s+$/i.test(prefix)) return null;
  const duration = durationPrefix.exec(prefix);
  if (duration) {
    const unit = closestGroup(word, unitGroups, word.length >= 6 ? 2 : 1);
    if (unit === null) return null;
    const singular = /^(?:1|a|an|one)$/i.test(duration[1]!);
    return unitGroups[unit]![singular ? 0 : 1];
  }
  // Date-like text or an explicit date position; never spell-check arbitrary
  // prose, numeric dates or a person named after "with".
  if (!word.startsWith('t') && !/\b(?:on|for)\s+$/i.test(prefix)) return null;
  const dateLimit = word.startsWith('tom') && word.length >= 7 && word.length <= 9 ? 3 : word.length >= 7 ? 2 : 1;
  const date = closestGroup(word, dateWords.map((candidate) => [candidate]), dateLimit);
  return date === null ? null : dateWords[date]!;
}
export const bookingNextStep = 'Your details are filled in below. View available times, choose a time, then review and click "Confirm booking". Nothing is booked yet.';

export function isAvailabilityQuestion(message: string) {
  return /^(?:what (?:is|are) (?:the )?available (?:times?|slots?|appointments?)|what times? (?:is|are) available|show (?:me )?(?:the )?(?:available )?(?:times?|slots?|appointments?))[?.!]*$/i.test(message.trim());
}

export function bookingClarification(needs: ReadonlySet<string>, input: ExtractionInput) {
  if (needs.has('service')) {
    const names = input.services.slice(0, 2).map((item) => item.name.slice(0, 40));
    return 'Which service would you like?' + (names.length ? ' You can choose ' + names.join(' or ') + '.' : ' Choose a service in the booking form.');
  }
  if (needs.has('date')) return 'What date would you like? You can say tomorrow or enter a date as dd-mm-yyyy.';
  if (needs.has('duration')) return `How long would you like the appointment to be? Use 30-minute increments, up to ${input.maximum} minutes.`;
  if (needs.has('staff')) return 'Which staff member would you like? Use a name from the form, or say any staff.';
  if (needs.has('time')) return 'Please choose a specific time from the available appointments below. I cannot apply that time preference automatically.';
  return 'I could not interpret that request confidently. Tell me the service, date and appointment length, or use the form below. Chat cannot confirm bookings.';
}

export function normalizeBookingInput(source: ExtractionInput) {
  // Exact catalog labels always take precedence over spelling suggestions.
  const protectedWords = new Set([...source.services, ...source.staff].flatMap((item) => item.name.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []));
  const changes = new Map<string, string>();
  const message = source.message.replace(/[\p{L}\p{N}_]+/gu, (word, offset: number) => {
    const key = word.toLowerCase();
    const replacement = protectedWords.has(key) ? null : correctedWord(key, source.message.slice(0, offset));
    if (!replacement) return word;
    changes.set(key, replacement);
    return replacement;
  });
  const notice = changes.size ? 'Spelling adjusted: ' + [...changes].slice(0, 3).map(([from, to]) => `${from} → ${to}`).join('; ') + '. ' : '';
  return { input: { ...source, message }, notice };
}
