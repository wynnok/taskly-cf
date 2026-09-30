import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cronMatches, localText, nextRun, occurrences, parseCron } from '../src/cron.js';

test('production reminder schedules execute at Shanghai times', () => {
  const expressions = [
    '0 10,21 1 7 *',
    '0 10,21 28 * *',
    '0 10,21 7,8 * *',
    '0 10,21 11,12 * *',
    '0 10,21 14,15 * *',
    '0 10,21 19,20 * *',
    '0 10,21 23,24 * *',
    '0 10,21 25,26 * *',
    '0 10,20 26,27 * *',
    '0 10,20 22,23 * *',
    '0 10 9 * *',
    '0 10,20 16 * *',
  ];
  for (const expression of expressions) {
    const next = nextRun(expression, Date.parse('2026-09-30T00:00:00Z'));
    assert.ok(next);
    assert.ok(cronMatches(expression, next));
    assert.match(localText(next), /(?:10|20|21):00:00$/);
    assert.ok(!cronMatches(expression, next + 60000));
  }
  assert.equal(
    localText(nextRun(expressions[0], Date.parse('2026-09-30T00:00:00Z'))),
    '2027-07-01 10:00:00',
  );
});
test('APScheduler weekday numbering and AND semantics are preserved', () => {
  assert.ok(cronMatches('0 9 * * 0', Date.parse('2026-09-28T01:00:00Z')));
  assert.ok(!cronMatches('0 9 * * 0', Date.parse('2026-09-27T01:00:00Z')));
  assert.ok(!cronMatches('0 9 1 * mon', Date.parse('2026-09-28T01:00:00Z')));
  assert.ok(cronMatches('0 9 28 * mon', Date.parse('2026-09-28T01:00:00Z')));
});
test('minute precision, leap dates, ranges, steps and invalid schedules', () => {
  assert.equal(parseCron('0 0 9 * * mon-fri').normalized, '0 9 * * mon-fri');
  assert.throws(() => parseCron('15 0 9 * * *'), /分钟/);
  for (const bad of [
    '* * *',
    '60 * * * *',
    '*/0 * * * *',
    '0 0 * * 7',
    '0 24 * * *',
    '1-0 * * * *',
    '*/x * * * *',
  ])
    assert.throws(() => parseCron(bad));
  assert.equal(
    localText(nextRun('0 9 29 2 *', Date.parse('2026-01-01T00:00:00Z'))),
    '2028-02-29 09:00:00',
  );
  assert.equal(nextRun('0 0 31 2 *'), null);
  assert.equal(
    localText(nextRun('0 9 last * *', Date.parse('2026-02-01T00:00:00Z'))),
    '2026-02-28 09:00:00',
  );
  assert.ok(cronMatches('*/15 9-10 * jan mon-fri', Date.parse('2026-01-05T01:30:00Z')));
});
test('DST skipped and repeated hours are expanded correctly', () => {
  const spring = occurrences(
    '30 2 * * *',
    Date.parse('2026-03-08T00:00:00Z'),
    Date.parse('2026-03-09T00:00:00Z'),
    'America/New_York',
  );
  assert.equal(spring.length, 0);
  const fall = occurrences(
    '30 1 * * *',
    Date.parse('2026-11-01T00:00:00Z'),
    Date.parse('2026-11-02T00:00:00Z'),
    'America/New_York',
  );
  assert.deepEqual(
    fall.map((t) => new Date(t).toISOString()),
    ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z'],
  );
});
