import { firstOfNextMonth, lastDayOfMonth } from './month-range';

describe('month ranges', () => {
  it('ends 31-day months on the 31st', () => {
    expect(lastDayOfMonth('2026-08')).toBe('2026-08-31');
    expect(lastDayOfMonth('2026-07')).toBe('2026-07-31');
  });

  it('never produces an impossible date for a 30-day month', () => {
    // `${month}-31` here would be 2026-09-31, which Postgres rejects outright.
    expect(lastDayOfMonth('2026-09')).toBe('2026-09-30');
    expect(lastDayOfMonth('2026-04')).toBe('2026-04-30');
    expect(lastDayOfMonth('2026-06')).toBe('2026-06-30');
    expect(lastDayOfMonth('2026-11')).toBe('2026-11-30');
  });

  it('handles February in common and leap years', () => {
    expect(lastDayOfMonth('2026-02')).toBe('2026-02-28');
    expect(lastDayOfMonth('2028-02')).toBe('2028-02-29');
  });

  it('rolls over the year end', () => {
    expect(firstOfNextMonth('2026-12')).toBe('2027-01-01');
    expect(lastDayOfMonth('2026-12')).toBe('2026-12-31');
  });

  it('gives the first of the following month for any month', () => {
    expect(firstOfNextMonth('2026-09')).toBe('2026-10-01');
    expect(firstOfNextMonth('2026-02')).toBe('2026-03-01');
  });

  it('produces a valid date for every month of the year', () => {
    for (let m = 1; m <= 12; m++) {
      const month = `2026-${String(m).padStart(2, '0')}`;
      const last = lastDayOfMonth(month);
      // A date the JS parser round-trips is one Postgres will accept.
      expect(new Date(`${last}T00:00:00Z`).toISOString().slice(0, 10)).toBe(last);
      expect(firstOfNextMonth(month)).toMatch(/^\d{4}-\d{2}-01$/);
    }
  });
});
