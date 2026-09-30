// APScheduler compatibility: Monday=0 and all five fields must match (AND).
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const cache = new Map();
const formatters = new Map();

export function zonedParts(timestamp, timezone = 'Asia/Shanghai') {
  if (!formatters.has(timezone))
    formatters.set(
      timezone,
      new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }),
    );
  const parts = Object.fromEntries(
    formatters
      .get(timezone)
      .formatToParts(new Date(timestamp))
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  );
  parts.weekday = (new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay() + 6) % 7;
  return parts;
}

export function localText(timestamp = Date.now(), timezone = 'Asia/Shanghai') {
  const p = zonedParts(timestamp, timezone);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

function field(expression, min, max, names = []) {
  const values = new Set();
  const number = (text) => {
    const named = names.indexOf(text.toLowerCase());
    const n = named >= 0 ? named + min : /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isInteger(n) || n < min || n > max)
      throw new Error(`Cron 字段 ${expression} 超出 ${min}–${max}`);
    return n;
  };
  for (const item of expression.split(',')) {
    const pieces = item.split('/');
    if (pieces.length > 2) throw new Error('Cron 步长格式错误');
    const step =
      pieces.length === 2 && /^\d+$/.test(pieces[1])
        ? Number(pieces[1])
        : pieces.length === 1
          ? 1
          : 0;
    if (step < 1 || step > max - min + 1) throw new Error('Cron 步长超出范围');
    const range = pieces[0].split('-');
    if (range.length > 2) throw new Error('Cron 范围格式错误');
    const start = pieces[0] === '*' ? min : number(range[0]);
    const end =
      pieces[0] === '*' || (pieces.length === 2 && range.length === 1)
        ? max
        : range.length === 2
          ? number(range[1])
          : start;
    if (end < start) throw new Error('Cron 范围必须递增');
    for (let n = start; n <= end; n += step) values.add(n);
  }
  return values;
}

export function parseCron(expression) {
  if (typeof expression !== 'string' || expression.length > 200)
    throw new Error('Cron 必须是字符串');
  const key = expression.trim();
  if (cache.has(key)) return cache.get(key);
  const fields = key.split(/\s+/);
  if (fields.length === 6) {
    if (fields.shift() !== '0')
      throw new Error('Worker 最小精度为分钟，六段 Cron 的秒字段必须为 0');
  }
  if (fields.length !== 5) throw new Error('Cron 必须是五段，或秒字段为 0 的六段');
  const result = {
    minutes: field(fields[0], 0, 59),
    hours: field(fields[1], 0, 23),
    days: fields[2] === 'last' ? null : field(fields[2], 1, 31),
    months: field(fields[3], 1, 12, MONTHS),
    weekdays: field(fields[4], 0, 6, DAYS),
    normalized: fields.join(' '),
  };
  if (cache.size >= 500) cache.clear();
  cache.set(key, result);
  return result;
}

function matchesDay(cron, p) {
  const dayMatches = cron.days
    ? cron.days.has(p.day)
    : p.day === new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
  return dayMatches && cron.months.has(p.month) && cron.weekdays.has(p.weekday);
}

export function cronMatches(expression, timestamp, timezone = 'Asia/Shanghai') {
  const c = parseCron(expression),
    p = zonedParts(timestamp, timezone);
  return matchesDay(c, p) && c.hours.has(p.hour) && c.minutes.has(p.minute);
}

// Candidate expansion by day avoids scanning millions of minutes for annual tasks.
export function occurrences(expression, start, end, timezone = 'Asia/Shanghai', limit = 400) {
  const c = parseCron(expression),
    result = [];
  const first = zonedParts(start, timezone),
    last = zonedParts(end, timezone);
  const dayStart = Date.UTC(first.year, first.month - 1, first.day);
  const dayEnd = Date.UTC(last.year, last.month - 1, last.day);
  for (let day = dayStart; day <= dayEnd && result.length < limit; day += 86400000) {
    const d = new Date(day);
    const p = {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      weekday: (d.getUTCDay() + 6) % 7,
    };
    if (!matchesDay(c, p)) continue;
    // Offsets on both sides of a DST transition cover both instances of a repeated hour.
    const offsets = new Set(
      [-86400000, 0, 86400000].map((delta) => {
        const probe = day + 43200000 + delta,
          z = zonedParts(probe, timezone);
        return Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second) - probe;
      }),
    );
    const candidates = new Set();
    candidateLoop: for (const hour of [...c.hours].sort((a, b) => a - b))
      for (const minute of [...c.minutes].sort((a, b) => a - b))
        for (const offset of offsets) {
          const candidate = day + hour * 3600000 + minute * 60000 - offset;
          if (candidate < start || candidate > end) continue;
          const actual = zonedParts(candidate, timezone);
          if (
            actual.year === p.year &&
            actual.month === p.month &&
            actual.day === p.day &&
            actual.hour === hour &&
            actual.minute === minute
          ) {
            candidates.add(candidate);
            if (offsets.size === 1 && candidates.size >= limit - result.length) break candidateLoop;
          }
        }
    result.push(...[...candidates].sort((a, b) => a - b).slice(0, limit - result.length));
  }
  return result;
}

export function nextRun(expression, now = Date.now(), timezone = 'Asia/Shanghai') {
  return (
    occurrences(
      expression,
      Math.floor(now / 60000) * 60000 + 60000,
      now + 366 * 8 * 86400000,
      timezone,
      1,
    )[0] ?? null
  );
}
