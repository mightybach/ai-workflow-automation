import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addCalendarDays, businessDate, businessDayBounds, demoSlotTimes, localBusinessInstant } from '@flowpilot/db';

test('Brisbane local day correctly crosses a UTC date boundary', () => {
  assert.equal(businessDate(new Date('2026-11-15T15:00:00Z'), 'Australia/Brisbane'), '2026-11-16');
  const bounds = businessDayBounds('2026-11-16', 'Australia/Brisbane');
  assert.equal(bounds.start.toISOString(), '2026-11-15T14:00:00.000Z');
  assert.equal(bounds.end.toISOString(), '2026-11-16T14:00:00.000Z');
  assert.equal(localBusinessInstant('2026-11-16', 'Australia/Brisbane', 9).toISOString(), '2026-11-15T23:00:00.000Z');
});
test('business day bounds use the next local day across DST, not a fixed 24 hours', () => {
  const spring = businessDayBounds('2026-03-08', 'America/New_York');
  const autumn = businessDayBounds('2026-11-01', 'America/New_York');
  assert.equal(spring.end.getTime() - spring.start.getTime(), 23 * 60 * 60 * 1000);
  assert.equal(autumn.end.getTime() - autumn.start.getTime(), 25 * 60 * 60 * 1000);
  assert.equal(addCalendarDays('2026-12-31', 1), '2027-01-01');
  assert.equal(businessDayBounds('2100-12-31', 'Australia/Brisbane').end.toISOString(), '2100-12-31T14:00:00.000Z');
});
test('invalid dates, zones and nonexistent local times fail explicitly', () => {
  assert.throws(() => businessDayBounds('2026-02-30', 'Australia/Brisbane'));
  assert.throws(() => businessDayBounds('2026-11-16', 'Invalid/Zone'));
  assert.throws(() => localBusinessInstant('2026-03-08', 'America/New_York', 2, 30));
});
test('two-week fixtures are weekday 30-minute inventory with lunch excluded', () => {
  const slots = demoSlotTimes('2026-11-16');
  assert.equal(slots.length, 140);
  for (const slot of slots) {
    assert.equal(slot.endAt.getTime() - slot.startAt.getTime(), 1800000);
    assert.equal(slot.startAt.getTime() % 1800000, 0);
    const localHour = Number(new Intl.DateTimeFormat('en', { timeZone: 'Australia/Brisbane', hour: '2-digit', hourCycle: 'h23' }).format(slot.startAt));
    assert.ok(localHour >= 9 && localHour < 17 && localHour !== 12);
    const date = businessDate(slot.startAt, 'Australia/Brisbane');
    assert.ok(![0, 6].includes(new Date(date + 'T00:00:00Z').getUTCDay()));
  }
});

