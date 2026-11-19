import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scheduleRange } from './schedule-time.js';
import { ApiError } from './errors.js';

test('working windows use business timezone, actual DST day length and unique boundaries', () => {
  const brisbane = scheduleRange({ date: '2030-01-08', startMinute: 540, endMinute: 1020 }, 'Australia/Brisbane');
  assert.equal(brisbane.startAt.toISOString(), '2030-01-07T23:00:00.000Z'); assert.equal(+brisbane.endAt - +brisbane.startAt, 8 * 3600000);
  for (const [date, hours] of [['2030-03-10', 23], ['2030-11-03', 25]] as const) {
    const range = scheduleRange({ date, startMinute: 0, endMinute: 1440 }, 'America/New_York');
    assert.equal(+range.endAt - +range.startAt, hours * 3600000);
  }
  for (const [date, startMinute] of [['2030-03-10', 120], ['2030-11-03', 60]] as const) {
    assert.throws(() => scheduleRange({ date, startMinute, endMinute: 240 }, 'America/New_York'), (error: unknown) => error instanceof ApiError && error.code === 'LOCAL_TIME_AMBIGUOUS');
  }
  assert.throws(() => scheduleRange({ date: '2030-01-08', startMinute: 540, endMinute: 600 }, 'Asia/Kathmandu'), (error: unknown) => error instanceof ApiError && error.code === 'UNSUPPORTED_TIME_ALIGNMENT');
});
