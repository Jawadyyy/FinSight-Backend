/**
 * Date helpers for month-bounded queries.
 *
 * A month range must never be written as `${month}-31`: that is an impossible
 * date for every 30-day month and for February, and Postgres rejects it rather
 * than clamping. Comparing against the first day of the next month with "<"
 * needs no day count and is correct for every month, leap years included.
 */

/** "2026-09" -> "2026-10-01". */
export function firstOfNextMonth(month: string): string {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m, 1)).toISOString().slice(0, 10);
}

/** "2026-09" -> "2026-09-30", for display and for inclusive ranges. */
export function lastDayOfMonth(month: string): string {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10);
}
