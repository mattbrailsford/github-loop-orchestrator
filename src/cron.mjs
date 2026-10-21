// Five-field cron, in UTC: minute hour day-of-month month day-of-week.
// Schedules are checked once an hour, so the minute must be 0; the other fields take
// numbers, *, lists (1,3), ranges (1-5), and steps (*/2, 8-18/2). Names like MON aren't supported.

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
];

function parseField(text, { name, min, max }) {
  const values = new Set();
  for (const part of text.split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`${name}: "${part}" isn't a number, *, a range, or a step; names like MON aren't supported`);
    let [lo, hi] = m[1] === '*' ? [min, max] : m[1].split('-').map(Number);
    if (hi === undefined) hi = m[2] ? max : lo;
    const step = m[2] ? Number(m[2]) : 1;
    if (lo < min || hi > max || lo > hi) throw new Error(`${name}: "${part}" is outside ${min}-${max}`);
    if (step < 1) throw new Error(`${name}: a step must be 1 or more`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, any: text === '*' };
}

export function parseCron(expr) {
  if (typeof expr !== 'string') throw new Error('must be text, like "0 7 * * 1-5"');
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`needs 5 fields (minute hour day month weekday), got ${parts.length}`);
  if (parts[0] !== '0') throw new Error('the minute must be 0: schedules are checked once an hour');
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (dow.values.has(7)) dow.values.add(0);
  return { minute, hour, dom, month, dow };
}

// Standard cron rule: when both day fields are restricted, either one matching is enough.
export function cronDue(expr, date) {
  const c = parseCron(expr);
  if (!c.hour.values.has(date.getUTCHours())) return false;
  if (!c.month.values.has(date.getUTCMonth() + 1)) return false;
  const domOk = c.dom.values.has(date.getUTCDate());
  const dowOk = c.dow.values.has(date.getUTCDay());
  if (c.dom.any && c.dow.any) return true;
  if (c.dom.any) return dowOk;
  if (c.dow.any) return domOk;
  return domOk || dowOk;
}
