import { CATEGORIES, type DataPoint } from './dataGenerator';

/**
 * Appends one new sample per category for the live stream (100ms tick).
 * Trims oldest points to stay within maxSize so memory stays bounded.
 */
export function appendStreamTick(data: DataPoint[], maxSize: number): DataPoint[] {
  if (data.length === 0) return data;

  const lastByCat: Partial<Record<string, DataPoint>> = {};
  for (let i = data.length - 1; i >= 0; i--) {
    const p = data[i];
    if (!lastByCat[p.category]) lastByCat[p.category] = p;
    if (Object.keys(lastByCat).length >= CATEGORIES.length) break;
  }

  const now = Date.now();
  const added: DataPoint[] = CATEGORIES.map((category) => {
    const last = lastByCat[category];
    const base = last?.value ?? 50;
    const value = Math.max(0, Math.min(100, base + (Math.random() - 0.5) * 3.5));
    return {
      timestamp: now,
      value: Number(value.toFixed(2)),
      category,
      volume: Math.round(
        category === 'Network'
          ? value * 8 + Math.random() * 200
          : category === 'Disk I/O'
            ? value * 6 + Math.random() * 150
            : 200 + Math.random() * 800
      ),
    };
  });

  const merged = data.length + added.length <= maxSize
    ? data.concat(added)
    : data.slice(data.length + added.length - maxSize).concat(added);

  return merged;
}

export type TimeRangeKey = 'all' | '5m' | '15m' | '1h' | '6h';

export const TIME_RANGE_MS: Record<Exclude<TimeRangeKey, 'all'>, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
};

/** Filters points to the selected trailing window of the dataset's max timestamp. */
export function filterByTimeRange(data: DataPoint[], range: TimeRangeKey): DataPoint[] {
  if (range === 'all' || data.length === 0) return data;
  let maxT = -Infinity;
  for (const p of data) {
    if (p.timestamp > maxT) maxT = p.timestamp;
  }
  const minT = maxT - TIME_RANGE_MS[range];
  return data.filter((p) => p.timestamp >= minT);
}
