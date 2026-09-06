const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "2026-06-30" -> "30 June 2026". Parsed by hand to avoid a timezone shift. */
export function formatPeriod(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

export function formatMiles(miles: number): string {
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} miles`;
}

export function formatWeeks(weeks: number): string {
  return `${weeks.toFixed(1)}`;
}

export function formatPercent(pct: number): string {
  return `${Math.round(pct)}%`;
}

export function formatCount(count: number): string {
  return count.toLocaleString('en-GB');
}
